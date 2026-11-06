//go:build linux

package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/cacheca"
	"github.com/Fanzzzd/erainfra/apps/runtime/internal/gitmirror"
	"github.com/Fanzzzd/erainfra/apps/runtime/internal/guest"
)

const (
	// gitMirrorDir holds the mirror. It is on the guest's own copy-on-write
	// root, so it is gone with the VM, and root-only, so the mirror is read by
	// this daemon's upload-pack and not by the job directly.
	gitMirrorDir = "/var/lib/erainfra-git-mirror"
	// gitMirrorConfig is the git configuration the system configuration
	// includes. Removing it switches the proxy off for every git on the guest.
	gitMirrorConfig = "/etc/erainfra/git-mirror.gitconfig"
	// gitMirrorCABundle is the system roots plus the per-guest github.com CA,
	// which git is pointed at for https://github.com/ only.
	gitMirrorCABundle = "/etc/erainfra/git-mirror-ca.pem"
	systemCARoots     = "/etc/ssl/certs/ca-certificates.crt"
	// gitMirrorSaveGrace is how long the guest waits after the runner exits
	// for a seed save already under way. The job's result is reported by then;
	// this only delays the VM's reset.
	gitMirrorSaveGrace = 2 * time.Minute
	// gitMirrorCertLifetime matches the cache interceptor's: the material
	// tracks the guest, not the job.
	gitMirrorCertLifetime = 12 * time.Hour
	// gitMirrorPrewarm is how long the guest keeps asking the cache service
	// for the job's seed after claim. The controller pushes the job facts at
	// JobStarted, normally within seconds; a warm guest that waits longer for
	// its job than this restores the seed on the checkout's first fetch.
	gitMirrorPrewarm = 3 * time.Minute
)

// startGitMirror starts the git checkout mirror and points the guest's git at
// it for https://github.com/ (see package gitmirror). It is best-effort: on any
// error nothing is left configured and git talks to GitHub directly. stop
// removes the configuration and waits up to gitMirrorSaveGrace for a seed save.
func startGitMirror(ctx context.Context, md guest.Metadata) (stop func(), err error) {
	authority, err := cacheca.MintFor(gitmirror.GitHubHost, time.Now(), gitMirrorCertLifetime)
	if err != nil {
		return nil, err
	}
	seeds, err := gitmirror.NewSeedClient(md.CacheServiceURL, md.CacheRunnerToken, nil)
	if err != nil {
		return nil, err
	}
	service, err := gitmirror.Start(gitmirror.Config{
		Dir:       gitMirrorDir,
		Seeds:     seeds,
		Authority: authority,
		Logf:      logf,
		// Restore the seed while the runner sets the job up, so the checkout
		// does not wait on it.
		PrewarmFor: gitMirrorPrewarm,
	})
	if err != nil {
		return nil, err
	}
	deactivate, err := gitmirror.Activate(ctx, service, gitmirror.ActivateConfig{
		SystemRoots: systemCARoots,
		CABundle:    gitMirrorCABundle,
		ConfigFile:  gitMirrorConfig,
		CAPEM:       authority.TrustAnchorPEM,
		Include:     includeInSystemGitConfig,
		Logf:        logf,
	})
	if err != nil {
		_ = service.Close(context.Background())
		return nil, err
	}
	return func() {
		deactivate()
		closeCtx, cancel := context.WithTimeout(context.Background(), gitMirrorSaveGrace)
		defer cancel()
		if err := service.Close(closeCtx); err != nil {
			logf("git mirror: stop: %v", err)
		}
	}, nil
}

// includeInSystemGitConfig adds file to /etc/gitconfig's include.path unless it
// is already there, as it is after the guest unit restarts.
func includeInSystemGitConfig(ctx context.Context, file string) error {
	current, _ := exec.CommandContext(ctx, "git", "config", "--system", "--get-all", "include.path").Output()
	for _, line := range strings.Split(string(current), "\n") {
		if strings.TrimSpace(line) == file {
			return nil
		}
	}
	if output, err := exec.CommandContext(ctx, "git", "config", "--system", "--add", "include.path", file).CombinedOutput(); err != nil {
		return fmt.Errorf("git config --system: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

// startGitMirrorIfEnabled is run's entry point: it reports a disabled mirror
// on the journal and returns a no-op stop, so run has one call to make.
func startGitMirrorIfEnabled(ctx context.Context, md guest.Metadata) func() {
	if !md.GitMirror || md.CacheServiceURL == "" || md.CacheRunnerToken == "" {
		return func() {}
	}
	stop, err := startGitMirror(ctx, md)
	if err != nil {
		fmt.Fprintf(os.Stderr, "git checkout mirror disabled, checkouts go to GitHub directly: %v\n", err)
		return func() {}
	}
	return stop
}
