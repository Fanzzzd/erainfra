package guestcache

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/cacheca"
)

// clientThrough dials the interceptor directly for every request, the way the
// guest's redirect will, and trusts the interceptor's own CA under CacheHost's
// name — so this exercises the real TLS termination, not a bypass.
func clientThrough(t *testing.T, ic *Interceptor, caPEM []byte) *http.Client {
	t.Helper()
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caPEM) {
		t.Fatal("trust anchor did not parse")
	}
	return &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, ic.Addr().String())
		},
		TLSClientConfig: &tls.Config{RootCAs: pool, ServerName: cacheca.CacheHost},
	}}
}

func cacheHostURL(path string) string { return "https://" + cacheca.CacheHost + path }

func TestStartRequiresItsInputs(t *testing.T) {
	install := func([]byte) error { return nil }
	for name, cfg := range map[string]Config{
		"no cache url": {RunnerToken: "t", InstallTrustAnchor: install},
		"no token":     {CacheServiceURL: "http://c", InstallTrustAnchor: install},
		"no installer": {CacheServiceURL: "http://c", RunnerToken: "t"},
	} {
		if _, err := Start(cfg); err == nil {
			t.Errorf("%s: Start succeeded", name)
		}
	}
}

// The interceptor sends the CacheService path to the cache service under the
// runner bearer, and everything else to the real cache host — the two rules of
// ADR 0008, exercised over real TLS the runner's own trust store would accept.
func TestInterceptorRoutesCacheAndForwardsTheRest(t *testing.T) {
	const bearer = "erainfra-cache-runner-v1.payload.signature"

	var cacheAuth string
	cacheHits := 0
	cache := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cacheAuth = r.Header.Get("Authorization")
		cacheHits++
		w.WriteHeader(http.StatusOK)
	}))
	defer cache.Close()

	githubHits := 0
	var githubAuth string
	github := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		githubHits++
		githubAuth = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusOK)
	}))
	defer github.Close()

	var installedCA []byte
	ic, err := Start(Config{
		CacheServiceURL:    cache.URL,
		RunnerToken:        bearer,
		GitHubURL:          github.URL,
		GitHubTransport:    github.Client().Transport,
		InstallTrustAnchor: func(caPEM []byte) error { installedCA = caPEM; return nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ic.Close(context.Background()) }()

	if len(installedCA) == 0 {
		t.Fatal("the trust anchor was never installed")
	}
	client := clientThrough(t, ic, installedCA)

	// A CacheService request is served by the cache service, and the guest's own
	// Authorization is replaced by the minted bearer.
	cacheReq, err := http.NewRequestWithContext(t.Context(), http.MethodPost,
		cacheHostURL("/twirp/github.actions.results.api.v1.CacheService/GetCacheEntryDownloadURL"),
		strings.NewReader(`{"key":"k"}`))
	if err != nil {
		t.Fatal(err)
	}
	cacheReq.Header.Set("Authorization", "Bearer guest-github-token")
	resp, err := client.Do(cacheReq)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
	if cacheHits != 1 {
		t.Fatalf("cache service saw %d requests, want 1", cacheHits)
	}
	if cacheAuth != "Bearer "+bearer {
		t.Fatalf("cache Authorization = %q, want the minted bearer", cacheAuth)
	}
	if githubHits != 0 {
		t.Fatalf("a cache request reached github %d times", githubHits)
	}

	// Everything else forwards to the real host, carrying the guest's own token
	// untouched — the interceptor is transparent for what it does not serve.
	otherReq, err := http.NewRequestWithContext(t.Context(), http.MethodGet,
		cacheHostURL("/_apis/artifacts/v4/whatever"), nil)
	if err != nil {
		t.Fatal(err)
	}
	otherReq.Header.Set("Authorization", "Bearer guest-github-token")
	resp2, err := client.Do(otherReq)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, resp2.Body)
	_ = resp2.Body.Close()
	if githubHits != 1 {
		t.Fatalf("github saw %d forwarded requests, want 1", githubHits)
	}
	if githubAuth != "Bearer guest-github-token" {
		t.Fatalf("forwarded Authorization = %q, want the guest's own token", githubAuth)
	}
	if cacheHits != 1 {
		t.Fatalf("a non-cache request reached the cache service")
	}
}

// A trust-anchor installer that fails stops Start: a guest that cannot be made to
// trust the leaf must not serve one, or the runner's TLS to the cache host breaks.
func TestStartFailsWhenTrustAnchorCannotInstall(t *testing.T) {
	_, err := Start(Config{
		CacheServiceURL:    "http://cache.internal:8721",
		RunnerToken:        "t",
		InstallTrustAnchor: func([]byte) error { return errors.New("trust store is read-only") },
	})
	if err == nil {
		t.Fatal("Start ignored a failed trust-anchor install")
	}
}
