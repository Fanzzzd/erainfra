package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Fanzzzd/erainfra/apps/infra-agent/internal/oplog"
)

// Defaults for Config's zero values.
const (
	DefaultPoll                  = time.Second
	DefaultResponseHeaderTimeout = 120 * time.Second
	defaultReadHeaderTimeout     = 10 * time.Second
	defaultIdleTimeout           = 120 * time.Second
	defaultDialTimeout           = 5 * time.Second
)

// Config is one gateway proxy.
type Config struct {
	// Zones are the domains whose first-level labels are routed: `web.example.com` with zone
	// `example.com` routes label `web`. Deeper names (`a.web.example.com`) are not routed, the
	// same rule Cloudflare's free wildcard certificate imposes.
	Zones []string
	// RoutesFile is the table the Infra Agent writes.
	RoutesFile string
	// Poll is how often RoutesFile is checked for a new revision. Default 1 s.
	Poll time.Duration
	// ResponseHeaderTimeout bounds the wait for an App's response headers. Default 120 s, above
	// Cloudflare's 100-second proxy read timeout, so the edge's own 524 decides first. Bodies and
	// upgraded connections have no deadline: they stream for as long as both ends keep them open.
	ResponseHeaderTimeout time.Duration
	// Logf receives operator-facing messages. Default oplog.Printf, which logs through log/slog.
	Logf func(format string, args ...any)
}

type loaded struct {
	revision string
	routes   map[string]string // label -> loopback upstream; "" = known App, no reachable Node
}

// Proxy is the gateway's http.Handler. It is safe for concurrent use; Reload swaps the table
// atomically, so a request uses one table from start to finish.
type Proxy struct {
	cfg       Config
	zones     []string
	table     atomic.Pointer[loaded]
	transport *http.Transport
	rp        *httputil.ReverseProxy

	mu       sync.Mutex
	lastErr  string
	warnedAt time.Time
}

type upstreamKey struct{}

// New builds a Proxy with no table loaded; it answers 503 until Reload succeeds once.
func New(cfg Config) (*Proxy, error) {
	if cfg.Poll <= 0 {
		cfg.Poll = DefaultPoll
	}
	if cfg.ResponseHeaderTimeout <= 0 {
		cfg.ResponseHeaderTimeout = DefaultResponseHeaderTimeout
	}
	if cfg.Logf == nil {
		cfg.Logf = oplog.Printf
	}
	p := &Proxy{cfg: cfg}
	for _, z := range cfg.Zones {
		z = strings.TrimSuffix(strings.ToLower(strings.TrimSpace(z)), ".")
		if z == "" || strings.HasPrefix(z, ".") || strings.ContainsAny(z, "/:*") {
			return nil, errors.New("gateway zones must be domain names such as example.com")
		}
		p.zones = append(p.zones, z)
	}
	if len(p.zones) == 0 {
		return nil, errors.New("gateway needs at least one zone")
	}
	p.transport = &http.Transport{
		// Upstreams are loopback mesh links; an HTTP(S)_PROXY in the environment must not apply.
		Proxy:                 nil,
		DialContext:           (&net.Dialer{Timeout: defaultDialTimeout, KeepAlive: 30 * time.Second}).DialContext,
		MaxIdleConns:          256,
		MaxIdleConnsPerHost:   32,
		IdleConnTimeout:       90 * time.Second,
		ResponseHeaderTimeout: cfg.ResponseHeaderTimeout,
		ExpectContinueTimeout: time.Second,
		// Pass the App's encoding through untouched.
		DisableCompression: true,
	}
	p.rp = &httputil.ReverseProxy{
		Rewrite:   p.rewrite,
		Transport: p.transport,
		// Flush every write: server-sent events and long downloads reach the client as the App
		// produces them. Upgraded connections (WebSocket) are copied raw by ReverseProxy.
		FlushInterval: -1,
		ErrorHandler:  p.upstreamError,
		ErrorLog:      log.New(logWriter{p.cfg.Logf}, "", 0),
	}
	return p, nil
}

// rewrite builds the outbound request. ReverseProxy has already removed hop-by-hop headers
// (Connection and every header it names, Keep-Alive, Proxy-*, TE, Trailer, Transfer-Encoding,
// Upgrade except on an upgrade request) and the inbound X-Forwarded-* and Forwarded headers.
func (p *Proxy) rewrite(pr *httputil.ProxyRequest) {
	upstream, _ := pr.In.Context().Value(upstreamKey{}).(string)
	pr.SetURL(&url.URL{Scheme: "http", Host: upstream})
	// The App sees the public name it was asked for, not the loopback link address.
	pr.Out.Host = pr.In.Host
	// cloudflared is the only intended client and it sends Cloudflare's chain; append the hop
	// that reached this proxy, as a proxy in a chain does.
	if xff := pr.In.Header.Values("X-Forwarded-For"); len(xff) > 0 {
		pr.Out.Header["X-Forwarded-For"] = xff
	}
	pr.SetXForwarded()
	// TLS ends at Cloudflare. cloudflared reports the visitor's scheme; anything else is not a
	// scheme, and with no header the caller reached this loopback port directly over plain HTTP.
	proto := "http"
	if pr.In.Header.Get("X-Forwarded-Proto") == "https" {
		proto = "https"
	}
	pr.Out.Header.Set("X-Forwarded-Proto", proto)
}

func (p *Proxy) upstreamError(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, context.Canceled) && r.Context().Err() != nil {
		return // the client went away
	}
	p.warn("gateway: %s: upstream failed: %v", r.Host, err)
	status := http.StatusBadGateway
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		status = http.StatusGatewayTimeout
	}
	http.Error(w, http.StatusText(status), status)
}

// warn rate-limits upstream failures to one line every ten seconds, so a dead App behind a busy
// route does not flood the journal.
func (p *Proxy) warn(format string, args ...any) {
	p.mu.Lock()
	now := time.Now()
	if now.Sub(p.warnedAt) < 10*time.Second {
		p.mu.Unlock()
		return
	}
	p.warnedAt = now
	p.mu.Unlock()
	p.cfg.Logf(format, args...)
}

// label returns the routed label of host, or "" if host is not a first-level name in a zone.
func (p *Proxy) label(host string) string {
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	host = strings.TrimSuffix(strings.ToLower(host), ".")
	for _, z := range p.zones {
		if l, ok := strings.CutSuffix(host, "."+z); ok && ValidLabel(l) {
			return l
		}
	}
	return ""
}

func (p *Proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	label := p.label(r.Host)
	t := p.table.Load()
	if label == "" {
		if r.URL.Path == "/healthz" {
			p.health(w, t)
			return
		}
		http.NotFound(w, r)
		return
	}
	if t == nil {
		http.Error(w, "gateway has no route table yet", http.StatusServiceUnavailable)
		return
	}
	upstream, ok := t.routes[label]
	if !ok {
		http.NotFound(w, r)
		return
	}
	if upstream == "" {
		http.Error(w, "no reachable Node serves this App right now", http.StatusServiceUnavailable)
		return
	}
	p.rp.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), upstreamKey{}, upstream)))
}

// health answers a local check (`curl -H 'Host: localhost' 127.0.0.1:<port>/healthz`). Names in
// a zone always go to the App, so an App's own /healthz is never shadowed.
func (p *Proxy) health(w http.ResponseWriter, t *loaded) {
	w.Header().Set("Content-Type", "application/json")
	if t == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "no route table yet"})
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "revision": t.revision, "routes": len(t.routes)})
}

// Reload reads RoutesFile and swaps in its table if its revision is new. A file that is missing
// or invalid leaves the last table in place.
func (p *Proxy) Reload() (changed bool, err error) {
	t, err := ReadTable(p.cfg.RoutesFile)
	if err != nil {
		return false, err
	}
	current := p.table.Load()
	if current != nil && current.revision == t.Revision {
		return false, nil
	}
	next := &loaded{revision: t.Revision, routes: map[string]string{}}
	for _, r := range t.Routes {
		if r.Upstream == nil {
			next.routes[r.Host] = ""
		} else {
			next.routes[r.Host] = *r.Upstream
		}
	}
	p.table.Store(next)
	// A link that moved to another Node keeps its loopback port, so pooled connections would
	// still be the old link's streams. Drop the idle ones; requests in flight finish as they are.
	p.transport.CloseIdleConnections()
	return true, nil
}

// Watch reloads the table every Poll until ctx ends.
func (p *Proxy) Watch(ctx context.Context) {
	ticker := time.NewTicker(p.cfg.Poll)
	defer ticker.Stop()
	for {
		p.reloadAndLog()
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (p *Proxy) reloadAndLog() {
	changed, err := p.Reload()
	p.mu.Lock()
	defer p.mu.Unlock()
	if err != nil {
		msg := err.Error()
		if msg != p.lastErr {
			p.lastErr = msg
			if p.table.Load() == nil {
				p.cfg.Logf("gateway: no route table loaded yet (%v); answering 503", err)
			} else {
				p.cfg.Logf("gateway: keeping route table %s: %v", short(p.table.Load().revision), err)
			}
		}
		return
	}
	p.lastErr = ""
	if changed {
		t := p.table.Load()
		p.cfg.Logf("gateway: serving route table %s (%d routes)", short(t.revision), len(t.routes))
	}
}

func short(r string) string {
	if len(r) > 12 {
		return r[:12]
	}
	return r
}

// Server returns the http.Server for a Proxy. There is no read or write deadline, so large
// uploads, downloads and WebSockets are not cut off; ReadHeaderTimeout bounds a client that
// never finishes its headers and IdleTimeout reaps idle keep-alive connections.
func (p *Proxy) Server() *http.Server {
	return &http.Server{
		Handler:           p,
		ReadHeaderTimeout: defaultReadHeaderTimeout,
		IdleTimeout:       defaultIdleTimeout,
		MaxHeaderBytes:    1 << 20,
		ErrorLog:          log.New(logWriter{p.cfg.Logf}, "", 0),
	}
}

// logWriter feeds net/http's ErrorLog, which takes a *log.Logger, into Logf. It is the one use
// of the standard log package left in the gateway: net/http accepts nothing else.
type logWriter struct{ logf func(string, ...any) }

func (l logWriter) Write(b []byte) (int, error) {
	l.logf("gateway: %s", strings.TrimRight(string(b), "\n"))
	return len(b), nil
}

// CheckListen refuses a listen address that is not loopback: cloudflared runs on the same host,
// and nothing else should reach the proxy.
func CheckListen(addr string) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return err
	}
	if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
		return errors.New("the gateway listens on a loopback IP only (for example 127.0.0.1:61090); cloudflared on the same host connects to it")
	}
	return nil
}

// Run serves until ctx ends, then shuts down gracefully for up to 10 seconds. Upgraded
// connections are not tracked by Shutdown and close when the process exits.
func Run(ctx context.Context, listen string, cfg Config) error {
	if err := CheckListen(listen); err != nil {
		return err
	}
	p, err := New(cfg)
	if err != nil {
		return err
	}
	ln, err := (&net.ListenConfig{}).Listen(ctx, "tcp", listen)
	if err != nil {
		return err
	}
	srv := p.Server()
	watchCtx, stopWatch := context.WithCancel(ctx)
	defer stopWatch()
	go p.Watch(watchCtx)
	errc := make(chan error, 1)
	go func() { errc <- srv.Serve(ln) }()
	p.cfg.Logf("gateway: listening on %s for %s, routes from %s", ln.Addr(), strings.Join(p.zones, ", "), cfg.RoutesFile)
	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	shutdown, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdown)
	return nil
}
