package agent

import (
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// The node-agent NEVER runs arbitrary shell. It only resolves a fixed allowlist of
// operations into explicit argv (never a shell string), and only for Portless-owned
// units. Unknown operations and unsafe arguments are rejected.

var ErrNotAllowed = errors.New("operation not allowed")

// Command is a resolved, ready-to-exec argv. There is no shell involved.
type Command struct {
	Path        string
	Argv        []string
	Description string
}

// Operation is what a caller asks the agent to do.
type Operation struct {
	Name string            `json:"name"`
	Args map[string]string `json:"args"`
}

// Both brand prefixes, and this one has to widen a release EARLY rather than late (ADR 0004
// stage 1). Every other entry in this migration is a reader catching up with a writer; this is the
// reverse. The allowlist runs on the NODE, inside a binary a customer installed months ago, while
// the thing that names a unit is the HUB. If the Hub started issuing `erainfra-*` unit names first,
// every Node still running today's agent would refuse them with "operation not allowed" — the
// mirror image of the 404 that CONTEXT.md rule 4 exists to prevent. So the accepting side ships
// first and waits, exactly as the Hub serves /agent-bin under both names before any installer asks.
//
// The widening is over an empty namespace: nothing in this repository writes an `erainfra-*` unit
// today, so no operation that is refused now is permitted by this change.
var portlessUnit = regexp.MustCompile(`^(portless|erainfra)-[a-z0-9-]+(\.service)?$`)
var portlessContainer = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]{0,126}$`)
var portlessNetwork = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}-net$`)

// IsPortlessUnit gates systemd actions to units this platform manages, under either brand prefix.
func IsPortlessUnit(name string) bool { return portlessUnit.MatchString(name) }

var unsafeArg = regexp.MustCompile(`[;&|<>$` + "`" + `\n\r\\]`)

func safeArg(v string) bool { return v != "" && !unsafeArg.MatchString(v) }

type builder func(args map[string]string) (Command, error)

var allowlist = map[string]builder{
	"systemctl.restart": systemctlBuilder("restart", "Restart a Portless-owned systemd unit"),
	"systemctl.start":   systemctlBuilder("start", "Start a Portless-owned systemd unit"),
	"systemctl.stop":    systemctlBuilder("stop", "Stop a Portless-owned systemd unit"),
	"systemctl.status":  systemctlBuilder("status", "Show status of a Portless-owned systemd unit"),
	"service.logs": func(args map[string]string) (Command, error) {
		if err := onlyArgs(args, "unit", "lines"); err != nil {
			return Command{}, err
		}
		unit := args["unit"]
		if !IsPortlessUnit(unit) {
			return Command{}, fmt.Errorf("%w: logs restricted to portless-* units, got %q", ErrNotAllowed, unit)
		}
		lines := 200
		if raw, ok := args["lines"]; ok {
			n, err := strconv.Atoi(raw)
			if err != nil || n <= 0 || n > 10000 {
				return Command{}, fmt.Errorf("%w: invalid lines=%q", ErrNotAllowed, raw)
			}
			lines = n
		}
		return Command{
			Path:        "journalctl",
			Argv:        []string{"journalctl", "-u", unit, "-n", strconv.Itoa(lines), "--no-pager"},
			Description: "Tail logs for a Portless-owned unit",
		}, nil
	},
	"disk.usage": func(args map[string]string) (Command, error) {
		if err := onlyArgs(args); err != nil {
			return Command{}, err
		}
		return Command{Path: "df", Argv: []string{"df", "-h"}, Description: "Report disk usage"}, nil
	},
	"system.hostname": func(args map[string]string) (Command, error) {
		if err := onlyArgs(args); err != nil {
			return Command{}, err
		}
		return Command{Path: "hostname", Argv: []string{"hostname"}, Description: "Report the node hostname"}, nil
	},
	"container.logs": func(args map[string]string) (Command, error) {
		if err := onlyArgs(args, "name", "lines"); err != nil {
			return Command{}, err
		}
		name := args["name"]
		if !portlessContainer.MatchString(name) {
			return Command{}, fmt.Errorf("%w: invalid container name %q", ErrNotAllowed, name)
		}
		lines := 100
		if raw, ok := args["lines"]; ok {
			n, err := strconv.Atoi(raw)
			if err != nil || n <= 0 || n > 1000 {
				return Command{}, fmt.Errorf("%w: invalid lines=%q", ErrNotAllowed, raw)
			}
			lines = n
		}
		return Command{Path: "docker", Argv: []string{"docker", "logs", "--tail", strconv.Itoa(lines), name}, Description: "Tail logs for a Portless container"}, nil
	},
	"container.remove": func(args map[string]string) (Command, error) {
		if err := onlyArgs(args, "name"); err != nil {
			return Command{}, err
		}
		name := args["name"]
		if !portlessContainer.MatchString(name) {
			return Command{}, fmt.Errorf("%w: invalid container name %q", ErrNotAllowed, name)
		}
		return Command{Path: "docker", Argv: []string{"docker", "rm", "-f", name}, Description: "Remove a Portless container"}, nil
	},
	"container.network.remove": func(args map[string]string) (Command, error) {
		if err := onlyArgs(args, "name"); err != nil {
			return Command{}, err
		}
		name := args["name"]
		if !portlessNetwork.MatchString(name) {
			return Command{}, fmt.Errorf("%w: invalid Portless network name %q", ErrNotAllowed, name)
		}
		return Command{Path: "docker", Argv: []string{"docker", "network", "rm", name}, Description: "Remove a Portless app network"}, nil
	},
}

func systemctlBuilder(action, desc string) builder {
	return func(args map[string]string) (Command, error) {
		if err := onlyArgs(args, "unit"); err != nil {
			return Command{}, err
		}
		unit := args["unit"]
		if !IsPortlessUnit(unit) {
			// Names both managed prefixes: the matcher accepts erainfra-* now, and a diagnostic that
			// names only the retired one sends the reader looking for a bug that is not there.
			return Command{}, fmt.Errorf("%w: systemctl %s restricted to portless-* or erainfra-* units, got %q", ErrNotAllowed, action, unit)
		}
		return Command{Path: "systemctl", Argv: []string{"systemctl", action, unit}, Description: desc}, nil
	}
}

func onlyArgs(args map[string]string, allowed ...string) error {
	want := make(map[string]struct{}, len(allowed))
	for _, name := range allowed {
		want[name] = struct{}{}
	}
	for name := range args {
		if _, ok := want[name]; !ok {
			return fmt.Errorf("%w: unexpected argument %q", ErrNotAllowed, name)
		}
	}
	return nil
}

// Resolve turns an operation into a concrete command, or rejects it. This is the only
// path to a side-effecting command; there is no passthrough for raw shell.
func Resolve(op Operation) (Command, error) {
	build, ok := allowlist[op.Name]
	if !ok {
		return Command{}, fmt.Errorf("%w: %q (allowed: %s)", ErrNotAllowed, op.Name, strings.Join(AllowedOperations(), ", "))
	}
	for k, v := range op.Args {
		if !safeArg(v) {
			return Command{}, fmt.Errorf("%w: unsafe argument %s=%q", ErrNotAllowed, k, v)
		}
	}
	return build(op.Args)
}

func AllowedOperations() []string {
	names := make([]string, 0, len(allowlist))
	for k := range allowlist {
		names = append(names, k)
	}
	return names
}
