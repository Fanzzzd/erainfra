//go:build linux

package main

import (
	"context"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/cacheca"
	"github.com/Fanzzzd/erainfra/apps/runtime/internal/guest"
	"github.com/Fanzzzd/erainfra/apps/runtime/internal/guestcache"
)

const (
	// cacheRedirectAddr is where the in-guest interceptor listens and the address
	// the redirect DNATs the cache host to. It is a second address on loopback, so
	// no interface module has to be present in the guest kernel, and it is out of
	// 127.0.0.0/8, so the DNAT needs no route_localnet toggle. 100.64.0.0/10 is
	// carrier-grade NAT space: never a job's address, never GitHub's.
	cacheRedirectAddr = "100.64.0.1"
	// cacheTrustAnchor is where the interceptor's per-guest CA is written. The
	// name and .crt extension are what update-ca-certificates requires to fold it
	// into the system trust store, and the runner is handed the same path as
	// NODE_EXTRA_CA_CERTS because Node does not read that store.
	cacheTrustAnchor = "/usr/local/share/ca-certificates/erainfra-cache.crt"
)

// startCacheRedirect points the runner's GitHub cache traffic at an in-guest
// interceptor (ADR 0008). It is best-effort and transactional: on any failure it
// tears down everything it built and returns the error, leaving the guest talking
// to GitHub directly exactly as a guest without a cache does. On success it
// returns the trust-anchor path to hand the runner as NODE_EXTRA_CA_CERTS and a
// stop func, called once, that removes the redirect.
//
// The redirect matches only the runner user's traffic. That catches its Node
// cache client and the children it spawns while excluding the root interceptor,
// so the interceptor's own forward to GitHub cannot loop back into itself, and
// excluding container traffic, which never traverses the host's OUTPUT chain, so
// a container job keeps reaching GitHub directly rather than failing TLS against
// a certificate its image does not trust.
func startCacheRedirect(ctx context.Context, md guest.Metadata, runnerUID uint32) (caPath string, stop func(), err error) {
	var cleanup cleanupStack
	defer func() {
		if err != nil {
			cleanup.run()
		}
	}()

	// Resolve the real cache host to the addresses the runner would otherwise
	// reach. The redirect is by address, not by name, so DNS still answers with
	// GitHub's own IPs and the interceptor reaches them directly.
	ips, err := net.DefaultResolver.LookupIP(ctx, "ip4", cacheca.CacheHost)
	if err != nil {
		return "", nil, fmt.Errorf("resolve %s: %w", cacheca.CacheHost, err)
	}
	if len(ips) == 0 {
		return "", nil, fmt.Errorf("resolve %s: no addresses", cacheca.CacheHost)
	}

	// A second address on loopback holds the interceptor's listener.
	if err := runCmd(ctx, "ip", "addr", "add", cacheRedirectAddr+"/32", "dev", "lo"); err != nil {
		return "", nil, err
	}
	// Teardown runs on a fresh context: the job's is already cancelled by the time
	// the redirect is being pulled, and a killed iptables -D would leave a rule.
	cleanup.push(func() { _ = runCmd(context.Background(), "ip", "addr", "del", cacheRedirectAddr+"/32", "dev", "lo") })

	interceptor, err := guestcache.Start(guestcache.Config{
		CacheServiceURL:    md.CacheServiceURL,
		RunnerToken:        md.CacheRunnerToken,
		InstallTrustAnchor: installTrustAnchor(ctx),
		ListenAddr:         net.JoinHostPort(cacheRedirectAddr, "0"),
	})
	if err != nil {
		return "", nil, fmt.Errorf("start interceptor: %w", err)
	}
	cleanup.push(func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = interceptor.Close(shutdownCtx)
	})

	_, port, err := net.SplitHostPort(interceptor.Addr().String())
	if err != nil {
		return "", nil, fmt.Errorf("interceptor address: %w", err)
	}

	uid := strconv.FormatUint(uint64(runnerUID), 10)
	target := net.JoinHostPort(cacheRedirectAddr, port)
	for _, ip := range ips {
		match := []string{
			"-p", "tcp", "-d", ip.String(), "--dport", "443",
			"-m", "owner", "--uid-owner", uid,
			"-j", "DNAT", "--to-destination", target,
		}
		if err := runCmd(ctx, "iptables", append([]string{"-t", "nat", "-A", "OUTPUT"}, match...)...); err != nil {
			return "", nil, err
		}
		del := append([]string{"-t", "nat", "-D", "OUTPUT"}, match...)
		cleanup.push(func() { _ = runCmd(context.Background(), "iptables", del...) })
	}

	stopOnce := sync.OnceFunc(cleanup.run)
	go func() {
		// If the interceptor stops for any reason, pull the redirect so the runner
		// falls back to talking to GitHub directly (ADR 0008 §3).
		_ = interceptor.Wait()
		stopOnce()
	}()
	return cacheTrustAnchor, stopOnce, nil
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
// failed iptables or ip invocation says why rather than only that it failed.
func runCmd(ctx context.Context, name string, args ...string) error {
	output, err := exec.CommandContext(ctx, name, args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(output)))
	}
	return nil
}

// cleanupStack unwinds in reverse, so teardown removes the redirect rules before
// stopping the interceptor before dropping its address.
type cleanupStack struct{ fns []func() }

func (c *cleanupStack) push(fn func()) { c.fns = append(c.fns, fn) }

func (c *cleanupStack) run() {
	for i := len(c.fns) - 1; i >= 0; i-- {
		c.fns[i]()
	}
}
