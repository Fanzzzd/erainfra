// Package cacheintercept is the guest-facing half of the job-cache interceptor
// (ADR 0008): it terminates TLS for GitHub's cache host inside the guest, using
// the per-guest ephemeral certificate that [cacheca] mints, and routes each
// request either to EraInfra's cache service or transparently on to real GitHub.
//
// Two rules shape the routing. Everything the interceptor does not serve reaches
// real GitHub over GitHub's own TLS, so a guest that trusts the interceptor is
// never worse off than one talking to GitHub directly — the cache is served on
// top of this, never in place of it. And the CacheService path, which EraInfra
// does serve, is authenticated by a bearer the interceptor mints for the guest
// (ADR 0009 §5): the guest's own GitHub token is replaced, never forwarded to
// the cache service.
//
// What is NOT here yet: the fail-open-to-GitHub retry when the cache service is
// unreachable, and the read/write commit-point split that governs it (ADR 0008
// §3). Until that slice lands, a cache-service outage surfaces to the client as
// an error, which the cache client already treats as a miss — degraded, not
// broken.
package cacheintercept

import (
	"context"
	"crypto/tls"
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/cacheca"
)

// cacheServiceMarker is the v2 Actions cache Twirp path. On the intercepted host
// GitHub serves cache v2 and Artifacts v4; only the CacheService path is
// EraInfra's to serve — Artifacts, and everything else, forwards to GitHub.
const cacheServiceMarker = "/twirp/github.actions.results.api.v1.CacheService/"

// BearerFunc supplies the EraInfra cache token for a CacheService request,
// derived from the guest's identity (ADR 0009 §5). A non-nil error means the
// identity could not be established, which the interceptor treats as fail-closed.
type BearerFunc func(*http.Request) (string, error)

// Config is what [New] needs. GitHub is required; Cache, CacheTransport and
// Bearer are required together and enable cache serving, or all omitted for a
// pure transparent forwarder.
type Config struct {
	Authority       *cacheca.Authority
	GitHub          *url.URL
	GitHubTransport http.RoundTripper
	Cache           *url.URL
	CacheTransport  http.RoundTripper
	Bearer          BearerFunc
}

// Interceptor terminates TLS for the cache host and routes requests. It is an
// http.Handler; serve it over TLS with [Interceptor.TLSConfig].
type Interceptor struct {
	tlsConfig *tls.Config
	github    *httputil.ReverseProxy
	cache     *httputil.ReverseProxy // nil when no cache upstream is configured
	bearer    BearerFunc
}

// bearerContextKey carries the minted token from serveCache to the cache proxy's
// Rewrite, which is the only place the outbound request exists to set it on.
type bearerContextKey struct{}

func New(cfg Config) (*Interceptor, error) {
	if cfg.Authority == nil {
		return nil, fmt.Errorf("cacheintercept: nil authority")
	}
	leaf, err := tls.X509KeyPair(cfg.Authority.LeafCertPEM, cfg.Authority.LeafKeyPEM)
	if err != nil {
		return nil, fmt.Errorf("cacheintercept: load leaf key pair: %w", err)
	}

	// GitHub is HTTPS only: the transparent-forward leg must carry the guest's
	// cache traffic to GitHub over TLS, never in cleartext.
	github, err := buildProxy("github upstream", cfg.GitHub, cfg.GitHubTransport, true, nil)
	if err != nil {
		return nil, err
	}

	ic := &Interceptor{
		tlsConfig: &tls.Config{Certificates: []tls.Certificate{leaf}, MinVersion: tls.VersionTLS12},
		github:    github,
	}

	if cfg.Cache != nil {
		if cfg.Bearer == nil {
			return nil, fmt.Errorf("cacheintercept: a cache upstream needs a Bearer")
		}
		// The cache service sits on a host-internal link and may be plain HTTP; the
		// minted bearer, not TLS, is what authenticates the request to it.
		cache, err := buildProxy("cache upstream", cfg.Cache, cfg.CacheTransport, false, injectBearer)
		if err != nil {
			return nil, err
		}
		ic.cache = cache
		ic.bearer = cfg.Bearer
	}

	return ic, nil
}

// buildProxy validates an upstream and returns a reverse proxy that rewrites to
// it. requireHTTPS rejects any non-TLS scheme; otherwise http and https are both
// accepted. hook, if set, runs after the URL rewrite (the cache proxy uses it to
// inject the bearer).
func buildProxy(
	name string,
	upstream *url.URL,
	transport http.RoundTripper,
	requireHTTPS bool,
	hook func(*httputil.ProxyRequest),
) (*httputil.ReverseProxy, error) {
	switch {
	case upstream == nil || upstream.Host == "":
		return nil, fmt.Errorf("cacheintercept: %s must be an absolute URL, got %q", name, upstream)
	case requireHTTPS && upstream.Scheme != "https":
		return nil, fmt.Errorf("cacheintercept: %s must be HTTPS, got %q", name, upstream)
	case !requireHTTPS && upstream.Scheme != "http" && upstream.Scheme != "https":
		return nil, fmt.Errorf("cacheintercept: %s must be http or https, got %q", name, upstream)
	case transport == nil:
		return nil, fmt.Errorf("cacheintercept: nil transport for %s", name)
	}
	// Copy the URL so a caller mutating it after New cannot move the target past
	// the validation above.
	target := *upstream
	return &httputil.ReverseProxy{
		Transport: transport,
		// FlushInterval -1 streams each write straight through, which matters for
		// cache blobs that are hundreds of megabytes: buffering the whole body
		// would hold it in host memory and stall the transfer.
		FlushInterval: -1,
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(&target)
			// The Host header and upstream TLS SNI name the host being dialed, not
			// the interceptor. Deliberately NOT calling pr.SetXForwarded(): a
			// transparent interceptor must look to the upstream exactly like the
			// guest would have.
			pr.Out.Host = target.Host
			if hook != nil {
				hook(pr)
			}
		},
	}, nil
}

// injectBearer replaces the Authorization header with the token minted for this
// request. The guest's own GitHub token must never reach the cache service, so a
// request that somehow arrives without a minted token loses its Authorization
// rather than passing the guest's through.
func injectBearer(pr *httputil.ProxyRequest) {
	if token, ok := pr.In.Context().Value(bearerContextKey{}).(string); ok && token != "" {
		pr.Out.Header.Set("Authorization", "Bearer "+token)
		return
	}
	pr.Out.Header.Del("Authorization")
}

// TLSConfig is the server configuration that presents the interceptor's leaf.
// Serve the interceptor with, e.g., (&http.Server{Handler: ic, TLSConfig:
// ic.TLSConfig()}).ServeTLS(listener, "", "").
func (i *Interceptor) TLSConfig() *tls.Config { return i.tlsConfig.Clone() }

func (i *Interceptor) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if i.cache != nil && strings.Contains(r.URL.Path, cacheServiceMarker) {
		i.serveCache(w, r)
		return
	}
	i.github.ServeHTTP(w, r)
}

func (i *Interceptor) serveCache(w http.ResponseWriter, r *http.Request) {
	token, err := i.bearer(r)
	if err != nil {
		// Fail-closed: the interceptor could not establish who this guest is, so it
		// refuses rather than serving cache under an unproven identity. The cache
		// client treats the error as a miss, so the job proceeds without a warm
		// cache rather than breaking.
		http.Error(w, "cache identity unavailable", http.StatusBadGateway)
		return
	}
	ctx := context.WithValue(r.Context(), bearerContextKey{}, token)
	i.cache.ServeHTTP(w, r.WithContext(ctx))
}
