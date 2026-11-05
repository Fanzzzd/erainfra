package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/Fanzzzd/erainfra/apps/infra-agent/internal/agent"
	"github.com/Fanzzzd/erainfra/apps/infra-agent/internal/rename"
)

// Stamped at build time with `-ldflags '-X main.version=<product version>'`. It has to be a var:
// `-X` silently does nothing to a const, so a const here would make every attempt to stamp the
// product version onto this binary a no-op that looks like it worked.
var version = "dev"

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	switch os.Args[1] {
	case "version":
		// The release workflow greps this exact line off the shipped bytes, which is what turns the
		// stamped version into an assertion about the artifact rather than about the build script.
		fmt.Printf("infra-agent %s\n", version)
	case "plan":
		runPlan()
	case "resources":
		writeJSON(agent.CollectResources())
	case "heartbeat":
		writeJSON(agent.BuildHeartbeat(hostname(), []agent.Role{agent.RoleWorker}, version))
	case "benchmark":
		if len(os.Args) < 3 {
			fmt.Fprintln(os.Stderr, "usage: portless-agent benchmark <host:port>")
			os.Exit(2)
		}
		writeJSON(agent.BenchmarkTCP(ctx, os.Args[2], 5, 2*time.Second))
	case "op":
		// Reads an Operation from stdin and prints the resolved allowlisted command.
		// Dry-run only: this never executes, and there is no raw-shell path.
		runOp()
	case "gateway":
		if err := runGateway(ctx, os.Args[2:]); err != nil && ctx.Err() == nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	case "connect-convex":
		if err := runConnectConvex(ctx); err != nil && ctx.Err() == nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	case "connect":
		if err := convexModeConflict("connect"); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		runConnect(ctx)
	default:
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: portless-agent <version|plan|resources|heartbeat|benchmark|op|connect|connect-convex|gateway>")
}

// connect dials the hub over WSS and serves its commands (deploy containers, exec). The agent dials
// OUT — no inbound port — so it works on a NAT'd box with no public IP.
func runConnect(ctx context.Context) {
	fs := flag.NewFlagSet("connect", flag.ExitOnError)
	// The systemd unit feeds these through /etc/portless/agent.env, so both names have to be
	// accepted here before any installer starts writing the new one into that file.
	hub := fs.String("hub", rename.Env("ERAINFRA_HUB", "PORTLESS_HUB"), "hub WSS url, e.g. wss://hub.example.com/agent")
	token := fs.String("token", rename.Env("ERAINFRA_TOKEN", "PORTLESS_TOKEN"), "auth token (Bearer)")
	name := fs.String("name", hostname(), "agent id reported to the hub")
	docker := fs.String("docker", "docker", "container CLI (docker or podman)")
	_ = fs.Parse(os.Args[2:])
	if *hub == "" {
		fmt.Fprintln(os.Stderr, "need --hub or ERAINFRA_HUB (PORTLESS_HUB also still works; e.g. wss://hub.example.com/agent)")
		os.Exit(2)
	}
	// One registry shared by the control runner (records app->port on deploy) and the data plane
	// (reads it to reverse-proxy <app>.<domain> → loopback). Data channel = control URL with /agent→/data.
	reg := agent.NewRegistry()
	dataURL := strings.TrimSuffix(*hub, "/agent") + "/data"
	mesh, err := connectMesh(ctx, "hub")
	if err != nil {
		fmt.Fprintf(os.Stderr, "secure mesh startup: %v\n", err)
		os.Exit(1)
	}
	defer func() { _ = mesh.Close() }()
	go agent.ConnectData(ctx, dataURL, *token, *name, reg)
	agent.Connect(ctx, *hub, *token, *name, version, []agent.Role{agent.RoleWorker}, agent.ShellRunner{Docker: *docker, Token: *token, Reg: reg, Mesh: mesh})
}

func runPlan() {
	var input agent.Enrollment
	if err := json.NewDecoder(os.Stdin).Decode(&input); err != nil {
		fmt.Fprintf(os.Stderr, "decode enrollment: %v\n", err)
		os.Exit(1)
	}
	plan, err := agent.BuildInstallPlan(input)
	if err != nil {
		fmt.Fprintf(os.Stderr, "build plan: %v\n", err)
		os.Exit(1)
	}
	writeJSON(plan)
}

func runOp() {
	var op agent.Operation
	if err := json.NewDecoder(os.Stdin).Decode(&op); err != nil {
		fmt.Fprintf(os.Stderr, "decode operation: %v\n", err)
		os.Exit(1)
	}
	cmd, err := agent.Resolve(op)
	if err != nil {
		fmt.Fprintf(os.Stderr, "rejected: %v\n", err)
		os.Exit(1)
	}
	writeJSON(cmd)
}

func writeJSON(v any) {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		fmt.Fprintf(os.Stderr, "encode: %v\n", err)
		os.Exit(1)
	}
}

func hostname() string {
	h, err := os.Hostname()
	if err != nil {
		return "unknown"
	}
	return h
}
