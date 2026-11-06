// Command erainfra-gocacheprog is a GOCACHEPROG program for cmd/go that keeps
// Go's build cache on local disk and shares it with later jobs of the same
// repository through EraInfra's cache service. A workflow opts in with one
// line:
//
//	env:
//	  GOCACHEPROG: erainfra-gocacheprog
//
// See apps/runtime/internal/gocacheprog for the protocol and the fail-open
// rules, and docs/runbooks/operate-the-job-cache.md for operating it.
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/gocacheprog"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	cfg, err := gocacheprog.ConfigFromEnv(os.Getenv)
	if err != nil {
		fmt.Fprintf(os.Stderr, "erainfra-gocacheprog: %v\n", err)
		os.Exit(1)
	}
	cfg.Stderr = os.Stderr
	if err := gocacheprog.Run(ctx, cfg, os.Stdin, os.Stdout); err != nil {
		fmt.Fprintf(os.Stderr, "erainfra-gocacheprog: %v\n", err)
		os.Exit(1)
	}
}
