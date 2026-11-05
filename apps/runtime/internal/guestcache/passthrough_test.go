package guestcache

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// seenRequest is what the stand-in for GitHub received.
type seenRequest struct {
	method, path, rawQuery, host string
	header                       http.Header
	body                         []byte
}

// Everything on the cache host except the CacheService path is GitHub's to
// answer, Artifacts v4 above all: upload-artifact and download-artifact v4+
// call ArtifactService on this same host. The interceptor must hand those
// requests and their replies through unchanged, through the same Upstream
// transport the guest uses in production.
func TestNonCacheTrafficPassesThroughByteForByte(t *testing.T) {
	requestBody := make([]byte, 1<<20)
	responseBody := make([]byte, 1<<20)
	if _, err := rand.Read(requestBody); err != nil {
		t.Fatal(err)
	}
	if _, err := rand.Read(responseBody); err != nil {
		t.Fatal(err)
	}
	var gzipped bytes.Buffer
	gz := gzip.NewWriter(&gzipped)
	_, _ = gz.Write(responseBody)
	_ = gz.Close()

	var mu sync.Mutex
	var seen []seenRequest
	github := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		seen = append(seen, seenRequest{r.Method, r.URL.Path, r.URL.RawQuery, r.Host, r.Header.Clone(), body})
		mu.Unlock()
		w.Header().Set("X-Upstream", "github")
		w.Header().Set("Content-Type", "application/octet-stream")
		if r.Header.Get("Accept-Encoding") == "gzip" {
			w.Header().Set("Content-Encoding", "gzip")
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write(gzipped.Bytes())
			return
		}
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write(responseBody)
	}))
	defer github.Close()
	cacheService := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Error("a non-cache request reached the cache service")
	}))
	defer cacheService.Close()

	// The stand-in's certificate names example.com, so the Upstream is built
	// for that name the way production builds it for the cache host.
	_, port, _ := net.SplitHostPort(github.Listener.Addr().String())
	upstream, err := discoverUpstream(t.Context(), "example.com",
		func(context.Context, string) (string, error) { return "example.com.", nil },
		func(context.Context, string) ([]net.IP, error) { return []net.IP{net.ParseIP("127.0.0.1")}, nil })
	if err != nil {
		t.Fatal(err)
	}
	transport := upstream.Transport()
	roots := x509.NewCertPool()
	roots.AddCert(github.Certificate())
	transport.TLSClientConfig = &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}

	var caPEM []byte
	ic, err := Start(Config{
		CacheServiceURL:    cacheService.URL,
		RunnerToken:        "erainfra-cache-runner-v1.payload.signature",
		GitHubURL:          "https://example.com:" + port,
		GitHubTransport:    transport,
		InstallTrustAnchor: func(pem []byte) error { caPEM = pem; return nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ic.Close(context.Background()) }()
	client := clientThrough(t, ic, caPEM)
	// The test client must not ask for gzip on its own either, or it could not
	// tell the interceptor adding Accept-Encoding from itself doing so.
	client.Transport.(*http.Transport).DisableCompression = true

	const artifactPath = "/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact"
	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, cacheHostURL(artifactPath+"?attempt=1&x=%2F"), bytes.NewReader(requestBody))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer guest-github-token")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "@actions/artifact-2.3.2")
	req.Header.Set("X-Custom", "kept")
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()

	if len(seen) != 1 {
		t.Fatalf("github saw %d requests, want 1", len(seen))
	}
	in := seen[0]
	if in.method != http.MethodPost || in.path != artifactPath || in.rawQuery != "attempt=1&x=%2F" {
		t.Fatalf("request line changed: %s %s?%s", in.method, in.path, in.rawQuery)
	}
	if !bytes.Equal(in.body, requestBody) {
		t.Fatal("request body changed on the way to GitHub")
	}
	for name, want := range map[string]string{
		"Authorization": "Bearer guest-github-token",
		"Content-Type":  "application/json",
		"User-Agent":    "@actions/artifact-2.3.2",
		"X-Custom":      "kept",
	} {
		if in.header.Get(name) != want {
			t.Errorf("header %s reached GitHub as %q, want %q", name, in.header.Get(name), want)
		}
	}
	for _, added := range []string{"X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto", "Forwarded", "Accept-Encoding"} {
		if v := in.header.Get(added); v != "" {
			t.Errorf("the interceptor added %s: %q", added, v)
		}
	}
	if !strings.HasPrefix(in.host, "example.com") {
		t.Errorf("Host reached GitHub as %q", in.host)
	}
	if resp.StatusCode != http.StatusCreated || resp.Header.Get("X-Upstream") != "github" {
		t.Fatalf("response status %d, X-Upstream %q", resp.StatusCode, resp.Header.Get("X-Upstream"))
	}
	if !bytes.Equal(got, responseBody) {
		t.Fatal("response body changed on the way back")
	}

	// A client that asks for gzip gets GitHub's encoded bytes, still encoded.
	download, err := http.NewRequestWithContext(t.Context(), http.MethodGet, cacheHostURL("/twirp/github.actions.results.api.v1.ArtifactService/GetSignedArtifactURL"), nil)
	if err != nil {
		t.Fatal(err)
	}
	download.Header.Set("Accept-Encoding", "gzip")
	resp, err = client.Do(download)
	if err != nil {
		t.Fatal(err)
	}
	got, _ = io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.Header.Get("Content-Encoding") != "gzip" || !bytes.Equal(got, gzipped.Bytes()) {
		t.Fatalf("gzip reply was re-encoded or decoded: Content-Encoding %q, %d bytes", resp.Header.Get("Content-Encoding"), len(got))
	}
	if seen[1].header.Get("Accept-Encoding") != "gzip" {
		t.Fatalf("Accept-Encoding reached GitHub as %q", seen[1].header.Get("Accept-Encoding"))
	}
}

func TestUpstreamTransportDoesNotNegotiateCompressionItself(t *testing.T) {
	r := &resolverLog{ips: map[string][]net.IP{testCacheHost: {net.ParseIP("127.0.0.1")}}}
	u, err := discoverUpstream(t.Context(), testCacheHost, r.lookupCNAME, r.lookupIP)
	if err != nil {
		t.Fatal(err)
	}
	if !u.Transport().DisableCompression {
		t.Fatal("the upstream transport would add Accept-Encoding and decode replies behind the client's back")
	}
}
