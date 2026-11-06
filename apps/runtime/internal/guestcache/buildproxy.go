package guestcache

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// The build cache proxy gives build tools that are not actions/cache clients a
// way into EraInfra's cache service: turbo's remote cache and the
// erainfra-gocacheprog helper behind Go's GOCACHEPROG.
//
// It listens on guest loopback with plain HTTP and presents the runner bearer
// on the job's behalf, the same bearer the actions/cache interceptor presents.
// So the job's environment carries no credential: TURBO_TOKEN is a fixed
// placeholder, and what the job can do through the proxy is exactly what it
// can already do through the interceptor, decided by the cache service from
// the runner's facts (a fork pull request reads and does not write).
//
// Both clients fail open. turbo through the degraded answers below, which
// keep it to one warning line in the job log; the Go helper on its own.
//
// The proxy sends exactly one credential anywhere: the runner bearer, to the
// cache service. A token the workflow set itself is never forwarded, to the
// cache service or to anyone else (see ServeHTTP). And it answers only the
// job's own processes: a request that names another host or comes from a
// browser is refused (see admit).

// TurboToken is the TURBO_TOKEN the job is handed. It is not a credential and
// the proxy never forwards it. It only tells the proxy apart from a token the
// workflow set itself, which the proxy refuses (see ServeHTTP).
const TurboToken = "erainfra-build-cache"

// TurboTeam is the TURBO_TEAM the job is handed. turbo enables its remote
// cache only when a team is set; the cache service ignores it, because the
// repository comes from the runner's facts.
const TurboTeam = "erainfra"

// buildArchHeader matches the cache service's server.BuildArchHeader.
const buildArchHeader = "X-Erainfra-Build-Arch"

// buildCooldown is how long the proxy answers locally after the cache service
// failed to answer at all, rather than making every request wait out a dial
// timeout against a service that is down.
const buildCooldown = 30 * time.Second

// Header budgets. A read is a lookup the service bounds at its own
// ERAINFRA_CACHE_LOOKUP_TIMEOUT (5s by default), so 30s is a service that is
// stuck. A write answers only once the body is in the store, which the service
// bounds at ERAINFRA_CACHE_TRANSFER_TIMEOUT (30m by default).
const (
	buildReadHeaderBudget  = 30 * time.Second
	buildWriteHeaderBudget = 30 * time.Minute
)

// BuildProxyConfig is what the guest daemon knows when it starts the proxy.
type BuildProxyConfig struct {
	// CacheServiceURL is EraInfra's cache service. Required.
	CacheServiceURL string
	// RunnerToken is the runner-auth bearer the host minted. Required.
	RunnerToken string
	// ListenAddr is where the proxy listens. Defaults to 127.0.0.1:0.
	ListenAddr string
	// Arch is the CPU architecture build outputs are filed under. Defaults to
	// this binary's GOARCH, which in a guest is the guest's.
	Arch string
	// Transport reaches the cache service. Nil defaults to a plain transport
	// with a short dial timeout.
	Transport http.RoundTripper
	// Logf receives one line per state change. Nil discards.
	Logf func(format string, args ...any)
	// Now is the clock for the cooldown. Nil is time.Now.
	Now func() time.Time
}

// BuildProxy is a running build cache proxy.
type BuildProxy struct {
	server   *http.Server
	listener net.Listener
	handler  *buildProxy
}

type buildProxy struct {
	cache     *url.URL
	token     string
	arch      string
	transport http.RoundTripper
	logf      func(format string, args ...any)
	// host is the proxy's own host:port as Env advertises it, the only Host
	// header it answers.
	host string
	now       func() time.Time

	// readOnly is set by the first write the service refuses with 403: this
	// job's facts do not grant write, and asking again changes nothing.
	readOnly atomic.Bool

	mu        sync.Mutex
	downUntil time.Time
	logged    map[string]bool
}

// StartBuildProxy serves the proxy. The returned proxy is already accepting
// connections.
func StartBuildProxy(cfg BuildProxyConfig) (*BuildProxy, error) {
	switch {
	case cfg.CacheServiceURL == "":
		return nil, errors.New("guestcache: a cache service URL is required")
	case cfg.RunnerToken == "":
		return nil, errors.New("guestcache: a runner token is required")
	}
	cache, err := url.Parse(cfg.CacheServiceURL)
	if err != nil || (cache.Scheme != "http" && cache.Scheme != "https") || cache.Host == "" {
		return nil, fmt.Errorf("guestcache: cache service URL %q is not an http(s) URL", cfg.CacheServiceURL)
	}
	arch := cfg.Arch
	if arch == "" {
		arch = runtime.GOARCH
	}
	logf := cfg.Logf
	if logf == nil {
		logf = func(string, ...any) {}
	}
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	transport := cfg.Transport
	if transport == nil {
		transport = buildTransport()
	}
	handler := &buildProxy{
		cache:     cache,
		token:     cfg.RunnerToken,
		arch:      arch,
		transport: transport,
		logf:      logf,
		now:       now,
		logged:    map[string]bool{},
	}
	addr := cfg.ListenAddr
	if addr == "" {
		addr = "127.0.0.1:0"
	}
	listener, err := (&net.ListenConfig{}).Listen(context.Background(), "tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("guestcache: listen for the build cache proxy: %w", err)
	}
	handler.host = listener.Addr().String()
	server := &http.Server{
		Handler: handler,
		// Loopback faces the job's own processes; a connection that sends no
		// request should still not be held forever.
		ReadHeaderTimeout: 30 * time.Second,
	}
	go func() { _ = server.Serve(listener) }()
	return &BuildProxy{server: server, listener: listener, handler: handler}, nil
}

// URL is the proxy's base URL.
func (p *BuildProxy) URL() string { return "http://" + p.listener.Addr().String() }

// Env is what the runner's environment carries while the proxy is up. turbo
// reads the three TURBO_ variables and enables its remote cache with no
// workflow change. ERAINFRA_BUILD_CACHE_URL is where erainfra-gocacheprog
// finds the proxy; the helper itself is opt-in, through GOCACHEPROG.
//
// A workflow that sets any of these in its own env keeps its value, because a
// step's env overrides the runner's. turbo.json is another matter: turbo
// (measured on 2.10.9 with `turbo config`) ranks environment variables and its
// global config file above turbo.json's remoteCache block, so this TURBO_API
// shadows a remoteCache.apiUrl the repository names there. The guest cannot
// read turbo.json when it builds this environment, before the job has checked
// anything out, and the global config file is no lower in turbo's order. So a
// repository with its own remote cache sets TURBO_API in its workflow, and
// until it does, the proxy refuses its token rather than send it anywhere
// (ServeHTTP).
func (p *BuildProxy) Env() []string {
	return []string{
		"TURBO_API=" + p.URL(),
		"TURBO_TOKEN=" + TurboToken,
		"TURBO_TEAM=" + TurboTeam,
		"ERAINFRA_BUILD_CACHE_URL=" + p.URL(),
	}
}

// Close stops the proxy.
func (p *BuildProxy) Close(ctx context.Context) error {
	err := p.server.Shutdown(ctx)
	if closeErr := p.listener.Close(); closeErr != nil && !errors.Is(closeErr, net.ErrClosed) {
		err = errors.Join(err, closeErr)
	}
	return err
}

func buildTransport() *http.Transport {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	// The cache service is on the operator's network. A dial that takes longer
	// than this is a service that is not there, and every build step that
	// waits on it is a step the cache made slower.
	transport.DialContext = (&net.Dialer{Timeout: 3 * time.Second, KeepAlive: 30 * time.Second}).DialContext
	transport.TLSHandshakeTimeout = 5 * time.Second
	transport.MaxIdleConnsPerHost = 32
	return transport
}

func (p *buildProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !p.admit(w, r) {
		return
	}
	switch {
	case r.URL.Path == "/v8/artifacts/events":
		// Analytics the cache service drops anyway; answering here saves a
		// round trip at the end of every run, whatever token it carries.
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(http.StatusOK)
	case strings.HasPrefix(r.URL.Path, "/v8/"):
		// A workflow that set its own TURBO_TOKEN still has our TURBO_API
		// unless it set that too, so its requests arrive here. Where it meant
		// them to go is not in the request: Vercel, turbo's default, or a
		// server named in turbo.json, which our TURBO_API outranks (see Env).
		// Sending the token to a guess could hand a credential to a host the
		// workflow never named, so it goes nowhere.
		if auth := r.Header.Get("Authorization"); auth != "" && auth != "Bearer "+TurboToken {
			p.refuseForeignToken(w, r)
			return
		}
		p.serveTurbo(w, r)
	case strings.HasPrefix(r.URL.Path, "/go/"):
		p.serveGo(w, r)
	default:
		http.NotFound(w, r)
	}
}

// admit refuses a request that did not come from the job's own build tools.
// Loopback is reachable from a browser the job runs (an end-to-end test's
// Chromium, say), and a page that rebinds its own DNS name to 127.0.0.1 can
// send requests here that would read and write the repository's cache under
// the runner bearer. Such a request names the page's host in Host, and a
// browser marks what it sends with Sec-Fetch-Site and, cross-origin, Origin.
// turbo and the Go helper send Host as Env advertises it and neither header.
func (p *buildProxy) admit(w http.ResponseWriter, r *http.Request) bool {
	switch {
	case !strings.EqualFold(r.Host, p.host):
		p.logOnce("foreign-host", "build cache proxy: refused a request for host %q; it answers only %s", r.Host, p.host)
	case r.Header.Get("Origin") != "" || r.Header.Get("Sec-Fetch-Site") != "":
		p.logOnce("browser", "build cache proxy: refused a request from a browser (Origin %q)", r.Header.Get("Origin"))
	default:
		return true
	}
	writeJSONBody(w, http.StatusForbidden, `{"message":"the build cache proxy answers only the job's own build tools"}`)
	return false
}

// foreignTokenMessage is what the job log and the guest journal say when turbo
// presents a token the workflow set.
const foreignTokenMessage = "this TURBO_TOKEN is not EraInfra's and is not forwarded; set TURBO_API to your own remote cache"

// refuseForeignToken answers a request that carries the workflow's own
// TURBO_TOKEN without sending it anywhere. The status check gets a 401, which
// turbo 2.10.9 prints once as "Remote caching unavailable (Authentication
// failed — check TURBO_TOKEN ...)", so the job log points at the token the
// workflow set, which is the cause. Everything else gets the disabled-cache
// answers: turbo builds uncached and prints nothing more.
func (p *buildProxy) refuseForeignToken(w http.ResponseWriter, r *http.Request) {
	p.logOnce("foreign-token", "build cache proxy: turbo presented a TURBO_TOKEN the workflow set, which the proxy does not forward; "+
		"turbo runs without a remote cache. To use the workflow's own remote cache, set TURBO_API to it in the workflow's env "+
		"(TURBO_API=https://vercel.com/api for Vercel)")
	if r.URL.Path == "/v8/artifacts/status" {
		writeJSONBody(w, http.StatusUnauthorized, `{"code":"forbidden","message":"`+foreignTokenMessage+`",`+
			`"error":{"code":"forbidden","message":"`+foreignTokenMessage+`"}}`)
		return
	}
	p.degradeTurbo(w, r)
}

func (p *buildProxy) serveTurbo(w http.ResponseWriter, r *http.Request) {
	write := r.Method == http.MethodPut
	switch {
	case write && p.readOnly.Load():
		p.dropWrite(w, r)
		return
	case p.down():
		p.degradeTurbo(w, r)
		return
	}
	response, err := p.forward(r, "/_erainfra-build/turbo"+r.URL.Path)
	if err != nil {
		p.markDown(err)
		p.degradeTurbo(w, r)
		return
	}
	defer response.Body.Close() //nolint:errcheck // read-only body; a close error loses nothing
	switch {
	case write && response.StatusCode == http.StatusForbidden:
		// turbo has no answer for "read but do not write": a 403 it prints as a
		// Vercel permissions warning on every upload, and the one code it does
		// act on (remote_caching_disabled) also stops its reads for the rest of
		// the run (turborepo-cache multiplexer.rs, v2.10.9). So the refusal is
		// recorded here once and every upload from this job is dropped, which
		// is what the cache service would do with them anyway.
		p.readOnly.Store(true)
		p.logOnce("read-only", "build cache proxy: this job may read the cache but not write to it (a fork pull request); turbo uploads are skipped")
		drain(response.Body)
		p.dropWrite(w, r)
	case write && response.StatusCode >= http.StatusInternalServerError:
		// An upload the cache service accepted but could not store. Unlike a
		// fork's refusal, this job's outputs were meant to be saved and were
		// not, so turbo hears the failure and prints a warning for that task;
		// a 202 would tell it the artifact is cached when it is not. The
		// service counts it under outcome "error".
		p.logOnce("upload-failed", "build cache proxy: the cache service could not store a turbo upload (%d); turbo warns once per failed upload", response.StatusCode)
		copyResponse(w, response)
	case response.StatusCode == http.StatusUnauthorized || response.StatusCode >= http.StatusInternalServerError:
		// 401 is the service not knowing this runner yet (the controller's
		// facts have not arrived), never the job's TURBO_TOKEN, so turbo's
		// "check TURBO_TOKEN" advice would mislead. A 5xx here is a read the
		// store failed. Both are answered as a cache that is not there, for this
		// request.
		p.logOnce(fmt.Sprintf("status-%d", response.StatusCode),
			"build cache proxy: the cache service answered %d; turbo builds this uncached", response.StatusCode)
		drain(response.Body)
		p.degradeTurbo(w, r)
	default:
		copyResponse(w, response)
	}
}

// degradeTurbo answers turbo as a cache that is switched off. Measured against
// turbo 2.10.9, this is what keeps it to a single "Remote caching unavailable"
// line: a "disabled" status, a 404 for every read and an accepted upload print
// nothing more, while a 5xx prints one warning per task.
func (p *buildProxy) degradeTurbo(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.URL.Path == "/v8/artifacts/status":
		writeJSONBody(w, http.StatusOK, `{"status":"disabled"}`)
	case r.Method == http.MethodPut:
		p.dropWrite(w, r)
	case r.Method == http.MethodPost && r.URL.Path == "/v8/artifacts":
		_, _ = io.Copy(io.Discard, io.LimitReader(r.Body, 1<<20))
		writeJSONBody(w, http.StatusOK, `{}`)
	default:
		writeJSONBody(w, http.StatusNotFound, `{"code":"not_found","message":"artifact not found"}`)
	}
}

// dropWrite accepts an upload without storing it. turbo never reads its own
// upload back, so to turbo this is a cache that evicted the entry at once.
func (p *buildProxy) dropWrite(w http.ResponseWriter, r *http.Request) {
	_, _ = io.Copy(io.Discard, r.Body)
	writeJSONBody(w, http.StatusAccepted, `{"urls":[]}`)
}

// serveGo passes the helper's requests through. The helper owns its own fail
// open, so a service that cannot be reached is a 502 it understands.
func (p *buildProxy) serveGo(w http.ResponseWriter, r *http.Request) {
	if p.down() {
		writeJSONBody(w, http.StatusBadGateway, `{"message":"the cache service is unreachable"}`)
		return
	}
	response, err := p.forward(r, "/_erainfra-build"+r.URL.Path)
	if err != nil {
		p.markDown(err)
		writeJSONBody(w, http.StatusBadGateway, `{"message":"the cache service is unreachable"}`)
		return
	}
	defer response.Body.Close() //nolint:errcheck // read-only body; a close error loses nothing
	copyResponse(w, response)
}

// forward sends a request to the cache service with the runner bearer and the
// guest's architecture in place of whatever the client sent.
func (p *buildProxy) forward(r *http.Request, path string) (*http.Response, error) {
	target := *p.cache
	target.Path = strings.TrimSuffix(p.cache.Path, "/") + path
	target.RawPath = ""
	target.RawQuery = r.URL.RawQuery

	// The header budget is a timer, not a context deadline, so a long download
	// is not cut off once its headers have arrived.
	ctx, cancel := context.WithCancel(r.Context())
	budget := buildReadHeaderBudget
	if r.Method == http.MethodPut {
		budget = buildWriteHeaderBudget
	}
	timer := time.AfterFunc(budget, cancel)

	out, err := http.NewRequestWithContext(ctx, r.Method, target.String(), r.Body)
	if err != nil {
		timer.Stop()
		cancel()
		return nil, err
	}
	out.ContentLength = r.ContentLength
	if r.ContentLength == 0 {
		out.Body = http.NoBody
	}
	out.Header = r.Header.Clone()
	for _, name := range hopHeaders {
		out.Header.Del(name)
	}
	out.Header.Set("Authorization", "Bearer "+p.token)
	out.Header.Set(buildArchHeader, p.arch)

	response, err := p.transport.RoundTrip(out)
	timer.Stop()
	if err != nil {
		cancel()
		return nil, err
	}
	p.markUp()
	response.Body = &cancelOnClose{ReadCloser: response.Body, cancel: cancel}
	return response, nil
}

func (p *buildProxy) down() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.now().Before(p.downUntil)
}

func (p *buildProxy) markDown(err error) {
	p.mu.Lock()
	wasUp := p.downUntil.IsZero()
	p.downUntil = p.now().Add(buildCooldown)
	p.mu.Unlock()
	if wasUp {
		p.logf("build cache proxy: the cache service is unreachable, builds run uncached until it answers: %v", err)
	}
}

func (p *buildProxy) markUp() {
	p.mu.Lock()
	wasDown := !p.downUntil.IsZero()
	p.downUntil = time.Time{}
	p.mu.Unlock()
	if wasDown {
		p.logf("build cache proxy: the cache service answers again")
	}
}

func (p *buildProxy) logOnce(key, format string, args ...any) {
	p.mu.Lock()
	seen := p.logged[key]
	p.logged[key] = true
	p.mu.Unlock()
	if !seen {
		p.logf(format, args...)
	}
}

// hopHeaders are the connection-scoped headers a proxy must not forward
// (RFC 9110 section 7.6.1), plus the two the proxy sets itself.
var hopHeaders = []string{
	"Connection", "Keep-Alive", "Proxy-Connection", "Proxy-Authenticate", "Proxy-Authorization",
	"Te", "Trailer", "Transfer-Encoding", "Upgrade",
	"Authorization", buildArchHeader,
}

func copyResponse(w http.ResponseWriter, response *http.Response) {
	for name, values := range response.Header {
		for _, value := range values {
			w.Header().Add(name, value)
		}
	}
	for _, name := range hopHeaders {
		w.Header().Del(name)
	}
	w.WriteHeader(response.StatusCode)
	_, _ = io.Copy(w, response.Body)
}

func writeJSONBody(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, body)
}

func drain(body io.Reader) { _, _ = io.Copy(io.Discard, io.LimitReader(body, 1<<20)) }

// cancelOnClose releases a forwarded request's context once its body is done.
type cancelOnClose struct {
	io.ReadCloser
	cancel context.CancelFunc
}

func (c *cancelOnClose) Close() error {
	err := c.ReadCloser.Close()
	c.cancel()
	return err
}
