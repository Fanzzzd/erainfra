package cacheintercept

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/cacheca"
)

const (
	// cachePath is a CacheService Twirp request — the one path the interceptor
	// serves itself. artifactPath is Artifacts v4 on the same host, which must
	// forward to GitHub untouched.
	cachePath    = "/twirp/github.actions.results.api.v1.CacheService/GetCacheEntryDownloadURL"
	artifactPath = "/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact"

	// mintedToken is what the default test bearer returns; the guest's own token
	// (guestToken) must never reach the cache upstream in its place.
	mintedToken = "minted-cache-token"
	guestToken  = "token ghs_guestsecret"
)

type recordedRequest struct {
	method string
	path   string
	body   string
	auth   string
	// xffSeen reports whether the interceptor announced itself with an
	// X-Forwarded-For header; a transparent forward must not.
	xffSeen bool
}

// stand is a fake upstream that records the one request it receives and replies
// with a fixed status and body.
type stand struct {
	got       chan *recordedRequest
	url       *url.URL
	transport http.RoundTripper
}

func newStand(t *testing.T, tlsServer bool, status int, body string) *stand {
	t.Helper()
	got := make(chan *recordedRequest, 1)
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		_, xffSeen := r.Header["X-Forwarded-For"]
		got <- &recordedRequest{
			method:  r.Method,
			path:    r.URL.Path,
			body:    string(b),
			auth:    r.Header.Get("Authorization"),
			xffSeen: xffSeen,
		}
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	})

	var srv *httptest.Server
	if tlsServer {
		srv = httptest.NewTLSServer(h)
	} else {
		srv = httptest.NewServer(h)
	}
	t.Cleanup(srv.Close)

	u, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	return &stand{got: got, url: u, transport: srv.Client().Transport}
}

// harness wires the interceptor over TLS in front of a GitHub stand and,
// optionally, a cache stand, and hands back a client posturing as the guest.
type harness struct {
	github      *stand
	cache       *stand // nil unless withCache
	client      *http.Client
	listenerURL string
}

type options struct {
	withCache    bool
	githubStatus int
	githubBody   string
	cacheStatus  int
	cacheBody    string
	bearer       BearerFunc // nil defaults to returning mintedToken
}

func setup(t *testing.T, o options) *harness {
	t.Helper()

	github := newStand(t, true, orDefault(o.githubStatus, http.StatusOK), o.githubBody)

	auth, err := cacheca.Mint(time.Now(), time.Hour)
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}

	cfg := Config{
		Authority:       auth,
		GitHub:          github.url,
		GitHubTransport: github.transport,
	}
	var cache *stand
	if o.withCache {
		// The cache service is plain HTTP on a host-internal link in production; a
		// non-TLS stand mirrors that and exercises the http upstream path.
		cache = newStand(t, false, orDefault(o.cacheStatus, http.StatusOK), o.cacheBody)
		cfg.Cache = cache.url
		cfg.CacheTransport = cache.transport
		cfg.Bearer = o.bearer
		if cfg.Bearer == nil {
			cfg.Bearer = func(*http.Request) (string, error) { return mintedToken, nil }
		}
	}

	ic, err := New(cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	ln, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{
		Handler:   ic,
		TLSConfig: ic.TLSConfig(),
		// The not-trusted test deliberately fails a handshake; keep the server's
		// log of it out of the test output.
		ErrorLog: log.New(io.Discard, "", 0),
	}
	go func() { _ = srv.ServeTLS(ln, "", "") }()
	t.Cleanup(func() { _ = srv.Close() })

	caPool := x509.NewCertPool()
	if !caPool.AppendCertsFromPEM(auth.TrustAnchorPEM) {
		t.Fatal("trust anchor did not parse")
	}
	// Dial the interceptor's listener while pretending to be the cache host, and
	// trust only the ephemeral CA — the guest's exact posture.
	client := &http.Client{
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
				return (&net.Dialer{}).DialContext(ctx, "tcp", ln.Addr().String())
			},
			TLSClientConfig: &tls.Config{RootCAs: caPool, ServerName: cacheca.CacheHost},
		},
	}
	t.Cleanup(client.CloseIdleConnections)

	return &harness{github: github, cache: cache, client: client, listenerURL: ln.Addr().String()}
}

func orDefault(v, def int) int {
	if v == 0 {
		return def
	}
	return v
}

// reqCtx bounds a single request so a stalled interceptor or upstream fails the
// test fast rather than blocking until the -timeout process deadline (t.Context
// alone carries no per-request deadline).
func reqCtx(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func (h *harness) do(t *testing.T, method, path, body string) *http.Response {
	t.Helper()
	var r io.Reader
	if body != "" {
		r = strings.NewReader(body)
	}
	req, err := http.NewRequestWithContext(reqCtx(t), method, "https://"+cacheca.CacheHost+path, r)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", guestToken)
	resp, err := h.client.Do(req)
	if err != nil {
		t.Fatalf("request through the interceptor failed: %v", err)
	}
	return resp
}

func recv(t *testing.T, ch chan *recordedRequest) *recordedRequest {
	t.Helper()
	select {
	case rec := <-ch:
		return rec
	default:
		return nil
	}
}

// Without a cache upstream the interceptor is a pure transparent forwarder: even
// the CacheService path goes to GitHub, unaltered and unannounced.
func TestNoCacheConfiguredForwardsToGitHub(t *testing.T) {
	h := setup(t, options{githubStatus: http.StatusTeapot, githubBody: "brewed"})

	resp := h.do(t, http.MethodPost, cachePath, `{"key":"abc"}`)
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusTeapot || string(body) != "brewed" {
		t.Fatalf("response = %d %q, want 418 \"brewed\"", resp.StatusCode, body)
	}

	rec := recv(t, h.github.got)
	if rec == nil {
		t.Fatal("GitHub never received the forwarded request")
	}
	if rec.method != http.MethodPost || rec.path != cachePath || rec.body != `{"key":"abc"}` {
		t.Errorf("GitHub got %s %s %q", rec.method, rec.path, rec.body)
	}
	if rec.auth != guestToken {
		t.Errorf("Authorization = %q, want the guest token passed through untouched", rec.auth)
	}
	if rec.xffSeen {
		t.Error("interceptor added X-Forwarded-For; a transparent forward must not announce itself")
	}
}

// With a cache upstream, the CacheService path is served by the cache — reached
// with the minted bearer, and never carrying the guest's own token.
func TestCacheServicePathRoutesToCacheWithMintedBearer(t *testing.T) {
	h := setup(t, options{withCache: true, cacheStatus: http.StatusOK, cacheBody: "hit"})

	resp := h.do(t, http.MethodPost, cachePath, `{"key":"abc"}`)
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK || string(body) != "hit" {
		t.Fatalf("response = %d %q, want 200 \"hit\"", resp.StatusCode, body)
	}

	rec := recv(t, h.cache.got)
	if rec == nil {
		t.Fatal("cache never received the request")
	}
	if rec.body != `{"key":"abc"}` {
		t.Errorf("cache body = %q", rec.body)
	}
	if rec.auth != "Bearer "+mintedToken {
		t.Errorf("cache Authorization = %q, want the minted bearer", rec.auth)
	}
	if strings.Contains(rec.auth, "ghs_guestsecret") {
		t.Error("the guest's GitHub token reached the cache service")
	}
	if got := recv(t, h.github.got); got != nil {
		t.Error("GitHub received a request that belonged to the cache")
	}
}

// With a cache upstream, everything that is not the CacheService path still
// forwards transparently to GitHub — Artifacts on the same host is not ours.
func TestNonCacheServicePathRoutesToGitHub(t *testing.T) {
	h := setup(t, options{withCache: true, githubStatus: http.StatusCreated, githubBody: "made"})

	resp := h.do(t, http.MethodPost, artifactPath, `{"name":"art"}`)
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusCreated || string(body) != "made" {
		t.Fatalf("response = %d %q, want 201 \"made\"", resp.StatusCode, body)
	}

	rec := recv(t, h.github.got)
	if rec == nil {
		t.Fatal("GitHub never received the Artifacts request")
	}
	if rec.path != artifactPath {
		t.Errorf("GitHub path = %s, want %s", rec.path, artifactPath)
	}
	if rec.auth != guestToken {
		t.Errorf("Authorization = %q, want the guest token passed through untouched", rec.auth)
	}
	if got := recv(t, h.cache.got); got != nil {
		t.Error("cache received a request that belonged to GitHub")
	}
}

// The marker only routes to the cache when it is a prefix. A path that merely
// contains it deeper in the request — not something GitHub serves there — must
// forward to GitHub untouched, keeping its own token, never getting the bearer.
func TestMarkerAsSubstringForwardsToGitHub(t *testing.T) {
	h := setup(t, options{withCache: true, githubStatus: http.StatusOK, githubBody: "gh"})

	resp := h.do(t, http.MethodPost, "/anything"+cachePath, `{"key":"abc"}`)
	defer func() { _ = resp.Body.Close() }()
	if _, err := io.ReadAll(resp.Body); err != nil {
		t.Fatal(err)
	}

	rec := recv(t, h.github.got)
	if rec == nil {
		t.Fatal("a non-prefix path did not reach GitHub; it was misrouted to the cache")
	}
	if rec.auth != guestToken {
		t.Errorf("Authorization = %q, want the guest token untouched", rec.auth)
	}
	if got := recv(t, h.cache.got); got != nil {
		t.Error("the cache received a request whose marker was only a substring")
	}
}

// When the bearer cannot be minted the interceptor fails closed: it refuses the
// cache request rather than serving under an unproven identity, and nothing
// reaches the cache. The cache client reads the error as a miss.
func TestBearerErrorFailsClosed(t *testing.T) {
	h := setup(t, options{
		withCache: true,
		bearer:    func(*http.Request) (string, error) { return "", errors.New("no identity") },
	})

	resp := h.do(t, http.MethodPost, cachePath, `{"key":"abc"}`)
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502 (fail-closed)", resp.StatusCode)
	}
	if got := recv(t, h.cache.got); got != nil {
		t.Error("cache was reached despite an unavailable identity")
	}
}

// A client that does not trust the ephemeral CA must not accept the leaf: the
// interceptor's certificate is trusted only because the guest was handed the CA,
// not because it chains to a public root.
func TestLeafIsNotTrustedWithoutTheEphemeralCA(t *testing.T) {
	h := setup(t, options{})

	stranger := &http.Client{
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
				return (&net.Dialer{}).DialContext(ctx, "tcp", h.listenerURL)
			},
			// Empty pool: trusts nothing but the system roots, which never signed
			// this leaf.
			TLSClientConfig: &tls.Config{RootCAs: x509.NewCertPool(), ServerName: cacheca.CacheHost},
		},
	}
	defer stranger.CloseIdleConnections()

	req, err := http.NewRequestWithContext(reqCtx(t), http.MethodGet, "https://"+cacheca.CacheHost+"/", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := stranger.Do(req)
	if err == nil {
		_ = resp.Body.Close()
		t.Fatal("a client that does not trust the ephemeral CA accepted the leaf")
	}
	// Require the specific failure — the CA is unknown — so a refused connection
	// or a shut-down server cannot masquerade as a successful rejection.
	var unknownAuthority x509.UnknownAuthorityError
	if !errors.As(err, &unknownAuthority) {
		t.Fatalf("rejected for %q, want an unknown-certificate-authority failure", err)
	}
}

// New must not keep the caller's URL: a later mutation of it would move the
// forward target past the scheme and host validation.
func TestUpstreamMutationAfterNewIsIgnored(t *testing.T) {
	github := newStand(t, true, http.StatusOK, "ok")
	auth, err := cacheca.Mint(time.Now(), time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	ic, err := New(Config{Authority: auth, GitHub: github.url, GitHubTransport: github.transport})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	// Mutate the caller's URL after New; the interceptor must be unaffected.
	github.url.Scheme = "http"
	github.url.Host = "wrong.invalid:1"

	ln, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: ic, TLSConfig: ic.TLSConfig(), ErrorLog: log.New(io.Discard, "", 0)}
	go func() { _ = srv.ServeTLS(ln, "", "") }()
	t.Cleanup(func() { _ = srv.Close() })

	caPool := x509.NewCertPool()
	if !caPool.AppendCertsFromPEM(auth.TrustAnchorPEM) {
		t.Fatal("trust anchor did not parse")
	}
	client := &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "tcp", ln.Addr().String())
		},
		TLSClientConfig: &tls.Config{RootCAs: caPool, ServerName: cacheca.CacheHost},
	}}
	t.Cleanup(client.CloseIdleConnections)

	req, err := http.NewRequestWithContext(reqCtx(t), http.MethodGet, "https://"+cacheca.CacheHost+"/", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("request failed after mutating the caller's URL: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if rec := recv(t, github.got); rec == nil {
		t.Fatal("request did not reach the original upstream; New kept the caller's URL")
	}
}

func TestNewRejectsBadArguments(t *testing.T) {
	auth, err := cacheca.Mint(time.Now(), time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	https, _ := url.Parse("https://" + cacheca.CacheHost)
	cleartext, _ := url.Parse("http://" + cacheca.CacheHost)
	ftp, _ := url.Parse("ftp://" + cacheca.CacheHost)
	rt := http.DefaultTransport
	bearer := func(*http.Request) (string, error) { return mintedToken, nil }

	cases := map[string]Config{
		"nil authority":        {Authority: nil, GitHub: https, GitHubTransport: rt},
		"nil github":           {Authority: auth, GitHub: nil, GitHubTransport: rt},
		"relative github":      {Authority: auth, GitHub: &url.URL{Path: "/x"}, GitHubTransport: rt},
		"schemeless github":    {Authority: auth, GitHub: &url.URL{Host: "h"}, GitHubTransport: rt},
		"cleartext github":     {Authority: auth, GitHub: cleartext, GitHubTransport: rt},
		"nil github transport": {Authority: auth, GitHub: https, GitHubTransport: nil},
		"cache without bearer": {Authority: auth, GitHub: https, GitHubTransport: rt, Cache: https, CacheTransport: rt},
		"cache nil transport":  {Authority: auth, GitHub: https, GitHubTransport: rt, Cache: https, Bearer: bearer},
		"cache bad scheme":     {Authority: auth, GitHub: https, GitHubTransport: rt, Cache: ftp, CacheTransport: rt, Bearer: bearer},
		"cache schemeless":     {Authority: auth, GitHub: https, GitHubTransport: rt, Cache: &url.URL{Host: "h"}, CacheTransport: rt, Bearer: bearer},
	}
	for name, cfg := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := New(cfg); err == nil {
				t.Error("New accepted an invalid argument")
			}
		})
	}
}
