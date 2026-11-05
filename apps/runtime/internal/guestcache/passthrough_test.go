package guestcache

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

const artifactPath = "/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact"

// seenRequest is what the stand-in for GitHub received, and what happened
// when it read the request and wrote its reply.
type seenRequest struct {
	method, path, rawQuery, host string
	header                       http.Header
	body                         []byte
	readErr                      error
	written                      int
	writeErr                     error
}

func (s seenRequest) String() string {
	return fmt.Sprintf("%s %s: read %d bytes (err %v), wrote %d bytes (err %v)",
		s.method, s.path, len(s.body), s.readErr, s.written, s.writeErr)
}

// passthrough is an interceptor in front of a stand-in for GitHub, reached
// through the same Upstream transport the guest uses in production.
type passthrough struct {
	client       *http.Client
	requestBody  []byte
	responseBody []byte
	gzipped      []byte

	mu   sync.Mutex
	seen []seenRequest
}

func (p *passthrough) requests() []seenRequest {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]seenRequest(nil), p.seen...)
}

// newPassthrough builds the fixture. wrap, if set, wraps the transport the
// interceptor forwards through; it may change timing, never bytes.
func newPassthrough(t *testing.T, wrap func(http.RoundTripper) http.RoundTripper) *passthrough {
	t.Helper()
	p := &passthrough{requestBody: make([]byte, 1<<20), responseBody: make([]byte, 1<<20)}
	if _, err := rand.Read(p.requestBody); err != nil {
		t.Fatal(err)
	}
	if _, err := rand.Read(p.responseBody); err != nil {
		t.Fatal(err)
	}
	var gzipped bytes.Buffer
	gz := gzip.NewWriter(&gzipped)
	if _, err := gz.Write(p.responseBody); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	p.gzipped = gzipped.Bytes()

	github := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen := seenRequest{method: r.Method, path: r.URL.Path, rawQuery: r.URL.RawQuery, host: r.Host, header: r.Header.Clone()}
		seen.body, seen.readErr = io.ReadAll(r.Body)
		w.Header().Set("X-Upstream", "github")
		w.Header().Set("Content-Type", "application/octet-stream")
		reply := p.responseBody
		if r.Header.Get("Accept-Encoding") == "gzip" {
			w.Header().Set("Content-Encoding", "gzip")
			reply = p.gzipped
		}
		w.WriteHeader(http.StatusCreated)
		seen.written, seen.writeErr = w.Write(reply)
		p.mu.Lock()
		p.seen = append(p.seen, seen)
		p.mu.Unlock()
	}))
	t.Cleanup(github.Close)
	cacheService := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Error("a non-cache request reached the cache service")
	}))
	t.Cleanup(cacheService.Close)

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
	var forward http.RoundTripper = transport
	if wrap != nil {
		forward = wrap(transport)
	}

	var caPEM []byte
	ic, err := Start(Config{
		CacheServiceURL:    cacheService.URL,
		RunnerToken:        "erainfra-cache-runner-v1.payload.signature",
		GitHubURL:          "https://example.com:" + port,
		GitHubTransport:    forward,
		InstallTrustAnchor: func(pem []byte) error { caPEM = pem; return nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ic.Close(context.Background()) })
	p.client = clientThrough(t, ic, caPEM)
	// The test client must not ask for gzip on its own either, or it could not
	// tell the interceptor adding Accept-Encoding from itself doing so.
	p.client.Transport.(*http.Transport).DisableCompression = true
	return p
}

// upload sends the 1 MiB artifact request and reads the whole reply, keeping
// every error and length so a failure says where the bytes stopped.
func (p *passthrough) upload(ctx context.Context) (*http.Response, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, cacheHostURL(artifactPath+"?attempt=1&x=%2F"), bytes.NewReader(p.requestBody))
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("Authorization", "Bearer guest-github-token")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "@actions/artifact-2.3.2")
	req.Header.Set("X-Custom", "kept")
	resp, err := p.client.Do(req)
	if err != nil {
		return nil, nil, fmt.Errorf("send: %w", err)
	}
	got, readErr := io.ReadAll(resp.Body)
	if closeErr := resp.Body.Close(); readErr == nil {
		readErr = closeErr
	}
	if readErr != nil {
		return resp, got, fmt.Errorf("read reply: %d of %d bytes: %w", len(got), len(p.responseBody), readErr)
	}
	return resp, got, nil
}

// Everything on the cache host except the CacheService path is GitHub's to
// answer, Artifacts v4 above all: upload-artifact and download-artifact v4+
// call ArtifactService on this same host. The interceptor must hand those
// requests and their replies through unchanged, through the same Upstream
// transport the guest uses in production.
func TestNonCacheTrafficPassesThroughByteForByte(t *testing.T) {
	// The watch changes no byte and no timing; it records the transport's
	// read past the body's end, so a failure says whether that read is what
	// closed the upstream connection.
	tails := &tailLog{}
	p := newPassthrough(t, func(inner http.RoundTripper) http.RoundTripper {
		return watchingTransport{inner: inner, log: tails}
	})

	resp, got, err := p.upload(t.Context())
	if err != nil {
		t.Fatalf("upload: %v; github: %v; %v", err, p.requests(), tails)
	}
	if bad := tails.failures(); len(bad) > 0 {
		t.Fatalf("the forward's final body read failed, which closes the upstream connection: %v", bad)
	}
	seen := p.requests()
	if len(seen) != 1 {
		t.Fatalf("github saw %d requests, want 1: %v", len(seen), seen)
	}
	in := seen[0]
	if in.readErr != nil || in.writeErr != nil || in.written != len(p.responseBody) {
		t.Fatalf("github side: %v", in)
	}
	if in.method != http.MethodPost || in.path != artifactPath || in.rawQuery != "attempt=1&x=%2F" {
		t.Fatalf("request line changed: %s %s?%s", in.method, in.path, in.rawQuery)
	}
	if !bytes.Equal(in.body, p.requestBody) {
		t.Fatalf("request body changed on the way to GitHub: %d of %d bytes", len(in.body), len(p.requestBody))
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
	if !bytes.Equal(got, p.responseBody) {
		t.Fatalf("response body changed on the way back: %d of %d bytes", len(got), len(p.responseBody))
	}

	// A client that asks for gzip gets GitHub's encoded bytes, still encoded.
	download, err := http.NewRequestWithContext(t.Context(), http.MethodGet, cacheHostURL("/twirp/github.actions.results.api.v1.ArtifactService/GetSignedArtifactURL"), nil)
	if err != nil {
		t.Fatal(err)
	}
	download.Header.Set("Accept-Encoding", "gzip")
	resp, err = p.client.Do(download)
	if err != nil {
		t.Fatal(err)
	}
	got, readErr := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if readErr != nil {
		t.Fatalf("read gzip reply: %d of %d bytes: %v; github: %v", len(got), len(p.gzipped), readErr, p.requests())
	}
	if resp.Header.Get("Content-Encoding") != "gzip" || !bytes.Equal(got, p.gzipped) {
		t.Fatalf("gzip reply was re-encoded or decoded: Content-Encoding %q, %d bytes", resp.Header.Get("Content-Encoding"), len(got))
	}
	if seen = p.requests(); seen[1].header.Get("Accept-Encoding") != "gzip" {
		t.Fatalf("Accept-Encoding reached GitHub as %q", seen[1].header.Get("Accept-Encoding"))
	}
}

// tailWatch wraps the body the forwarding transport reads and records the
// result of every read it makes after the body's last byte. net/http's
// transport makes one such read to confirm a Content-Length body has ended,
// and an error there makes it close the upstream connection. If gate is set,
// that read is held until the gate opens; every byte is forwarded unchanged
// either way.
type tailWatch struct {
	body      io.ReadCloser
	remaining int64
	gate      <-chan struct{}
	waited    bool
	log       *tailLog
}

func (w *tailWatch) Read(b []byte) (int, error) {
	if w.remaining == 0 && w.gate != nil && !w.waited {
		w.waited = true
		select {
		case <-w.gate:
		case <-time.After(5 * time.Second):
		}
	}
	atTail := w.remaining == 0
	n, err := w.body.Read(b)
	w.remaining -= int64(n)
	if atTail {
		w.log.add(n, err)
	}
	return n, err
}

func (w *tailWatch) Close() error { return w.body.Close() }

// tailLog collects what the transport's after-the-end reads returned.
type tailLog struct {
	mu    sync.Mutex
	reads []string
	bad   []error
}

func (l *tailLog) add(n int, err error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.reads = append(l.reads, fmt.Sprintf("%d bytes, %v", n, err))
	if err != nil && !errors.Is(err, io.EOF) {
		l.bad = append(l.bad, err)
	}
}

func (l *tailLog) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return fmt.Sprintf("transport's reads past the request body's end: %q", l.reads)
}

func (l *tailLog) failures() []error {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]error(nil), l.bad...)
}

// openOnSecondRead opens the gate on the reply body's second read. By then the
// interceptor has written the first chunk of the reply to the client.
type openOnSecondRead struct {
	io.ReadCloser
	reads int
	open  func()
}

func (o *openOnSecondRead) Read(b []byte) (int, error) {
	o.reads++
	if o.reads == 2 {
		o.open()
	}
	return o.ReadCloser.Read(b)
}

// watchingTransport puts a tailWatch on every forwarded request body. With
// gated set, the after-the-end read waits until the reply's first chunk has
// gone to the client.
type watchingTransport struct {
	inner http.RoundTripper
	log   *tailLog
	gated bool
}

func (w watchingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.Body == nil || req.ContentLength <= 0 {
		return w.inner.RoundTrip(req)
	}
	watch := &tailWatch{body: req.Body, remaining: req.ContentLength, log: w.log}
	var open func()
	if w.gated {
		gate := make(chan struct{})
		var once sync.Once
		watch.gate = gate
		open = func() { once.Do(func() { close(gate) }) }
	}
	req.Body = watch
	resp, err := w.inner.RoundTrip(req)
	if err != nil || open == nil {
		return resp, err
	}
	resp.Body = &openOnSecondRead{ReadCloser: resp.Body, open: open}
	return resp, nil
}

// GitHub may answer as soon as it has the last byte of a request, before
// net/http's forwarding transport has made its final read to confirm the body
// ended. Writing the first byte of that answer to the client makes the
// interceptor's own HTTP/1.1 server finish the request body and close it, so
// the transport's final read fails with "invalid Read on closed Body". The
// transport then treats the request as failed and closes the connection the
// answer is still streaming over, and the client gets a truncated artifact
// reply. This test forces that order; on an unloaded machine it is rare, and
// it is what CI run 42014199223 hit.
func TestReplyCompletesWhenGitHubAnswersBeforeTheBodyIsConfirmedEnded(t *testing.T) {
	tails := &tailLog{}
	p := newPassthrough(t, func(inner http.RoundTripper) http.RoundTripper {
		return watchingTransport{inner: inner, log: tails, gated: true}
	})

	resp, got, err := p.upload(t.Context())
	if err != nil {
		t.Fatalf("upload: %v; github: %v; %v", err, p.requests(), tails)
	}
	if bad := tails.failures(); len(bad) > 0 {
		t.Fatalf("the forward's final body read failed, which closes the upstream connection: %v", bad)
	}
	if resp.StatusCode != http.StatusCreated || !bytes.Equal(got, p.responseBody) {
		t.Fatalf("reply: status %d, %d of %d bytes, equal %v", resp.StatusCode, len(got), len(p.responseBody), bytes.Equal(got, p.responseBody))
	}
	seen := p.requests()
	if len(seen) != 1 || !bytes.Equal(seen[0].body, p.requestBody) || seen[0].writeErr != nil {
		t.Fatalf("github side: %v", seen)
	}
}

// Many uploads at once over separate client connections, each 1 MiB each way:
// load and interleaving, not a forced order.
func TestConcurrentArtifactTrafficPassesThroughIntact(t *testing.T) {
	p := newPassthrough(t, nil)
	const uploads = 16
	errs := make(chan error, uploads)
	var wg sync.WaitGroup
	for range uploads {
		wg.Go(func() {
			resp, got, err := p.upload(t.Context())
			switch {
			case err != nil:
				errs <- err
			case resp.StatusCode != http.StatusCreated:
				errs <- fmt.Errorf("status %d", resp.StatusCode)
			case !bytes.Equal(got, p.responseBody):
				errs <- fmt.Errorf("reply changed: %d of %d bytes", len(got), len(p.responseBody))
			}
		})
	}
	wg.Wait()
	close(errs)
	var all []error
	for err := range errs {
		all = append(all, err)
	}
	if err := errors.Join(all...); err != nil {
		t.Fatalf("%d of %d uploads failed: %v", len(all), uploads, err)
	}
	for _, seen := range p.requests() {
		if !bytes.Equal(seen.body, p.requestBody) || seen.readErr != nil || seen.writeErr != nil {
			t.Fatalf("github side: %v", seen)
		}
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
