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
// When the cache service is unreachable the interceptor fails open: a guest that
// trusts it is never worse off than one talking to GitHub directly (ADR 0008 §3).
// But a transport failure does not prove the cache service left the request
// unprocessed — net/http makes no such guarantee, and the request may have been
// committed with only the response lost — so a replay is safe only for a request
// that cannot have changed state. An idempotent read (a cache lookup) is replayed
// to GitHub; a write is left as a failure, which the cache client treats as a
// skipped save: degraded, never divergent. Replaying a write could double-commit
// behind the cache's back. A response that has already begun, or a 404 miss, is
// the committed answer and passes through untouched — fail-open only fires before
// the first byte reaches the guest. An unmintable bearer is the one pre-dispatch
// case where any method is safe to forward, since the cache was never contacted:
// rather than break the job, the request goes to GitHub with the guest's own
// token, exactly as if there were no cache.
package cacheintercept

import (
	"bytes"
	"context"
	"crypto/tls"
	"fmt"
	"io"
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

// maxReplayBody bounds how much of a CacheService request body the interceptor
// buffers so it can replay it to GitHub on fail-open. Cache Twirp calls are small
// JSON — a key lookup, a reserve, a finalize; a body past this bound is not a real
// cache call, so it streams straight through with no replay held in reserve.
const maxReplayBody = 4 << 20

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

// cacheOutcomeKey carries a *cacheOutcome to the cache proxy's error handler,
// where a transport failure is recorded (not written) for serveCache to act on.
type cacheOutcomeKey struct{}

// cacheOutcome holds the cache proxy's transport error, if any. The error is
// ambiguous — it does not distinguish a request that never dispatched from one
// the cache committed before the response was lost — which is why serveCache only
// replays reads on the strength of it.
type cacheOutcome struct{ transportErr error }

// replayableReadMethods are the CacheService RPCs with no side effects, so a
// fail-open replay to GitHub after an ambiguous cache error cannot diverge state.
// Everything else — the write RPCs (CreateCacheEntry, FinalizeCacheEntryUpload)
// and any unrecognized method — is treated as unsafe to replay.
var replayableReadMethods = map[string]bool{
	"GetCacheEntryDownloadURL": true,
}

func isReplayableRead(path string) bool {
	return replayableReadMethods[path[strings.LastIndex(path, "/")+1:]]
}

// trackingWriter reports whether any status or body has reached the guest, so
// serveCache knows if a response has already begun — the point past which a
// fail-open replay can no longer take it back.
type trackingWriter struct {
	http.ResponseWriter
	wrote bool
}

func (t *trackingWriter) WriteHeader(code int) {
	t.wrote = true
	t.ResponseWriter.WriteHeader(code)
}

func (t *trackingWriter) Write(b []byte) (int, error) {
	t.wrote = true
	return t.ResponseWriter.Write(b)
}

// Flush preserves the streaming the cache proxy asks for (FlushInterval -1). The
// proxy only flushes after a Write, so this cannot commit a response on its own.
func (t *trackingWriter) Flush() {
	if f, ok := t.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

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
		// A transport failure to the cache service is recorded, not written back to
		// the guest: serveCache turns it into a fail-open replay to GitHub. Because
		// nothing is sent from here, the replay still owns the whole response.
		cache.ErrorHandler = func(_ http.ResponseWriter, r *http.Request, err error) {
			if o, ok := r.Context().Value(cacheOutcomeKey{}).(*cacheOutcome); ok {
				o.transportErr = err
			}
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
	// Prefix, not substring: GitHub serves CacheService at the root of the host,
	// so only a path that starts with the marker is ours. A substring match would
	// route a crafted /anything/twirp/…/CacheService/… request to the cache and
	// swap its Authorization — exactly what a transparent forward must not do.
	if i.cache != nil && strings.HasPrefix(r.URL.Path, cacheServiceMarker) {
		i.serveCache(w, r)
		return
	}
	i.github.ServeHTTP(w, r)
}

func (i *Interceptor) serveCache(w http.ResponseWriter, r *http.Request) {
	token, err := i.bearer(r)
	if err != nil {
		// The interceptor cannot establish who this guest is, so it will not serve
		// cache under an unproven identity — but it must not be worse than GitHub
		// either. It fails open: the request goes to GitHub with the guest's own
		// token, exactly as if there were no cache at all.
		i.github.ServeHTTP(w, r)
		return
	}

	body, replayable, err := bufferForReplay(r)
	if err != nil {
		http.Error(w, "cache request unreadable", http.StatusBadGateway)
		return
	}

	outcome := &cacheOutcome{}
	ctx := context.WithValue(r.Context(), bearerContextKey{}, token)
	ctx = context.WithValue(ctx, cacheOutcomeKey{}, outcome)
	cacheReq := r.Clone(ctx)
	if replayable {
		cacheReq.Body = io.NopCloser(bytes.NewReader(body))
	} else {
		// Too large to hold for a replay: stream the peeked head then the rest.
		cacheReq.Body = io.NopCloser(io.MultiReader(bytes.NewReader(body), r.Body))
	}

	tw := &trackingWriter{ResponseWriter: w}
	i.cache.ServeHTTP(tw, cacheReq)

	// The cache answered, or a response already reached the guest: that answer
	// stands (a 404 is a legitimate miss, not a failure).
	if outcome.transportErr == nil || tw.wrote {
		return
	}

	// The cache service never answered. The transport error is ambiguous — the
	// request may have been committed with only the response lost — so replay only
	// an idempotent read, whose repeat cannot diverge state. A write (or an
	// unrecognized method, or a body too large to have been held) is surfaced as a
	// failure; the cache client treats a failed save as a skipped save.
	if !replayable || !isReplayableRead(r.URL.Path) {
		http.Error(w, "cache unavailable", http.StatusBadGateway)
		return
	}
	ghReq := r.Clone(r.Context())
	ghReq.Body = io.NopCloser(bytes.NewReader(body))
	i.github.ServeHTTP(w, ghReq)
}

// bufferForReplay reads the request body up to maxReplayBody so it can be sent
// once to the cache service and, on fail-open, again to GitHub. A body within the
// bound is fully buffered (replayable); a larger one is not held — the caller
// streams it through and forgoes the GitHub retry.
func bufferForReplay(r *http.Request) (body []byte, replayable bool, err error) {
	if r.Body == nil {
		return nil, true, nil
	}
	buf, err := io.ReadAll(io.LimitReader(r.Body, maxReplayBody+1))
	if err != nil {
		return nil, false, err
	}
	if int64(len(buf)) > maxReplayBody {
		return buf, false, nil
	}
	return buf, true, nil
}
