//go:build linux

package main

import (
	"context"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/cacheca"
	"github.com/Fanzzzd/erainfra/apps/runtime/internal/guest"
	"github.com/Fanzzzd/erainfra/apps/runtime/internal/guestcache"
	"github.com/Fanzzzd/erainfra/apps/runtime/internal/guestdocker"
)

const (
	// cacheRedirectAddr is where the in-guest interceptor listens and the
	// address the guest pins GitHub's cache host to. It is a second address on
	// loopback, so no interface module has to be present in the guest kernel,
	// and it is out of 127.0.0.0/8, so a container on a Docker bridge reaches it
	// through its default route like any other guest address, which a loopback
	// address it would read as its own could not do. 100.64.0.0/10 is
	// carrier-grade NAT space: never a job's address, never GitHub's.
	cacheRedirectAddr = "100.64.0.1"
	// cacheRedirectPort is 443 because a pinned client dials the cache host on
	// the port its URL names, and that URL is GitHub's.
	cacheRedirectPort = "443"
	// cacheTrustAnchor is where the interceptor's per-guest CA is written. The
	// name and .crt extension are what update-ca-certificates requires to fold it
	// into the system trust store, and the runner is handed the same path as
	// NODE_EXTRA_CA_CERTS because Node does not read that store. The basename is
	// also the one buildx keeps when it copies the CA into a builder.
	cacheTrustAnchor = "/usr/local/share/ca-certificates/" + guestdocker.CAFileName
)

// startCacheRedirect points GitHub's cache host at an in-guest interceptor
// (ADR 0008) by pinning the name in the guest's /etc/hosts, and in the hosts
// file of each container verified to trust the interceptor's CA. It is
// best-effort and transactional: on any failure it leaves the guest talking to
// GitHub directly exactly as a guest without a cache does, and returns why. On
// success it returns the trust-anchor path to hand the runner as
// NODE_EXTRA_CA_CERTS and a stop func, safe to call more than once.
//
// Every process on the guest itself resolves through /etc/hosts, so the
// runner, its actions, and anything they start, as any user, reach the
// interceptor. They trust it through the system store that
// update-ca-certificates rebuilds (OpenSSL, Go, .NET, curl) or, for Node,
// through NODE_EXTRA_CA_CERTS. The interceptor's own forward to GitHub
// resolves through guestcache.Upstream, which never reads /etc/hosts, so it
// cannot loop back into itself.
func startCacheRedirect(ctx context.Context, md guest.Metadata) (caPath string, stop func(), err error) {
	docker := guestdocker.NewClient(guestdocker.DefaultSocket)
	redirect, err := guestcache.StartRedirect(ctx, guestcache.RedirectConfig{
		CacheServiceURL: md.CacheServiceURL,
		RunnerToken:     md.CacheRunnerToken,
		ListenAddr:      net.JoinHostPort(cacheRedirectAddr, cacheRedirectPort),
		HostsFile:       hostsFile,
		// replace rather than add: a unit restarted after a crash finds the
		// address still there, and that is not a reason to go without a cache.
		AddAddress: func(ctx context.Context) error {
			return runCmd(ctx, "ip", "addr", "replace", cacheRedirectAddr+"/32", "dev", "lo")
		},
		// Teardown runs on a fresh context: the job's is already cancelled by
		// the time the redirect is being pulled.
		RemoveAddress: func() {
			_ = runCmd(context.Background(), "ip", "addr", "del", cacheRedirectAddr+"/32", "dev", "lo")
		},
		InstallTrustAnchor: installTrustAnchor(ctx),
		Watch: func(ctx context.Context, caPEM []byte) (guestcache.ContainerWatcher, error) {
			return guestdocker.StartWatcher(ctx, guestdocker.WatcherConfig{
				Engine:   docker,
				CAPEM:    caPEM,
				Addr:     net.ParseIP(cacheRedirectAddr),
				Host:     cacheca.CacheHost,
				ReadFile: guestdocker.ReadInContainer,
				Logf:     logf,
			})
		},
		Logf: logf,
	})
	if err != nil {
		return "", nil, err
	}
	return cacheTrustAnchor, redirect.Stop, nil
}

// installTrustAnchor writes the interceptor's per-guest CA and folds it into the
// system trust store. The runner is additionally handed the same path as
// NODE_EXTRA_CA_CERTS because Node ships its own trust store and ignores this one.
// It returns the guestcache trust-anchor installer, closing over the setup
// context so update-ca-certificates is bounded by the same deadline as the rest.
func installTrustAnchor(ctx context.Context) func([]byte) error {
	return func(caPEM []byte) error {
		if err := os.MkdirAll(filepath.Dir(cacheTrustAnchor), 0o755); err != nil {
			return fmt.Errorf("create trust-anchor directory: %w", err)
		}
		if err := os.WriteFile(cacheTrustAnchor, caPEM, 0o644); err != nil {
			return fmt.Errorf("write trust anchor: %w", err)
		}
		return runCmd(ctx, "update-ca-certificates")
	}
}

// runCmd runs a command to completion, folding its output into the error so a
// failed ip or systemctl invocation says why rather than only that it failed.
func runCmd(ctx context.Context, name string, args ...string) error {
	output, err := exec.CommandContext(ctx, name, args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(output)))
	}
	return nil
}

// logf writes to the guest journal, which is this service's stderr.
func logf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
}
