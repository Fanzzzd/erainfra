package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
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
	client, err := convexnode.New(convexnode.Config{URL: *site, Credential: trimCredential(credential), StateDir: *state, Version: version}, convexnode.LocalExecutor{Runner: agent.ShellRunner{Docker: *docker, OutputLimit: 16 * 1024}})
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
		log.Printf("connect-convex: no erainfra-mesh sidecar configured (ERAINFRA_MESH_SOCKET or ERAINFRA_MESH_BIN); this Node publishes no endpoint and runs no mesh links")
		if routesFile != "" {
			log.Printf("connect-convex: ERAINFRA_GATEWAY_ROUTES_FILE is set, but a gateway reaches Apps only over the mesh, so no route table is written without a sidecar")
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
// connect-convex mode each Node holds its own: Convex stores no relay token.
func meshRelayPolicy() (meshclient.Relays, error) {
	policy := meshclient.Relays{URLs: []string{}}
	if raw := os.Getenv("ERAINFRA_MESH_RELAYS"); raw != "" {
		if err := json.Unmarshal([]byte(raw), &policy.URLs); err != nil || policy.URLs == nil {
			return policy, errors.New("ERAINFRA_MESH_RELAYS must be a JSON URL array")
		}
	}
	switch os.Getenv("ERAINFRA_MESH_N0_FALLBACK") {
	case "", "false":
	case "true":
		policy.N0Fallback = true
	default:
		return policy, errors.New("ERAINFRA_MESH_N0_FALLBACK must be true or false")
	}
	policy.AuthToken = os.Getenv("ERAINFRA_MESH_RELAY_TOKEN")
	return policy, nil
}

func trimCredential(s string) string {
	for len(s) > 0 && (s[len(s)-1] == '\n' || s[len(s)-1] == '\r') {
		s = s[:len(s)-1]
	}
	return s
}
