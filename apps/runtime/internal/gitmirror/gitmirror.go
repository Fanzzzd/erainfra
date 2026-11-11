// Package gitmirror makes a Firecracker job's checkout of its own repository
// fetch from GitHub only the objects GitHub has gained since the repository's
// last seed, with a stock actions/checkout and no workflow change.
//
// The guest's git reaches github.com through a proxy this package runs on
// loopback (an http.<url>.proxy setting the guest writes for https://github.com/
// only). The proxy terminates TLS for github.com with a leaf from a per-guest
// CA that is constrained to that one name, and looks at each request:
//
//   - A protocol v2 fetch of the job's own repository is answered from a bare
//     mirror inside the guest. Before answering, the mirror fetches the wanted
//     objects from GitHub with the client's own credential, sending everything
//     it already holds as "haves", so GitHub transfers only the delta and the
//     fetch succeeds only if that credential can read the repository now. The
//     client then receives exactly the pack GitHub would have sent: same
//     objects, same shallow boundary, no alternates and no extra refs in the
//     workspace.
//   - Everything else (ref listings, pushes, other repositories, LFS, any
//     request the mirror cannot answer in full) is forwarded to GitHub
//     unchanged.
//
// The mirror starts from a seed: a git bundle of the repository's branches and
// tags that the cache service keeps per repository and ref scope, under the
// same rules as the job cache (ADR 0007). When the job's seed is missing or
// stale, the guest refreshes the mirror from GitHub with the credential the
// job's own checkout presented, bundles it and saves it for later jobs.
//
// Every failure falls back to GitHub. A cache service that does not answer, a
// seed that does not import, an object GitHub will not give the mirror, an
// upload-pack that refuses the request: each sends the request to GitHub as
// if the mirror were not there. Nothing outlives the guest, so ADR 0002's rule
// that nothing writable survives a job holds; the seed lives in the cache
// service the job already reaches.
package gitmirror

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/cacheca"
)

// GitHubHost is the one host the proxy terminates TLS for.
const GitHubHost = "github.com"

const (
	// maxRequestBytes bounds how much of a fetch request the proxy holds to
	// parse it and, on fallback, replay it to GitHub. A fresh checkout's
	// request is a few hundred bytes; one carrying thousands of haves is still
	// far below this. A larger body streams to GitHub unread.
	maxRequestBytes = 8 << 20
	// defaultRefreshAfter is how old a seed may be before a writable job
	// refreshes it. A stale seed still works, it only leaves a larger delta.
	defaultRefreshAfter = 24 * time.Hour
	// defaultRestoreTimeout bounds downloading and importing a seed, which
	// the first fetch waits on. Past it the fetch goes to GitHub.
	defaultRestoreTimeout = 3 * time.Minute
	// defaultRefreshTimeout bounds a refresh, including a first, full clone.
	defaultRefreshTimeout = 20 * time.Minute
	// askRetry is how long the proxy waits before asking the cache service
	// again after it did not answer for this job, which is what it says
	// before the controller's job facts arrive.
	askRetry = 5 * time.Second
	// prewarmInterval is how often prewarm asks while the job facts are not
	// there yet.
	prewarmInterval = time.Second
)

// Config is what [Start] needs.
type Config struct {
	// Dir holds the mirror, the empty HOME its git runs with, and temporary
	// bundles. It should be on the guest's own disk and readable by root only.
	// Required.
	Dir string
	// Seeds is where seeds are read and saved. Required.
	Seeds SeedStore
	// Authority is the per-guest CA minted for GitHubHost. Required.
	Authority *cacheca.Authority
	// Git is the git binary. Defaults to "git" on PATH.
	Git string
	// GitHub is the upstream, https://github.com unless a test points it
	// elsewhere.
	GitHub *url.URL
	// Transport reaches GitHub. It must not use the guest's git proxy
	// setting (nothing in net/http reads git configuration, so any transport
	// qualifies). Nil defaults to a direct transport.
	Transport http.RoundTripper
	// ListenAddr is where the proxy listens. Defaults to 127.0.0.1:0.
	ListenAddr string
	// RefreshAfter overrides defaultRefreshAfter.
	RefreshAfter time.Duration
	// RestoreTimeout overrides defaultRestoreTimeout.
	RestoreTimeout time.Duration
	// RefreshTimeout overrides defaultRefreshTimeout.
	RefreshTimeout time.Duration
	// PrewarmFor is how long after Start the service keeps asking for the
	// job's seed so it is restored before the checkout asks. Zero turns
	// prewarming off, and the first fetch of the job's repository restores it.
	PrewarmFor time.Duration
	// Logf writes one line to the guest journal. Nil discards.
	Logf func(format string, args ...any)
	// Now is the clock. Nil is time.Now.
	Now func() time.Time
}

// Service is a running proxy and the mirror behind it.
type Service struct {
	config  Config
	mirror  *mirror
	github  *httputil.ReverseProxy
	tmpDir  string
	logf    func(string, ...any)
	proxyLn net.Listener
	fwdLn   net.Listener
	servers []*http.Server
	inner   *connListener
	errc    chan error

	// prepareMu serializes the first contact with the seed store and the
	// restore that follows it.
	prepareMu sync.Mutex
	// writeMu serializes everything that writes into the mirror, and a fetch
	// answered from the mirror holds it until the answer is sent (see
	// serveFromMirror). Fetches only ever try it: one that finds it held goes
	// to GitHub instead of waiting.
	writeMu sync.Mutex

	mu             sync.Mutex
	repository     string // the job's repository, once the seed store named it
	writable       bool
	seedFound      bool
	seedCreated    time.Time
	askedAt        time.Time // when the seed store last failed to answer
	prepared       bool      // the seed store answered for this job's repository
	ready          bool      // the mirror holds the repository's branches
	refreshStarted bool
	closing        bool
	// authorized remembers, briefly, credentials GitHub just let read a
	// repository; see authorizedFor.
	authorized map[string]time.Time
	// forwarded is which kinds of fetch argument have been logged as sending
	// a fetch to GitHub; see logForwarded.
	forwarded map[string]bool

	background    sync.WaitGroup
	bgCtx         context.Context
	bgCancel      context.CancelFunc
	prewarmCancel context.CancelFunc // nil when prewarming is off
}

// Start validates cfg, starts the proxy and returns once it is accepting
// connections. Point git at [Service.ProxyURL] for https://github.com/ only.
func Start(cfg Config) (*Service, error) {
	switch {
	case cfg.Dir == "":
		return nil, errors.New("gitmirror: a directory is required")
	case cfg.Seeds == nil:
		return nil, errors.New("gitmirror: a seed store is required")
	case cfg.Authority == nil:
		return nil, errors.New("gitmirror: an authority is required")
	}
	if cfg.Git == "" {
		cfg.Git = "git"
	}
	if cfg.GitHub == nil {
		cfg.GitHub = &url.URL{Scheme: "https", Host: GitHubHost}
	}
	if cfg.GitHub.Scheme != "https" || cfg.GitHub.Host == "" {
		return nil, fmt.Errorf("gitmirror: GitHub must be an https URL, got %q", cfg.GitHub)
	}
	if cfg.Transport == nil {
		cfg.Transport = DirectTransport()
	}
	if cfg.ListenAddr == "" {
		cfg.ListenAddr = "127.0.0.1:0"
	}
	if cfg.RefreshAfter <= 0 {
		cfg.RefreshAfter = defaultRefreshAfter
	}
	if cfg.RestoreTimeout <= 0 {
		cfg.RestoreTimeout = defaultRestoreTimeout
	}
	if cfg.RefreshTimeout <= 0 {
		cfg.RefreshTimeout = defaultRefreshTimeout
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	logf := cfg.Logf
	if logf == nil {
		logf = func(string, ...any) {}
	}
	leaf, err := tls.X509KeyPair(cfg.Authority.LeafCertPEM, cfg.Authority.LeafKeyPEM)
	if err != nil {
		return nil, fmt.Errorf("gitmirror: load leaf key pair: %w", err)
	}
	tmpDir := filepath.Join(cfg.Dir, "tmp")
	if err := os.MkdirAll(tmpDir, 0o700); err != nil {
		return nil, fmt.Errorf("gitmirror: create %s: %w", tmpDir, err)
	}

	target := *cfg.GitHub
	github := &httputil.ReverseProxy{
		Transport: cfg.Transport,
		// Pushes and packs stream; nothing is held in memory.
		FlushInterval: -1,
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(&target)
			// Exactly what the client sent, to the host it asked for, and no
			// X-Forwarded-*: GitHub must see the request git would have made.
			pr.Out.Host = target.Host
		},
	}

	bgCtx, bgCancel := context.WithCancel(context.Background())
	s := &Service{
		config: cfg,
		mirror: &mirror{
			git:  cfg.Git,
			dir:  filepath.Join(cfg.Dir, "mirror.git"),
			home: filepath.Join(cfg.Dir, "home"),
		},
		github:   github,
		tmpDir:   tmpDir,
		logf:     logf,
		errc:     make(chan error, 3),
		bgCtx:    bgCtx,
		bgCancel: bgCancel,
	}

	listen := net.ListenConfig{}
	s.proxyLn, err = listen.Listen(context.Background(), "tcp", cfg.ListenAddr)
	if err != nil {
		bgCancel()
		return nil, fmt.Errorf("gitmirror: listen: %w", err)
	}
	// The forwarder is how the mirror's own git reaches GitHub: plain HTTP on
	// loopback into the same transport as every forwarded request, so the
	// mirror's fetch shares the connection the client's ref listing just
	// opened instead of dialing GitHub again.
	s.fwdLn, err = listen.Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		_ = s.proxyLn.Close()
		bgCancel()
		return nil, fmt.Errorf("gitmirror: listen: %w", err)
	}
	s.inner = newConnListener(s.proxyLn.Addr())

	proxy := &connectProxy{
		host: GitHubHost + ":443",
		tls: &tls.Config{
			Certificates: []tls.Certificate{leaf},
			MinVersion:   tls.VersionTLS12,
			// Smart HTTP is HTTP/1.1; offering only that keeps the tunnel
			// simple without costing git anything.
			NextProtos: []string{"http/1.1"},
		},
		inner: s.inner,
		logf:  logf,
	}
	s.servers = []*http.Server{
		{Handler: proxy, ReadHeaderTimeout: 30 * time.Second},
		{Handler: http.HandlerFunc(s.serveGitHub), ReadHeaderTimeout: 30 * time.Second},
		{Handler: http.HandlerFunc(s.serveForward), ReadHeaderTimeout: 30 * time.Second},
	}
	go func() { s.errc <- s.servers[0].Serve(s.proxyLn) }()
	go func() { s.errc <- s.servers[1].Serve(s.inner) }()
	go func() { s.errc <- s.servers[2].Serve(s.fwdLn) }()
	if cfg.PrewarmFor > 0 {
		var prewarmCtx context.Context
		prewarmCtx, s.prewarmCancel = context.WithCancel(bgCtx)
		s.background.Add(1)
		go s.prewarm(prewarmCtx)
	}
	return s, nil
}

// ProxyURL is the value of git's http.https://github.com/.proxy.
func (s *Service) ProxyURL() string { return "http://" + s.proxyLn.Addr().String() }

// GitConfig is the configuration that sends git's https://github.com/ traffic
// through the proxy at proxyURL, trusting the CAs in caFile and caDir there.
// Every key is scoped to that URL, so git's traffic to every other host, and
// every other program, is untouched. caFile should hold the system roots as
// well as the per-guest CA, so that a git that bypasses the proxy (a job that
// sets no_proxy, say) still verifies the real github.com. caDir holds the
// per-guest CA alone, under the name [caPathName] gives it, so that a job that
// replaces caFile with GIT_SSL_CAINFO still trusts the proxy.
func GitConfig(proxyURL, caFile, caDir string) string {
	return "[http \"https://" + GitHubHost + "/\"]\n" +
		"\tproxy = " + proxyURL + "\n" +
		"\tsslCAInfo = " + caFile + "\n" +
		"\tsslCAPath = " + caDir + "\n"
}

// Wait returns when any of the proxy's servers stops, with the reason. A
// caller that pointed git at the proxy removes that setting when this returns,
// so git never keeps dialing a proxy that is gone.
func (s *Service) Wait() error { return <-s.errc }

// Close stops serving, then gives an in-flight seed save until ctx is done to
// finish before cancelling it.
func (s *Service) Close(ctx context.Context) error {
	s.mu.Lock()
	// No refresh starts once closing begins, so the wait below cannot race a
	// late Add.
	s.closing = true
	s.mu.Unlock()
	// A prewarm still waiting for the job facts has nothing left to do.
	if s.prewarmCancel != nil {
		s.prewarmCancel()
	}

	var errs []error
	// The proxy goes first, so no new client request arrives. The forwarder
	// stays up until the save is done: the refresh fetches through it.
	for _, server := range s.servers[:2] {
		if err := server.Shutdown(ctx); err != nil && !errors.Is(err, ctx.Err()) {
			errs = append(errs, err)
		}
	}
	_ = s.inner.Close()
	_ = s.proxyLn.Close()

	done := make(chan struct{})
	go func() { s.background.Wait(); close(done) }()
	select {
	case <-done:
	case <-ctx.Done():
		s.logf("git mirror: the seed save did not finish before the guest stopped; later jobs keep the older seed")
	}
	s.bgCancel()
	<-done
	if err := s.servers[2].Close(); err != nil {
		errs = append(errs, err)
	}
	return errors.Join(errs...)
}

// DirectTransport reaches GitHub without any proxy and passes bodies through
// as they are: no Accept-Encoding added, nothing decoded.
func DirectTransport() *http.Transport {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.DisableCompression = true
	return transport
}
