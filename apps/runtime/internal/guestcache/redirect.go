package guestcache

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/cacheca"
	"github.com/Fanzzzd/erainfra/apps/runtime/internal/hostspin"
)

// ContainerWatcher keeps containers' hosts files in line with whether they
// trust the interceptor's CA (guestdocker.Watcher). Wait returns when it stops
// on its own; Close stops it and removes every pin it wrote.
type ContainerWatcher interface {
	Wait() error
	Close()
}

// RedirectConfig is what the guest daemon supplies to point the cache host at
// an in-guest interceptor.
type RedirectConfig struct {
	CacheServiceURL string
	RunnerToken     string
	// ListenAddr is the interceptor's address, host:port. Its host is also the
	// address the cache host is pinned to, so the port must be 443 in a real
	// guest: a pinned client dials the name on the port its URL names.
	ListenAddr string
	// HostsFile is the guest's /etc/hosts.
	HostsFile string
	// AddAddress makes ListenAddr's host a local address; RemoveAddress undoes
	// it. Both may be nil when the address is already local (tests).
	AddAddress    func(ctx context.Context) error
	RemoveAddress func()
	// InstallTrustAnchor installs the per-guest CA into the guest's trust
	// stores.
	InstallTrustAnchor func(caPEM []byte) error
	// Watch starts the container watcher for the minted CA. Required: without
	// it a host-network container would inherit the guest's pin unseen.
	Watch func(ctx context.Context, caPEM []byte) (ContainerWatcher, error)
	// SudoersDir is /etc/sudoers.d, where a drop-in keeps TrustEnv's variables
	// across sudo while the redirect is up. Empty skips it (tests that do not
	// exercise it). ValidateSudoers checks a staged drop-in (visudo -cf) and is
	// required when SudoersDir is set.
	SudoersDir      string
	ValidateSudoers func(ctx context.Context, path string) error
	// Discover finds the real upstream before the pin hides it. Nil means
	// DiscoverUpstream.
	Discover func(ctx context.Context, host string) (*Upstream, error)
	// Logf reports why a live redirect was withdrawn. Nil discards.
	Logf func(format string, args ...any)
}

// Redirect is a live redirect of the cache host to the in-guest interceptor.
type Redirect struct {
	interceptor *Interceptor
	stop        func()
}

// StartRedirect brings the redirect up, or leaves the guest exactly as it found
// it and returns why (ADR 0008 §3).
//
// The order is what makes it safe. The interceptor is listening, and the
// watcher is guarding containers, before the guest's hosts file names the
// interceptor; and teardown runs in reverse, so the pin is the first thing to
// go. A failure at any step unwinds every earlier one. Once up, the redirect
// is supervised: if the interceptor or the watcher stops on its own, the whole
// redirect comes down and every client in every namespace goes back to
// talking to GitHub directly. A guest is never left half-redirected.
func StartRedirect(ctx context.Context, cfg RedirectConfig) (_ *Redirect, err error) {
	switch {
	case cfg.HostsFile == "":
		return nil, errors.New("guestcache: a hosts file is required")
	case cfg.Watch == nil:
		return nil, errors.New("guestcache: a container watcher is required")
	case cfg.InstallTrustAnchor == nil:
		return nil, errors.New("guestcache: a trust-anchor installer is required")
	}
	host, _, err := net.SplitHostPort(cfg.ListenAddr)
	if err != nil {
		return nil, fmt.Errorf("guestcache: listen address: %w", err)
	}
	pinAddr := net.ParseIP(host).To4()
	if pinAddr == nil {
		return nil, fmt.Errorf("guestcache: listen address %q is not an IPv4 address the cache host can be pinned to", cfg.ListenAddr)
	}
	discover := cfg.Discover
	if discover == nil {
		discover = DiscoverUpstream
	}
	logf := cfg.Logf
	if logf == nil {
		logf = func(string, ...any) {}
	}

	var unwind []func()
	defer func() {
		if err != nil {
			for i := len(unwind) - 1; i >= 0; i-- {
				unwind[i]()
			}
		}
	}()

	// A previous run of this unit that crashed may have left its pin, and
	// with it every client pointed at an interceptor that is gone. Clear it
	// first, also so that discovery below sees GitHub and not that pin.
	if err := hostspin.UnpinFile(cfg.HostsFile); err != nil {
		return nil, fmt.Errorf("clear a stale cache pin: %w", err)
	}
	// Same for its sudoers drop-in: the trust variables are kept across sudo
	// only while a redirect is installed.
	if cfg.SudoersDir != "" {
		if err := os.Remove(filepath.Join(cfg.SudoersDir, sudoersDropIn)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("clear a stale sudoers drop-in: %w", err)
		}
	}
	upstream, err := discover(ctx, cacheca.CacheHost)
	if err != nil {
		return nil, err
	}
	if cfg.AddAddress != nil {
		if err := cfg.AddAddress(ctx); err != nil {
			return nil, err
		}
		if cfg.RemoveAddress != nil {
			unwind = append(unwind, cfg.RemoveAddress)
		}
	}

	var caPEM []byte
	interceptor, err := Start(Config{
		CacheServiceURL: cfg.CacheServiceURL,
		RunnerToken:     cfg.RunnerToken,
		GitHubTransport: upstream.Transport(),
		InstallTrustAnchor: func(pem []byte) error {
			caPEM = pem
			return cfg.InstallTrustAnchor(pem)
		},
		ListenAddr: cfg.ListenAddr,
	})
	if err != nil {
		return nil, fmt.Errorf("start interceptor: %w", err)
	}
	unwind = append(unwind, func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = interceptor.Close(shutdownCtx)
	})

	watcher, err := cfg.Watch(ctx, caPEM)
	if err != nil {
		return nil, fmt.Errorf("watch containers: %w", err)
	}
	unwind = append(unwind, watcher.Close)

	if cfg.SudoersDir != "" {
		removeDropIn, err := InstallSudoersDropIn(ctx, cfg.SudoersDir, cfg.ValidateSudoers)
		if err != nil {
			return nil, err
		}
		unwind = append(unwind, removeDropIn)
	}

	if err := hostspin.PinFile(cfg.HostsFile, pinAddr, cacheca.CacheHost); err != nil {
		return nil, fmt.Errorf("pin %s: %w", cacheca.CacheHost, err)
	}
	unwind = append(unwind, func() {
		if err := hostspin.UnpinFile(cfg.HostsFile); err != nil {
			logf("job cache: remove the guest pin: %v", err)
		}
	})

	steps := unwind
	stop := sync.OnceFunc(func() {
		for i := len(steps) - 1; i >= 0; i-- {
			steps[i]()
		}
	})
	go func() {
		if err := interceptor.Wait(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logf("job cache redirect withdrawn: interceptor stopped: %v", err)
		}
		stop()
	}()
	go func() {
		if err := watcher.Wait(); err != nil {
			logf("job cache redirect withdrawn: %v", err)
		}
		stop()
	}()
	return &Redirect{interceptor: interceptor, stop: stop}, nil
}

// Stop withdraws the redirect. It is safe to call more than once and from
// more than one goroutine.
func (r *Redirect) Stop() { r.stop() }
