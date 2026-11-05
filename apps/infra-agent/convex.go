package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/Fanzzzd/erainfra/apps/infra-agent/internal/agent"
	"github.com/Fanzzzd/erainfra/apps/infra-agent/internal/convexnode"
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
	err = client.Run(ctx)
	if ctx.Err() != nil {
		return nil
	}
	return err
}
func trimCredential(s string) string {
	for len(s) > 0 && (s[len(s)-1] == '\n' || s[len(s)-1] == '\r') {
		s = s[:len(s)-1]
	}
	return s
}
