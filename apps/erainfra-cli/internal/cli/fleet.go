package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
)

type profileRow struct {
	Name         string         `json:"name"`
	State        string         `json:"state"`
	Executor     string         `json:"executor"`
	Boundary     string         `json:"boundary"`
	Vcpus        int64          `json:"vcpus"`
	MemoryMiB    int64          `json:"memoryMiB"`
	ReadyWorkers int64          `json:"readyWorkers"`
	ReadySlots   int64          `json:"readySlots"`
	FreeSlots    int64          `json:"freeSlots"`
	Readiness    map[string]int `json:"readiness"`
}

var profilesListCommand = command{
	path:    "profiles list",
	summary: "List Profiles with readiness counts",
	long: `
READY counts Workers that can take a job now: ready, admitted, online, and the
Profile active. NOT READY counts the other Workers that reported for the
Profile, by state. SLOTS is free/total across the ready Workers.`,
	run: func(ctx context.Context, a *App, in invocation) error {
		c, _, err := a.connect()
		if err != nil {
			return err
		}
		body, err := c.do(ctx, http.MethodGet, "/profiles", nil)
		if err != nil {
			return err
		}
		if in.format == formatJSON {
			return writeRawJSON(a.Stdout, body)
		}
		var page struct {
			Profiles []profileRow `json:"profiles"`
		}
		if err := decode(body, &page); err != nil {
			return err
		}
		if len(page.Profiles) == 0 {
			_, err := fmt.Fprintln(a.Stderr, "No Profiles are registered. A controller registers its Profile when it starts.")
			return err
		}
		tw := newTable(a.Stdout)
		row(tw, "NAME", "STATE", "EXECUTOR", "SIZE", "READY", "SLOTS", "NOT READY")
		for _, p := range page.Profiles {
			row(tw, p.Name, p.State, p.Executor,
				fmt.Sprintf("%d vCPU / %s", p.Vcpus, memory(p.MemoryMiB)),
				fmt.Sprintf("%d", p.ReadyWorkers),
				fmt.Sprintf("%d/%d", p.FreeSlots, p.ReadySlots),
				notReady(p.Readiness))
		}
		return tw.Flush()
	},
}

func notReady(counts map[string]int) string {
	var parts []string
	for _, state := range []string{"preparing", "degraded", "failed"} {
		if counts[state] > 0 {
			parts = append(parts, fmt.Sprintf("%s %d", state, counts[state]))
		}
	}
	if len(parts) == 0 {
		return "-"
	}
	return strings.Join(parts, ", ")
}

type workerRow struct {
	Name            string  `json:"name"`
	OS              string  `json:"os"`
	Arch            *string `json:"arch"`
	Online          bool    `json:"online"`
	LastHeartbeatAt *string `json:"lastHeartbeatAt"`
	Slots           struct {
		Max  int64 `json:"max"`
		Used int64 `json:"used"`
	} `json:"slots"`
	Readiness []struct {
		Profile string `json:"profile"`
		State   string `json:"state"`
	} `json:"readiness"`
}

var workersListCommand = command{
	path:    "workers list",
	summary: "List Workers with slots, readiness per Profile and last heartbeat",
	long: `
A Worker is online when it heartbeated within the last two minutes. PROFILES
lists each Profile the Worker reported readiness for, with that state. The
control plane does not record the Agent version a Worker runs; read it on the
Worker with ` + "`rc status`" + `.`,
	run: func(ctx context.Context, a *App, in invocation) error {
		c, _, err := a.connect()
		if err != nil {
			return err
		}
		body, err := c.do(ctx, http.MethodGet, "/workers", nil)
		if err != nil {
			return err
		}
		if in.format == formatJSON {
			return writeRawJSON(a.Stdout, body)
		}
		var page struct {
			Workers []workerRow `json:"workers"`
		}
		if err := decode(body, &page); err != nil {
			return err
		}
		if len(page.Workers) == 0 {
			_, err := fmt.Fprintln(a.Stderr, "No Workers are registered. Add one with `erainfra workers add`.")
			return err
		}
		now := a.Now()
		tw := newTable(a.Stdout)
		row(tw, "NAME", "STATUS", "HEARTBEAT", "PLATFORM", "SLOTS", "PROFILES")
		for _, w := range page.Workers {
			status := "offline"
			if w.Online {
				status = "online"
			}
			profiles := make([]string, 0, len(w.Readiness))
			for _, r := range w.Readiness {
				profiles = append(profiles, r.Profile+"="+r.State)
			}
			sort.Strings(profiles)
			platform := w.OS
			if w.Arch != nil {
				platform += "/" + *w.Arch
			}
			list := strings.Join(profiles, ", ")
			if list == "" {
				list = "-"
			}
			row(tw, w.Name, status, ago(w.LastHeartbeatAt, now), platform,
				fmt.Sprintf("%d/%d", w.Slots.Used, w.Slots.Max), list)
		}
		return tw.Flush()
	},
}

var workersAddCommand = command{
	path:    "workers add",
	summary: "Mint a Worker registration token and print the install command (admin token)",
	long: `
The same action as Add Worker in the dashboard. The registration token is
single-use and expires in fifteen minutes. Run the printed command on the new
machine.`,
	flags: []flagSpec{
		{name: "os", metavar: "posix|windows", usage: "which installer command to print (default posix)"},
	},
	run: func(ctx context.Context, a *App, in invocation) error {
		target, _ := in.value("os")
		if target == "" {
			target = "posix"
		}
		if target != "posix" && target != "windows" {
			return usagef("--os must be posix or windows, not %q", target)
		}
		c, _, err := a.connect()
		if err != nil {
			return err
		}
		body, err := c.do(ctx, http.MethodPost, "/workers/registration-tokens", nil)
		if err != nil {
			return err
		}
		if in.format == formatJSON {
			return writeRawJSON(a.Stdout, body)
		}
		var minted struct {
			ExpiresAt       string            `json:"expiresAt"`
			InstallCommands map[string]string `json:"installCommands"`
		}
		if err := json.Unmarshal(body, &minted); err != nil {
			return err
		}
		_, _ = fmt.Fprintf(a.Stderr, "Run this on the new machine before %s:\n", minted.ExpiresAt)
		_, err = fmt.Fprintln(a.Stdout, minted.InstallCommands[target])
		return err
	},
}
