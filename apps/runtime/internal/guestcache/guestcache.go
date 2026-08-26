// Package guestcache runs EraInfra's job-cache interceptor inside the guest.
//
// A guest with a cache trusts a per-guest ephemeral CA and terminates TLS for
// GitHub's one cache host locally (ADR 0008): the interceptor forwards the
// CacheService path to EraInfra's cache service, presenting the runner-auth
// bearer the host minted, and forwards everything else to the real cache host.
//
// Pointing the guest's cache traffic at the interceptor is a separate step, the
// supervised redirect. A guest that starts the interceptor but installs no
// redirect simply talks to GitHub directly, exactly as a guest without a cache
// does — so starting the interceptor is inert until a redirect points at Addr.
package guestcache

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"time"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/cacheca"
	"github.com/Fanzzzd/erainfra/apps/runtime/internal/cacheintercept"
)

// certLifetime is how long the per-guest CA and leaf live. It tracks the guest,
// not the job: the material dies with the VM, and a boot's worth of clock skew is
// already absorbed by cacheca.
const certLifetime = 12 * time.Hour

// Config is what the guest daemon knows when it starts the interceptor.
type Config struct {
	// CacheServiceURL is EraInfra's cache service, where the CacheService path is
	// forwarded. Required.
	CacheServiceURL string
	// RunnerToken is the runner-auth bearer presented to the cache service.
	// Required.
	RunnerToken string
	// GitHubURL is the real cache host that everything-but-CacheService forwards
	// to. Defaults to https://<cacheca.CacheHost>.
	GitHubURL string
	// GitHubTransport reaches the real cache host. It must resolve that host to
	// GitHub's real address, not the guest's pinned one, so a redirect that points
	// the host at this interceptor cannot loop back into it. Nil defaults to a
	// transport over the system resolver, which is correct until a redirect pins
	// the host.
	GitHubTransport http.RoundTripper
	// CacheTransport reaches the cache service. Nil defaults to a plain transport.
	CacheTransport http.RoundTripper
	// InstallTrustAnchor installs the interceptor's CA so the runner trusts the
	// leaf it serves. Required.
	InstallTrustAnchor func(caPEM []byte) error
	// ListenAddr is where the interceptor's TLS listener binds. Defaults to
	// 127.0.0.1:0, an ephemeral loopback port.
	ListenAddr string
}

// Interceptor is a running in-guest cache interceptor.
type Interceptor struct {
	server   *http.Server
	listener net.Listener
	errc     chan error
}

// Addr is the address the interceptor listens on. A redirect points the cache
// host's traffic here.
func (i *Interceptor) Addr() net.Addr { return i.listener.Addr() }

// Start mints the per-guest authority, installs its trust anchor, and serves the
// interceptor. The returned Interceptor is already accepting connections.
func Start(cfg Config) (*Interceptor, error) {
	switch {
	case cfg.CacheServiceURL == "":
		return nil, errors.New("guestcache: a cache service URL is required")
	case cfg.RunnerToken == "":
		return nil, errors.New("guestcache: a runner token is required")
	case cfg.InstallTrustAnchor == nil:
		return nil, errors.New("guestcache: a trust-anchor installer is required")
	}

	githubURL := cfg.GitHubURL
	if githubURL == "" {
		githubURL = "https://" + cacheca.CacheHost
	}
	github, err := url.Parse(githubURL)
	if err != nil {
		return nil, fmt.Errorf("guestcache: parse github url: %w", err)
	}
	cache, err := url.Parse(cfg.CacheServiceURL)
	if err != nil {
		return nil, fmt.Errorf("guestcache: parse cache service url: %w", err)
	}

	authority, err := cacheca.Mint(time.Now(), certLifetime)
	if err != nil {
		return nil, fmt.Errorf("guestcache: mint authority: %w", err)
	}
	if err := cfg.InstallTrustAnchor(authority.TrustAnchorPEM); err != nil {
		return nil, fmt.Errorf("guestcache: install trust anchor: %w", err)
	}

	token := cfg.RunnerToken
	ic, err := cacheintercept.New(cacheintercept.Config{
		Authority:       authority,
		GitHub:          github,
		GitHubTransport: transportOrDefault(cfg.GitHubTransport),
		Cache:           cache,
		CacheTransport:  transportOrDefault(cfg.CacheTransport),
		Bearer:          func(*http.Request) (string, error) { return token, nil },
	})
	if err != nil {
		return nil, fmt.Errorf("guestcache: build interceptor: %w", err)
	}

	addr := cfg.ListenAddr
	if addr == "" {
		addr = "127.0.0.1:0"
	}
	listener, err := (&net.ListenConfig{}).Listen(context.Background(), "tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("guestcache: listen: %w", err)
	}

	server := &http.Server{
		Handler:   ic,
		TLSConfig: ic.TLSConfig(),
		// The loopback listener faces the guest's own runner, but a client that
		// opens a connection and sends no request should not hold it forever.
		ReadHeaderTimeout: 30 * time.Second,
	}
	interceptor := &Interceptor{server: server, listener: listener, errc: make(chan error, 1)}
	go func() {
		// The empty cert and key make ServeTLS use TLSConfig.Certificates — the
		// leaf cacheca minted for CacheHost.
		interceptor.errc <- server.ServeTLS(listener, "", "")
	}()
	return interceptor, nil
}

// Close stops the interceptor.
func (i *Interceptor) Close(ctx context.Context) error {
	return i.server.Shutdown(ctx)
}

// Wait returns when the interceptor's server stops, with the reason. A caller
// that installed a redirect uses this to tear the redirect down if the
// interceptor dies, restoring direct-to-GitHub (ADR 0008 §3).
func (i *Interceptor) Wait() error { return <-i.errc }

func transportOrDefault(t http.RoundTripper) http.RoundTripper {
	if t != nil {
		return t
	}
	return http.DefaultTransport.(*http.Transport).Clone()
}
