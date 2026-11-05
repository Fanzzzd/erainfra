package gateway

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Fanzzzd/erainfra/apps/infra-agent/internal/gateway/gatewaytest"
)

func ptr(s string) *string { return &s }

// harness runs a Proxy on a real loopback listener, as cloudflared would reach it.
type harness struct {
	t      *testing.T
	proxy  *Proxy
	addr   string
	routes string
	logs   *logs
}

type logs struct {
	mu    sync.Mutex
	lines []string
}

func (l *logs) logf(format string, args ...any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.lines = append(l.lines, fmt.Sprintf(format, args...))
}

func (l *logs) has(substr string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, line := range l.lines {
		if strings.Contains(line, substr) {
			return true
		}
	}
	return false
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	h := &harness{t: t, routes: filepath.Join(t.TempDir(), "routes.json"), logs: &logs{}}
	p, err := New(Config{Zones: []string{"example.test"}, RoutesFile: h.routes, Poll: 20 * time.Millisecond, Logf: h.logs.logf})
	if err != nil {
		t.Fatal(err)
	}
	h.proxy = p
	ln, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := p.Server()
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })
	h.addr = ln.Addr().String()
	return h
}

func (h *harness) write(revision string, routes ...Route) {
	h.t.Helper()
	if err := WriteTable(h.routes, Table{V: 1, Revision: revision, Gateway: true, Routes: routes}); err != nil {
		h.t.Fatal(err)
	}
	if _, err := h.proxy.Reload(); err != nil {
		h.t.Fatal(err)
	}
}

func (h *harness) do(host, method, path string, body io.Reader, header http.Header) *http.Response {
	h.t.Helper()
	req, err := http.NewRequestWithContext(h.t.Context(), method, "http://"+h.addr+path, body)
	if err != nil {
		h.t.Fatal(err)
	}
	req.Host = host
	for k, v := range header {
		req.Header[k] = v
	}
	resp, err := (&http.Client{Transport: &http.Transport{Proxy: nil, DisableCompression: true}}).Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	h.t.Cleanup(func() { _ = resp.Body.Close() })
	return resp
}

func upstream(t *testing.T, handler http.Handler) string {
	t.Helper()
	s := httptest.NewServer(handler)
	t.Cleanup(s.Close)
	return strings.TrimPrefix(s.URL, "http://")
}

func body(t *testing.T, r *http.Response) string {
	t.Helper()
	b, err := io.ReadAll(r.Body)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// Each label reaches its own upstream, with the public Host, the forwarding headers and no
// hop-by-hop headers in either direction.
func TestRoutesByHostAndRewritesHeaders(t *testing.T) {
	h := newHarness(t)
	seen := make(chan http.Header, 1)
	web := upstream(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hdr := r.Header.Clone()
		hdr.Set("X-Seen-Host", r.Host)
		seen <- hdr
		w.Header().Set("Connection", "X-Upstream-Secret")
		w.Header().Set("X-Upstream-Secret", "1")
		w.Header().Set("Keep-Alive", "timeout=5")
		_, _ = io.WriteString(w, "web "+r.URL.RequestURI())
	}))
	api := upstream(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "api")
	}))
	h.write("r1", Route{Host: "web", Upstream: ptr(web)}, Route{Host: "api", Upstream: ptr(api)})

	resp := h.do("Web.Example.Test.:443", http.MethodGet, "/a/b?c=d", nil, http.Header{
		"Connection":          {"X-Client-Secret"},
		"X-Client-Secret":     {"1"},
		"Proxy-Authorization": {"Basic Zm9vOmJhcg=="},
		"X-Forwarded-For":     {"203.0.113.9"},
		"X-Forwarded-Proto":   {"https"},
		"X-Forwarded-Host":    {"spoofed.example"},
		"Cf-Connecting-Ip":    {"203.0.113.9"},
	})
	if got := body(t, resp); resp.StatusCode != 200 || got != "web /a/b?c=d" {
		t.Fatalf("web: %d %q", resp.StatusCode, got)
	}
	if resp.Header.Get("X-Upstream-Secret") != "" || resp.Header.Get("Keep-Alive") != "" {
		t.Fatalf("hop-by-hop response headers leaked: %v", resp.Header)
	}
	in := <-seen
	want := map[string]string{
		"X-Seen-Host":       "Web.Example.Test.:443",
		"X-Forwarded-For":   "203.0.113.9, 127.0.0.1",
		"X-Forwarded-Proto": "https",
		"X-Forwarded-Host":  "Web.Example.Test.:443",
		"Cf-Connecting-Ip":  "203.0.113.9",
	}
	for k, v := range want {
		if got := strings.Join(in.Values(k), ", "); got != v {
			t.Errorf("%s = %q, want %q", k, got, v)
		}
	}
	for _, k := range []string{"X-Client-Secret", "Proxy-Authorization"} {
		if in.Get(k) != "" {
			t.Errorf("hop-by-hop request header %s reached the App", k)
		}
	}
	if got := body(t, h.do("api.example.test", http.MethodGet, "/", nil, nil)); got != "api" {
		t.Fatalf("api: %q", got)
	}
	// With no header from cloudflared, the scheme is the plain HTTP this hop used.
	_ = body(t, h.do("web.example.test", http.MethodGet, "/", nil, http.Header{"X-Forwarded-Proto": {"gopher"}}))
	if in := <-seen; in.Get("X-Forwarded-Proto") != "http" || in.Get("X-Forwarded-For") != "127.0.0.1" {
		t.Fatalf("forwarded headers without cloudflared: %v", in)
	}
}

func TestUnknownHostsAre404AndUnreachableAppsAre503(t *testing.T) {
	h := newHarness(t)
	if r := h.do("web.example.test", http.MethodGet, "/", nil, nil); r.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("before any table: %d", r.StatusCode)
	}
	if r := h.do("localhost", http.MethodGet, "/healthz", nil, nil); r.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("health before any table: %d", r.StatusCode)
	}
	web := upstream(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, "web") }))
	h.write("r1", Route{Host: "web", Upstream: ptr(web)}, Route{Host: "down", Upstream: nil})
	for _, host := range []string{"nope.example.test", "a.web.example.test", "example.test", "web.example.test.evil.test", "web.other.test", "127.0.0.1", "", "web"} {
		if r := h.do(host, http.MethodGet, "/", nil, nil); r.StatusCode != http.StatusNotFound {
			t.Errorf("host %q: %d, want 404", host, r.StatusCode)
		}
	}
	if r := h.do("down.example.test", http.MethodGet, "/", nil, nil); r.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("route with no upstream: %d", r.StatusCode)
	}
	r := h.do("localhost", http.MethodGet, "/healthz", nil, nil)
	var health struct {
		OK       bool   `json:"ok"`
		Revision string `json:"revision"`
		Routes   int    `json:"routes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&health); err != nil || !health.OK || health.Revision != "r1" || health.Routes != 2 {
		t.Fatalf("health %+v %v", health, err)
	}
	// An App's own /healthz is not shadowed.
	if got := body(t, h.do("web.example.test", http.MethodGet, "/healthz", nil, nil)); got != "web" {
		t.Fatalf("app healthz: %q", got)
	}
}

// A 64 MiB upload and download pass through without being held in memory: the App sees the
// first bytes of the upload while the client is still sending, and the client sees the first
// bytes of the download while the App is still writing.
func TestStreamsLargeBodiesBothWays(t *testing.T) {
	h := newHarness(t)
	const size = 64 << 20
	firstUp := make(chan struct{})
	release := make(chan struct{})
	app := upstream(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPut:
			sum := sha256.New()
			buf := make([]byte, 1<<20)
			n, err := io.ReadFull(r.Body, buf)
			if err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
			sum.Write(buf[:n])
			close(firstUp)
			rest, err := io.Copy(sum, r.Body)
			if err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
			_, _ = fmt.Fprintf(w, "%d %s", int64(n)+rest, hex.EncodeToString(sum.Sum(nil)))
		case http.MethodGet:
			chunk := bytes.Repeat([]byte("x"), 1<<20)
			_, _ = w.Write(chunk)
			http.NewResponseController(w).Flush() //nolint:errcheck // a test App
			<-release
			for range size/len(chunk) - 1 {
				if _, err := w.Write(chunk); err != nil {
					return
				}
			}
		}
	}))
	h.write("r1", Route{Host: "big", Upstream: ptr(app)})

	pr, pw := io.Pipe()
	want := sha256.New()
	go func() {
		chunk := bytes.Repeat([]byte("y"), 1<<20)
		for i := range size / len(chunk) {
			if i == 2 {
				// Hold the rest of the upload until the App has the first megabyte.
				select {
				case <-firstUp:
				case <-time.After(20 * time.Second):
					pw.CloseWithError(fmt.Errorf("the App did not see the upload start: the proxy buffers request bodies"))
					return
				}
			}
			want.Write(chunk)
			if _, err := pw.Write(chunk); err != nil {
				return
			}
		}
		_ = pw.Close()
	}()
	resp := h.do("big.example.test", http.MethodPut, "/", pr, nil)
	got := body(t, resp)
	if resp.StatusCode != 200 || got != fmt.Sprintf("%d %s", size, hex.EncodeToString(want.Sum(nil))) {
		t.Fatalf("upload: %d %q", resp.StatusCode, got)
	}

	resp = h.do("big.example.test", http.MethodGet, "/", nil, nil)
	first := make([]byte, 1<<20)
	done := make(chan error, 1)
	go func() { _, err := io.ReadFull(resp.Body, first); done <- err }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("the client did not see the download start: the proxy buffers responses")
	}
	close(release)
	n, err := io.Copy(io.Discard, resp.Body)
	if err != nil || n+int64(len(first)) != size {
		t.Fatalf("download: %d bytes, %v", n+int64(len(first)), err)
	}
}

func TestWebSocketRoundTrip(t *testing.T) {
	h := newHarness(t)
	h.write("r1", Route{Host: "chat", Upstream: ptr(upstream(t, gatewaytest.EchoWebSocket("echo:")))})
	got, err := gatewaytest.RoundTrip(t.Context(), h.addr, "chat.example.test", "hello")
	if err != nil || got != "echo:chat.example.test hello" {
		t.Fatalf("round trip: %q %v", got, err)
	}
	// An upgrade for an unknown host is refused like any request.
	if _, err := gatewaytest.RoundTrip(t.Context(), h.addr, "nope.example.test", "x"); err == nil || !strings.Contains(err.Error(), "404") {
		t.Fatalf("unknown host upgrade: %v", err)
	}
}

// A new revision in the file is served within a poll, and a missing or corrupt file keeps the
// last table: the proxy serves its last copy while Convex (and so the Infra Agent) is away.
func TestWatchPicksUpRouteChangesAndKeepsTheLastCopy(t *testing.T) {
	h := newHarness(t)
	one := upstream(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, "one") }))
	two := upstream(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, "two") }))
	if err := WriteTable(h.routes, Table{V: 1, Revision: "r1", Gateway: true, Routes: []Route{{Host: "web", Upstream: ptr(one)}}}); err != nil {
		t.Fatal(err)
	}
	go h.proxy.Watch(t.Context())
	eventually := func(want string) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for {
			r := h.do("web.example.test", http.MethodGet, "/", nil, nil)
			if got := body(t, r); got == want {
				return
			}
			if time.Now().After(deadline) {
				t.Fatalf("never served %q", want)
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
	eventually("one")
	if err := WriteTable(h.routes, Table{V: 1, Revision: "r2", Gateway: true, Routes: []Route{{Host: "web", Upstream: ptr(two)}}}); err != nil {
		t.Fatal(err)
	}
	eventually("two")

	if err := os.WriteFile(h.routes, []byte("{not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	eventually("two")
	if err := os.Remove(h.routes); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	eventually("two")
	for !h.logs.has("keeping route table r2") {
		time.Sleep(10 * time.Millisecond)
	}

	// A restarted proxy starts from the file on disk.
	if err := WriteTable(h.routes, Table{V: 1, Revision: "r2", Gateway: true, Routes: []Route{{Host: "web", Upstream: ptr(two)}}}); err != nil {
		t.Fatal(err)
	}
	restarted := newHarness(t)
	restarted.proxy.cfg.RoutesFile = h.routes
	if _, err := restarted.proxy.Reload(); err != nil {
		t.Fatal(err)
	}
	if got := body(t, restarted.do("web.example.test", http.MethodGet, "/", nil, nil)); got != "two" {
		t.Fatalf("restarted proxy served %q", got)
	}
}

func TestTableRefusesWhatTheProxyMustNotDial(t *testing.T) {
	bad := []Table{
		{V: 2, Gateway: true},
		{V: 1, Gateway: true, Routes: []Route{{Host: "web", Upstream: ptr("10.0.0.5:80")}}},
		{V: 1, Gateway: true, Routes: []Route{{Host: "web", Upstream: ptr("example.com:80")}}},
		{V: 1, Gateway: true, Routes: []Route{{Host: "Web", Upstream: ptr("127.0.0.1:80")}}},
		{V: 1, Gateway: true, Routes: []Route{{Host: "a.b", Upstream: nil}}},
		{V: 1, Gateway: true, Routes: []Route{{Host: "web"}, {Host: "web"}}},
		{V: 1, Gateway: false, Routes: []Route{{Host: "web"}}},
	}
	for _, tb := range bad {
		if tb.Validate() == nil {
			t.Errorf("accepted %+v", tb)
		}
	}
	for _, addr := range []string{"0.0.0.0:61090", "192.0.2.1:61090", ":61090", "localhost:61090"} {
		if CheckListen(addr) == nil {
			t.Errorf("listen %s accepted", addr)
		}
	}
	for _, addr := range []string{"127.0.0.1:61090", "[::1]:61090"} {
		if err := CheckListen(addr); err != nil {
			t.Errorf("listen %s: %v", addr, err)
		}
	}
}
