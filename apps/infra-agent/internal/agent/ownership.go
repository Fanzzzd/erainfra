package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"slices"
	"strings"
)

// Container and volume names are joins: `<app>-<service>` and `<app>-<volume>`. App, service and
// volume names may all contain `-`, so two Apps can derive one name (App `shop` service `web-api`
// and App `shop-web` service `api` are both `shop-web-api`). Convex refuses a plan that derives a
// name another App holds, but this Node is the last place that can tell, and `docker rm -f` on the
// wrong name destroys another App's container. So every container and named volume the Infra Agent
// creates for an App carries labels naming its App (and service), and before it replaces a
// container or mounts a volume it checks that the one already there is this App's.
//
// The names themselves stay as they are: deployed Nodes hold them (CONTEXT.md, rule 4).
const (
	LabelApp     = "erainfra.app"
	LabelService = "erainfra.service"
)

type containerInfo struct {
	Config struct {
		Labels map[string]string `json:"Labels"`
	} `json:"Config"`
	NetworkSettings struct {
		Networks map[string]struct {
			Aliases []string `json:"Aliases"`
		} `json:"Networks"`
	} `json:"NetworkSettings"`
}

type volumeInfo struct {
	Labels map[string]string `json:"Labels"`
}

// inspect runs `docker <kind> inspect <name>` and decodes its single result into out. It reports
// found=false only when Docker says the object does not exist; any other failure is an error, so a
// daemon hiccup never reads as "nothing there to protect".
func (r ShellRunner) inspect(ctx context.Context, kind, name string, out any) (bool, error) {
	var stdout, stderr bytes.Buffer
	cmd := exec.CommandContext(ctx, r.cli(), kind, "inspect", name)
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		if strings.Contains(strings.ToLower(stderr.String()+stdout.String()), "no such") {
			return false, nil
		}
		return false, fmt.Errorf("inspect %s %s: %w", kind, name, err)
	}
	var results []json.RawMessage
	if err := json.Unmarshal(stdout.Bytes(), &results); err != nil || len(results) != 1 {
		return false, fmt.Errorf("inspect %s %s: unreadable output", kind, name)
	}
	if err := json.Unmarshal(results[0], out); err != nil {
		return false, fmt.Errorf("inspect %s %s: %w", kind, name, err)
	}
	return true, nil
}

// ownContainer refuses unless the container `name`, if there is one, was created for this App's
// service (`service` is empty for a single-container App the Hub deploys by name).
//
// A labelled container must carry exactly this App and service. A container without the labels
// predates them; it was created by the Hub, and it is this App's only when it carries the shape the
// Hub gave it. A service container sits on `<app>-net` under the service's name as its alias, and
// `<app>-net` is a different name for every App, so no other App's container matches. A
// single-container App's container sits on Docker's default network only. Anything else is refused
// with instructions, never removed.
func (r ShellRunner) ownContainer(ctx context.Context, name, app, service string) error {
	var info containerInfo
	found, err := r.inspect(ctx, "container", name, &info)
	if err != nil || !found {
		return err
	}
	if owner, ok := info.Config.Labels[LabelApp]; ok {
		if owner == app && info.Config.Labels[LabelService] == service {
			return nil
		}
		return fmt.Errorf("container %s belongs to %s, not %s; refusing to replace it", name,
			describeOwner(owner, info.Config.Labels[LabelService]), describeOwner(app, service))
	}
	networks := info.NetworkSettings.Networks
	if service != "" {
		if net, ok := networks[app+"-net"]; ok && slices.Contains(net.Aliases, service) {
			return nil
		}
	} else if _, ok := networks["bridge"]; ok && len(networks) == 1 {
		return nil
	}
	return fmt.Errorf("container %s has no %s label and is not shaped like %s's, so it may be another App's; "+
		"refusing to replace it. If it is %s's, remove it on this Node (docker rm -f %s) and deploy again "+
		"(docs/infra-management.md, \"Names and ownership\")", name, LabelApp, describeOwner(app, service), app, name)
}

// ownVolumes creates each named volume the args mount, labelled for the App, or checks that an
// existing one is not labelled for another App. An existing volume without the label predates it
// and is accepted: no shape tells a Hub-era volume's App, and refusing would stop every stateful
// App from redeploying. Convex's name check is what keeps another App from deriving its name.
func (r ShellRunner) ownVolumes(ctx context.Context, app string, args []string) error {
	for _, name := range mountedVolumes(args) {
		var info volumeInfo
		found, err := r.inspect(ctx, "volume", name, &info)
		if err != nil {
			return err
		}
		if !found {
			if out, err := r.combinedOutput(exec.CommandContext(ctx, r.cli(), "volume", "create", "--label", LabelApp+"="+app, name)); err != nil {
				return fmt.Errorf("volume %s: %w: %s", name, err, strings.TrimSpace(string(out)))
			}
			continue
		}
		if owner, ok := info.Labels[LabelApp]; ok && owner != app {
			return fmt.Errorf("volume %s belongs to App %q, not App %q; refusing to mount it", name, owner, app)
		}
	}
	return nil
}

func describeOwner(app, service string) string {
	if service == "" {
		return fmt.Sprintf("App %q", app)
	}
	return fmt.Sprintf("service %q of App %q", service, app)
}

// mountedVolumes lists the named volumes in validated docker args (`-v name:/path[:ro]`).
func mountedVolumes(args []string) []string {
	var names []string
	for i := 0; i < len(args); i++ {
		value, ok := "", false
		switch {
		case args[i] == "-v" || args[i] == "--volume":
			if i+1 < len(args) {
				i++
				value, ok = args[i], true
			}
		case strings.HasPrefix(args[i], "-v="):
			value, ok = strings.TrimPrefix(args[i], "-v="), true
		case strings.HasPrefix(args[i], "--volume="):
			value, ok = strings.TrimPrefix(args[i], "--volume="), true
		}
		if ok {
			names = append(names, strings.SplitN(value, ":", 2)[0])
		}
	}
	return names
}

// ownershipLabels are the `docker run` flags that record a container's App and service.
func ownershipLabels(app, service string) []string {
	labels := []string{"--label", LabelApp + "=" + app}
	if service != "" {
		labels = append(labels, "--label", LabelService+"="+service)
	}
	return labels
}
