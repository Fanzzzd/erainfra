// Command erainfra is the operator CLI for an EraInfra fleet. It reads
// Profiles, Workers and jobs through the control plane's operator API, the way
// the Blacksmith CLI and actuated-cli read theirs.
//
// It is a Go binary rather than a Node script so an operator installs one file
// with no runtime: the release publishes it for Linux, macOS and Windows next
// to the controller, and `go install` builds it from source.
package main

import (
	"context"
	"os"
	"os/signal"

	"github.com/Fanzzzd/erainfra/apps/erainfra-cli/internal/cli"
)

// version is stamped at build time with `-ldflags '-X main.version=<product version>'`.
var version = "dev"

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	code := cli.NewApp(version, os.Stdin, os.Stdout, os.Stderr, os.Getenv).Run(ctx, os.Args[1:])
	stop()
	os.Exit(code)
}
