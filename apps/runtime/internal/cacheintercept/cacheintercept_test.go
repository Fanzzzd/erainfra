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

// wiring stands up a fake upstream, a minted authority, and the interceptor
// serving over TLS, and returns a client that reaches the interceptor exactly as
// a guest would: dialing it while believing it is the cache host and trusting
// only the ephemeral CA.
type wiring struct {
	upstreamGot chan *recordedRequest
	client      *http.Client
	caPool      *x509.CertPool
	listenerURL string
	upstreamURL *url.URL
}

type recordedRequest struct {
	method  string
	path    string
	body    string
	xffSeen bool
}

func setup(t *testing.T, upstreamStatus int, upstreamBody string) *wiring {
	t.Helper()
	got := make(chan *recordedRequest, 1)
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		_, xff := r.Header["X-Forwarded-For"]
		got <- &recordedRequest{method: r.Method, path: r.URL.Path, body: string(body), xffSeen: xff}
		w.WriteHeader(upstreamStatus)
		_, _ = io.WriteString(w, upstreamBody)
	}))
	t.Cleanup(upstream.Close)

	upstreamURL, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}

	auth, err := cacheca.Mint(time.Now(), time.Hour)
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	ic, err := New(auth, upstreamURL, upstream.Client().Transport)
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

	return &wiring{upstreamGot: got, client: client, caPool: caPool, listenerURL: ln.Addr().String(), upstreamURL: upstreamURL}
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

func TestForwardsTransparentlyToUpstream(t *testing.T) {
	w := setup(t, http.StatusTeapot, "brewed")

	req, err := http.NewRequestWithContext(reqCtx(t), http.MethodPost,
		"https://"+cacheca.CacheHost+"/twirp/github.actions.results.api.v1.CacheService/GetCacheEntryDownloadURL",
		strings.NewReader(`{"key":"abc"}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := w.client.Do(req)
	if err != nil {
		t.Fatalf("request through the interceptor failed: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != http.StatusTeapot || string(body) != "brewed" {
		t.Fatalf("response = %d %q, want 418 \"brewed\"", resp.StatusCode, body)
	}

	select {
	case rec := <-w.upstreamGot:
		if rec.method != http.MethodPost {
			t.Errorf("upstream method = %s, want POST", rec.method)
		}
		if rec.path != "/twirp/github.actions.results.api.v1.CacheService/GetCacheEntryDownloadURL" {
			t.Errorf("upstream path = %s", rec.path)
		}
		if rec.body != `{"key":"abc"}` {
			t.Errorf("upstream body = %q", rec.body)
		}
		if rec.xffSeen {
			t.Error("interceptor added X-Forwarded-For; a transparent forward must not announce itself")
		}
	default:
		t.Fatal("upstream never received the forwarded request")
	}
}

// A client that does not trust the ephemeral CA must not accept the leaf: the
// interceptor's certificate is trusted only because the guest was handed the CA,
// not because it chains to a public root.
func TestLeafIsNotTrustedWithoutTheEphemeralCA(t *testing.T) {
	w := setup(t, http.StatusOK, "ok")

	stranger := &http.Client{
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
				return (&net.Dialer{}).DialContext(ctx, "tcp", w.listenerURL)
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
	w := setup(t, http.StatusOK, "ok")
	w.upstreamURL.Scheme = "http"
	w.upstreamURL.Host = "wrong.invalid:1"

	req, err := http.NewRequestWithContext(reqCtx(t), http.MethodGet, "https://"+cacheca.CacheHost+"/", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := w.client.Do(req)
	if err != nil {
		t.Fatalf("request failed after mutating the caller's URL: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	select {
	case <-w.upstreamGot:
		// Reached the original upstream: New copied the URL.
	default:
		t.Fatal("request did not reach the original upstream; New kept the caller's URL")
	}
}

func TestNewRejectsBadArguments(t *testing.T) {
	auth, err := cacheca.Mint(time.Now(), time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	good, _ := url.Parse("https://" + cacheca.CacheHost)
	cleartext, _ := url.Parse("http://" + cacheca.CacheHost)
	rt := http.DefaultTransport

	cases := map[string]struct {
		auth      *cacheca.Authority
		upstream  *url.URL
		transport http.RoundTripper
	}{
		"nil authority":       {nil, good, rt},
		"nil upstream":        {auth, nil, rt},
		"relative upstream":   {auth, &url.URL{Path: "/x"}, rt},
		"schemeless upstream": {auth, &url.URL{Host: "h"}, rt},
		"cleartext upstream":  {auth, cleartext, rt},
		"nil transport":       {auth, good, nil},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := New(c.auth, c.upstream, c.transport); err == nil {
				t.Error("New accepted an invalid argument")
			}
		})
	}
}
