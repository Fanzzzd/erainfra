package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"

	"github.com/Fanzzzd/erainfra/apps/infra-agent/internal/agent"
	"github.com/Fanzzzd/erainfra/apps/infra-agent/internal/convexnode"
	"github.com/Fanzzzd/erainfra/apps/infra-agent/internal/meshclient"
	"github.com/Fanzzzd/erainfra/apps/infra-agent/internal/rename"
)

func convexModeConflict(mode string) error {
	if mode == "connect" && (os.Getenv("ERAINFRA_NODE_CREDENTIAL_FILE") != "" || os.Getenv("ERAINFRA_NODE_STATE_DIR") != "") {
		return fmt.Errorf("hub and Convex modes are mutually exclusive")
	}
	return convexnode.ValidateMode(mode, rename.Env("ERAINFRA_HUB", "PORTLESS_HUB"), os.Getenv("ERAINFRA_CONVEX_SITE"), os.Getenv("ERAINFRA_NODE_CREDENTIAL"))
}
func runConnectConvex(ctx context.Context) error {
	if err := convexModeConflict("connect-convex"); err != nil {
		return err
	}
	fs := flag.NewFlagSet("connect-convex", flag.ContinueOnError)
	site := fs.String("site", os.Getenv("ERAINFRA_CONVEX_SITE"), "Convex HTTPS site origin (.convex.site), not the cloud RPC URL")
	credentialFile := fs.String("credential-file", os.Getenv("ERAINFRA_NODE_CREDENTIAL_FILE"), "0600 file containing the scoped Node credential")
	state := fs.String("state-dir", os.Getenv("ERAINFRA_NODE_STATE_DIR"), "absolute persistent private directory; never use a temp directory")
	docker := fs.String("docker", "docker", "container CLI")
	if err := fs.Parse(os.Args[2:]); err != nil {
		return err
	}
	credential := os.Getenv("ERAINFRA_NODE_CREDENTIAL")
	if *credentialFile != "" {
		if credential != "" {
			return fmt.Errorf("choose credential file or environment, not both")
		}
		info, err := os.Lstat(*credentialFile)
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() > 256 {
			return fmt.Errorf("credential file must be a private regular file (0600)")
		}
		b, err := os.ReadFile(*credentialFile)
		if err != nil {
			return err
		}
		credential = string(b)
	}
	// Do not accept the legacy ERAINFRA_TOKEN/PORTLESS_TOKEN here, even when its value looks valid.
	client, err := convexnode.New(convexnode.Config{URL: *site, Credential: trimCredential(credential), StateDir: *state, Version: version}, convexnode.LocalExecutor{Runner: agent.ShellRunner{
		Docker: *docker, OutputLimit: 16 * 1024,
		// In the state directory beside the journal (New refuses a relative or missing one), so an
		// adoption lasts as long as the Node's command history.
		VolumeOwners: filepath.Join(*state, "volume-owners"),
	}})
	if err != nil {
		return err
	}
	defer func() { _ = client.Close() }()
	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	mesh, err := convexMesh(ctx)
	if err != nil {
		return err
	}
	routesFile, err := gatewayRoutesFile()
	if err != nil {
		return err
	}
	if mesh != nil {
		defer func() { _ = mesh.Close() }()
		relays, err := meshRelayPolicy()
		if err != nil {
			return err
		}
		// An App link listens on the Docker bridge gateway, where its containers reach it.
		client.Mesh = &convexnode.MeshOptions{Sidecar: mesh, Relays: relays, Bridge: convexnode.DockerBridge{Docker: *docker}.Resolve, RoutesFile: routesFile}
	} else {
		slog.Info("connect-convex: no erainfra-mesh sidecar configured (ERAINFRA_MESH_SOCKET or ERAINFRA_MESH_BIN); this Node publishes no endpoint and runs no mesh links")
		if routesFile != "" {
			slog.Warn("connect-convex: ERAINFRA_GATEWAY_ROUTES_FILE is set, but a gateway reaches Apps only over the mesh, so no route table is written without a sidecar")
		}
	}
	err = client.Run(ctx)
	if ctx.Err() != nil {
		return nil
	}
	return err
}

// convexMesh opens the sidecar under the same controller locks Hub mode takes, so the two modes
// can never drive one sidecar at once. It returns nil when no sidecar is configured.
func convexMesh(ctx context.Context) (*agent.MeshManager, error) {
	if os.Getenv("ERAINFRA_MESH_SOCKET") == "" && os.Getenv("ERAINFRA_MESH_BIN") == "" {
		return nil, nil
	}
	if runtime.GOOS == "windows" {
		// A named pipe has no directory to lock, so the per-sidecar controller lock does not exist
		// there yet (meshclient.AcquireSocket).
		return nil, errors.New("connect-convex drives an erainfra-mesh sidecar only on Linux and macOS; unset ERAINFRA_MESH_SOCKET and ERAINFRA_MESH_BIN")
	}
	mesh, err := connectMesh(ctx, "convex")
	if err != nil {
		return nil, fmt.Errorf("secure mesh startup: %w", err)
	}
	return mesh, nil
}

// meshRelayPolicy reads the relay policy from the same variables the Hub reads it from. In
// connect-convex mode each Node holds its own: Convex stores no relay token. An entry is a URL or
// an object with a QUIC address discovery port (meshclient.Relay).
func meshRelayPolicy() (meshclient.Relays, error) {
	policy := meshclient.Relays{List: []meshclient.Relay{}, AuthToken: os.Getenv("ERAINFRA_MESH_RELAY_TOKEN")}
	if raw := os.Getenv("ERAINFRA_MESH_RELAYS"); raw != "" {
		list, err := meshclient.ParseRelays([]byte(raw), policy.AuthToken != "")
		if err != nil {
			return policy, fmt.Errorf("ERAINFRA_MESH_RELAYS %w", err)
		}
		policy.List = list
	}
	switch os.Getenv("ERAINFRA_MESH_N0_FALLBACK") {
	case "", "false":
	case "true":
		policy.N0Fallback = true
	default:
		return policy, errors.New("ERAINFRA_MESH_N0_FALLBACK must be true or false")
	}
	return policy, nil
}

const journalUsage = `usage: infra-agent journal list [--state-dir DIR]
       infra-agent journal release [--state-dir DIR] KEY...

list prints every command key the connect-convex journal holds, one JSON object per line. It
reads without the lock, so the Infra Agent may keep running.

release forgets the named keys after you have checked them. Stop the Infra Agent first: release
takes the journal's lock. A released key no longer protects its command from running again, so
release only keys whose command Convex shows finished or cancelled, or does not have at all, and
for an unknown outcome only after you have checked the workload on this Node. The agent forgets
keys of finished commands by itself; release is for a control plane that cannot answer for them.

Both read past a torn last record that power loss during an append left, as the agent does; see
docs/infra-management.md, "When the journal is damaged".`

// journalUsageError prints the usage text as the error, so a mistyped command shows it.
type journalUsageError struct{}

func (journalUsageError) Error() string { return journalUsage }

// runJournal is the operator's way out of a full journal (docs/infra-management.md, "When the
// journal is full").
func runJournal(args []string, out io.Writer) error {
	if len(args) == 0 || (args[0] != "list" && args[0] != "release") {
		return journalUsageError{}
	}
	fs := flag.NewFlagSet("journal "+args[0], flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	state := fs.String("state-dir", os.Getenv("ERAINFRA_NODE_STATE_DIR"), "the connect-convex state directory")
	if err := fs.Parse(args[1:]); err != nil {
		return fmt.Errorf("%v\n%w", err, journalUsageError{})
	}
	if *state == "" || !filepath.IsAbs(*state) {
		return errors.New("an absolute --state-dir (or ERAINFRA_NODE_STATE_DIR) is required")
	}
	switch args[0] {
	case "list":
		if fs.NArg() != 0 {
			return journalUsageError{}
		}
		entries, err := convexnode.ListJournal(*state)
		if err != nil {
			return err
		}
		enc := json.NewEncoder(out)
		for _, e := range entries {
			if err := enc.Encode(e); err != nil {
				return err
			}
		}
		return nil
	default:
		if fs.NArg() == 0 {
			return journalUsageError{}
		}
		if err := convexnode.ReleaseJournalKeys(*state, fs.Args()); err != nil {
			return err
		}
		_, err := fmt.Fprintf(out, "released %d keys\n", fs.NArg())
		return err
	}
}

func trimCredential(s string) string {
	for len(s) > 0 && (s[len(s)-1] == '\n' || s[len(s)-1] == '\r') {
		s = s[:len(s)-1]
	}
	return s
}
