package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
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
	Name   string `json:"Name"` // "/<name>"
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
// Hub gave it (hubShaped). Anything else is refused with instructions, never removed.
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
	if hubShaped(name, info, app, service == "") {
		return nil
	}
	return fmt.Errorf("container %s has no %s label and is not shaped like %s's, so it may be another App's; "+
		"refusing to replace it. If it is %s's, remove it on this Node (docker rm -f %s) and deploy again "+
		"(docs/infra-management.md, \"Names and ownership\")", name, LabelApp, describeOwner(app, service), app, name)
}

// hubShaped reports whether an unlabelled container named `name` has the shape the Hub gave one of
// App app's containers: a service container when `single` is false, the single container when it
// is true. A service container `<app>-<service>` sits on `<app>-net` under the service's name as its
// alias, and `<app>-net` is a different name for every App, so no other App's container matches. A
// single-container App's container is named after the App and sits on Docker's default network
// only (the Hub's Docker args cannot name a network).
func hubShaped(name string, info containerInfo, app string, single bool) bool {
	networks := info.NetworkSettings.Networks
	if single {
		_, ok := networks["bridge"]
		return name == app && ok && len(networks) == 1
	}
	service, ok := strings.CutPrefix(name, app+"-")
	if !ok {
		return false
	}
	net, ok := networks[app+"-net"]
	return ok && slices.Contains(net.Aliases, service)
}

// ownVolumes creates each named volume the args mount, labelled for the App, or checks that an
// existing one is this App's to mount. Every volume is checked before any is created or adopted, so
// a refusal leaves the Node as it was.
//
// A labelled volume must be labelled for this App. A volume without the label predates it: the Hub
// created it, and nothing on the volume says for which App, so its users decide (ownUnlabelledVolume).
// One this App may mount is adopted: Docker cannot add a label to an existing volume, so the adoption
// is recorded on this Node instead (VolumeOwners), and from then on the record refuses every other
// App exactly as a label would, even after this App's containers are gone.
//
// `single` is true for the Hub's single-container deploy (Deploy) and false for an App's services
// (DeployApp).
func (r ShellRunner) ownVolumes(ctx context.Context, app string, single bool, args []string) error {
	var create, adopt []string
	for _, name := range mountedVolumes(args) {
		if slices.Contains(create, name) || slices.Contains(adopt, name) {
			continue
		}
		var info volumeInfo
		found, err := r.inspect(ctx, "volume", name, &info)
		if err != nil {
			return err
		}
		if !found {
			create = append(create, name)
			continue
		}
		if owner, ok := info.Labels[LabelApp]; ok {
			if owner != app {
				return fmt.Errorf("volume %s belongs to App %q, not App %q; refusing to mount it", name, owner, app)
			}
			continue
		}
		if err := r.ownUnlabelledVolume(ctx, name, app, single); err != nil {
			return err
		}
		adopt = append(adopt, name)
	}
	for _, name := range create {
		if out, err := r.combinedOutput(exec.CommandContext(ctx, r.cli(), "volume", "create", "--label", LabelApp+"="+app, name)); err != nil {
			return fmt.Errorf("volume %s: %w: %s", name, err, strings.TrimSpace(string(out)))
		}
	}
	for _, name := range adopt {
		if err := r.recordVolumeOwner(name, app); err != nil {
			return err
		}
	}
	return nil
}

// ownUnlabelledVolume refuses a Hub-era volume another App uses. A Hub single-container App
// mounts any `-v name:/path` its operator typed, and the Hub stored none of those args, so no
// control plane knows the name: App `postgres` with volume `data` derives `postgres-data`, which
// the Hub App `db` may already keep its database in. The truth is on this Node: the containers
// that mount the volume. The volume is this App's to mount only when every one of them, running or
// stopped, passes the ownership test a container of this App passes (its label, or the shape the
// Hub gave the App's containers). A volume no container mounts is adopted by the first App to
// mount it; the recorded adoption, when there is one, wins over that.
//
// The test is also held to this deploy's kind. The App's services may share a volume, and a
// redeploy replaces its own container, but the Hub's single container `db` and App db's services
// are not each other's replacements: deploying the services while the single container still runs
// would put two databases on one data directory, the same harm with one App name.
func (r ShellRunner) ownUnlabelledVolume(ctx context.Context, name, app string, single bool) error {
	owner, recorded, err := r.recordedVolumeOwner(name)
	if err != nil {
		return err
	}
	if recorded && owner != app {
		return fmt.Errorf("volume %s was adopted by App %q on this Node, not App %q; refusing to mount it "+
			"(docs/infra-management.md, \"Names and ownership\")", name, owner, app)
	}
	ids, err := r.volumeUsers(ctx, name)
	if err != nil {
		return err
	}
	for _, id := range ids {
		var info containerInfo
		found, err := r.inspect(ctx, "container", id, &info)
		if err != nil {
			return err
		}
		if !found {
			continue // removed since it was listed
		}
		container := strings.TrimPrefix(info.Name, "/")
		if container == "" {
			container = id
		}
		label, labelled := info.Config.Labels[LabelApp]
		if labelled && label != app {
			return fmt.Errorf("volume %s is mounted by container %s of App %q; refusing to mount it for App %q", name, container, label, app)
		}
		var sameKind, otherKind bool
		if labelled {
			sameKind = (info.Config.Labels[LabelService] == "") == single
			otherKind = !sameKind
		} else {
			sameKind = hubShaped(container, info, app, single)
			otherKind = !sameKind && hubShaped(container, info, app, !single)
		}
		switch {
		case sameKind:
			continue
		case otherKind:
			kind := "service container"
			if !single {
				kind = "single-container deployment"
			}
			return fmt.Errorf("volume %s is mounted by container %s, App %q's %s, which this deploy does not replace; "+
				"refusing to mount it, since two containers would write one data directory. Once nothing needs %s, "+
				"remove it on this Node (docker rm -f %s) and deploy again", name, container, app, kind, container, container)
		default:
			return fmt.Errorf("volume %s has no %s label and is mounted by container %s, which is not App %q's; "+
				"refusing to mount it, since two Apps would share one data directory. Give App %q's volume another "+
				"name, or move the data (docs/infra-management.md, \"Names and ownership\")",
				name, LabelApp, container, app, app)
		}
	}
	return nil
}

// volumeUsers lists the IDs of every container, running or stopped, that mounts the volume. The
// `volume` filter matches a mount's volume name or its destination path exactly, and a volume name
// never starts with "/".
func (r ShellRunner) volumeUsers(ctx context.Context, name string) ([]string, error) {
	var stdout, stderr bytes.Buffer
	cmd := exec.CommandContext(ctx, r.cli(), "ps", "-a", "--no-trunc", "--filter", "volume="+name, "--format", "{{.ID}}")
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("list containers mounting volume %s: %w: %s", name, err, strings.TrimSpace(stderr.String()))
	}
	return strings.Fields(stdout.String()), nil
}

// VolumeOwners holds one file per adopted volume, named after it, holding the adopting App's name.
// A file per volume, created with link(2), makes the first adoption win without a lock. Validated
// volume names (dockerargs.go) start with a letter or digit and contain no "/", so each is a plain
// file name in the directory.
func (r ShellRunner) recordedVolumeOwner(name string) (string, bool, error) {
	if r.VolumeOwners == "" {
		return "", false, nil
	}
	raw, err := os.ReadFile(filepath.Join(r.VolumeOwners, name))
	if errors.Is(err, fs.ErrNotExist) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("read the recorded owner of volume %s: %w", name, err)
	}
	return strings.TrimSpace(string(raw)), true, nil
}

func (r ShellRunner) recordVolumeOwner(name, app string) error {
	if r.VolumeOwners == "" {
		return nil
	}
	if owner, recorded, err := r.recordedVolumeOwner(name); err != nil || recorded {
		if err == nil && owner != app {
			err = fmt.Errorf("volume %s was adopted by App %q on this Node, not App %q; refusing to mount it", name, owner, app)
		}
		return err
	}
	if err := os.MkdirAll(r.VolumeOwners, 0o700); err != nil {
		return fmt.Errorf("record the owner of volume %s: %w", name, err)
	}
	tmp, err := os.CreateTemp(r.VolumeOwners, ".adopting-*")
	if err != nil {
		return fmt.Errorf("record the owner of volume %s: %w", name, err)
	}
	defer func() { _ = os.Remove(tmp.Name()) }()
	_, err = tmp.WriteString(app + "\n")
	if err == nil {
		err = tmp.Sync()
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Link(tmp.Name(), filepath.Join(r.VolumeOwners, name))
	}
	if errors.Is(err, fs.ErrExist) {
		return r.recordVolumeOwner(name, app) // another deploy adopted it first: compare with that
	}
	if err != nil {
		return fmt.Errorf("record the owner of volume %s: %w", name, err)
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
