package main

import (
	"encoding/json"
	"fmt"
	"os"
	"time"

	"portless-agent/internal/agent"
)

const version = "0.1.0"

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}

	switch os.Args[1] {
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
		writeJSON(agent.BenchmarkTCP(os.Args[2], 5, 2*time.Second))
	case "op":
		// Reads an Operation from stdin and prints the resolved allowlisted command.
		// Dry-run only: this never executes, and there is no raw-shell path.
		runOp()
	default:
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: portless-agent <plan|resources|heartbeat|benchmark|op>")
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
