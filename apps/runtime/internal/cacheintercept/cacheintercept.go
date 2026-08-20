// Package cacheintercept is the guest-facing half of the job-cache interceptor
// (ADR 0008): it terminates TLS for GitHub's cache host inside the guest, using
// the per-guest ephemeral certificate that [cacheca] mints, and forwards the
// traffic on.
//
// This is the fail-open baseline. Every request the interceptor does nothing
// special with still reaches real GitHub over its own TLS, so a guest that
// trusts the interceptor is never worse off than one talking to GitHub directly
// — the cache is served on top of this, never in place of it. The cache-path
// routing and the fail-open/fail-closed split that serves EraInfra's cache for
// the CacheService path arrive in a later slice; what is here forwards
// everything transparently.
package cacheintercept

import (
	"crypto/tls"
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/cacheca"
)

// Interceptor terminates TLS for the cache host and forwards requests upstream.
// It is an http.Handler; the caller serves it over TLS with [Interceptor.TLSConfig].
type Interceptor struct {
	tlsConfig *tls.Config
	proxy     *httputil.ReverseProxy
}

// New builds an interceptor that presents auth's leaf for the cache host and
// forwards every request to upstream over upstreamTransport.
//
// In production upstream is https://<cacheca.CacheHost> and upstreamTransport is
// an http.Transport over the system roots, so the forward leg validates GitHub's
// real certificate exactly as the guest would have. A test points them at a
// stand-in server instead.
func New(auth *cacheca.Authority, upstream *url.URL, upstreamTransport http.RoundTripper) (*Interceptor, error) {
	if auth == nil {
		return nil, fmt.Errorf("cacheintercept: nil authority")
	}
	if upstream == nil || upstream.Scheme == "" || upstream.Host == "" {
		return nil, fmt.Errorf("cacheintercept: upstream must be an absolute URL, got %q", upstream)
	}
	if upstreamTransport == nil {
		return nil, fmt.Errorf("cacheintercept: nil upstream transport")
	}

	leaf, err := tls.X509KeyPair(auth.LeafCertPEM, auth.LeafKeyPEM)
	if err != nil {
		return nil, fmt.Errorf("cacheintercept: load leaf key pair: %w", err)
	}

	proxy := &httputil.ReverseProxy{
		Transport: upstreamTransport,
		// FlushInterval -1 streams each write straight through, which matters for
		// cache blobs that are hundreds of megabytes: buffering the whole body
		// would hold it in host memory and stall the transfer.
		FlushInterval: -1,
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(upstream)
			// The Host header and the upstream TLS SNI must name the host being
			// dialed, not the interceptor. Deliberately NOT calling
			// pr.SetXForwarded(): a transparent interceptor must look to GitHub
			// exactly like the guest would have, and an X-Forwarded-For header
			// would announce the proxy.
			pr.Out.Host = upstream.Host
		},
	}

	return &Interceptor{
		tlsConfig: &tls.Config{
			Certificates: []tls.Certificate{leaf},
			MinVersion:   tls.VersionTLS12,
		},
		proxy: proxy,
	}, nil
}

// TLSConfig is the server configuration that presents the interceptor's leaf.
// Serve the interceptor with, e.g., (&http.Server{Handler: ic, TLSConfig:
// ic.TLSConfig()}).ServeTLS(listener, "", "").
func (i *Interceptor) TLSConfig() *tls.Config { return i.tlsConfig.Clone() }

func (i *Interceptor) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	i.proxy.ServeHTTP(w, r)
}
