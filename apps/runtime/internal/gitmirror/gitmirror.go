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
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
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

// repositoryPath matches a smart HTTP upload-pack request:
// /<owner>/<name>[.git]/git-upload-pack.
var repositoryPath = regexp.MustCompile(`^/([A-Za-z0-9][A-Za-z0-9-]*)/([A-Za-z0-9._-]+?)(?:\.git)?/git-upload-pack$`)

// forwardPath is what the forwarder serves: the two endpoints a git fetch
// over smart HTTP uses, and nothing else.
var forwardPath = regexp.MustCompile(`^/[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+/(?:info/refs|git-upload-pack)$`)

func uploadPackRepository(path string) (string, bool) {
	match := repositoryPath.FindStringSubmatch(path)
	if match == nil {
		return "", false
	}
	return match[1] + "/" + match[2], true
}

// serveForward is the mirror's own route to GitHub.
func (s *Service) serveForward(w http.ResponseWriter, r *http.Request) {
	if !forwardPath.MatchString(r.URL.Path) {
		http.Error(w, "the git mirror forwarder only fetches", http.StatusForbidden)
		return
	}
	_ = http.NewResponseController(w).EnableFullDuplex()
	s.github.ServeHTTP(w, r)
}

// serveGitHub handles one request git sent to github.com through the tunnel.
func (s *Service) serveGitHub(w http.ResponseWriter, r *http.Request) {
	// The same full-duplex reason as the cache interceptor's: a reply that
	// starts before the request body is read to its end must not end it.
	_ = http.NewResponseController(w).EnableFullDuplex()
	if repository, ok := refsRepository(r); ok {
		// Forwarded as it is. A ref advertisement GitHub just granted this
		// credential is the same proof authorize would ask GitHub for, so it
		// is remembered and the fetch that follows saves a round trip.
		status := &statusWriter{ResponseWriter: w}
		s.github.ServeHTTP(status, r)
		if status.code == http.StatusOK &&
			status.Header().Get("Content-Type") == "application/x-git-upload-pack-advertisement" {
			s.rememberAuthorized(repository, r.Header.Get("Authorization"))
		}
		return
	}
	repository, ok := uploadPackRepository(r.URL.Path)
	if !ok || r.Method != http.MethodPost || !strings.Contains(r.Header.Get("Git-Protocol"), "version=2") {
		s.github.ServeHTTP(w, r)
		return
	}

	raw, complete, err := readBounded(r.Body, maxRequestBytes)
	if err != nil {
		http.Error(w, "git request unreadable", http.StatusBadGateway)
		return
	}
	if !complete {
		s.forward(w, r, io.MultiReader(bytes.NewReader(raw), r.Body), -1)
		return
	}
	authorization := r.Header.Get("Authorization")
	served := false
	if body, err := decodeBody(r.Header.Get("Content-Encoding"), raw); err == nil {
		if request, err := parseRequest(body); err == nil && request.command == "fetch" && len(request.wants) > 0 {
			if request.unsupported == "" {
				served = s.serveFromMirror(w, r, repository, authorization, request, body)
			} else {
				s.logForwarded(repository, request.unsupported)
			}
		}
	}
	if !served {
		s.forward(w, r, bytes.NewReader(raw), int64(len(raw)))
	}
	s.maybeRefresh(repository, authorization)
}

// forward sends a request to GitHub with the given body.
func (s *Service) forward(w http.ResponseWriter, r *http.Request, body io.Reader, length int64) {
	out := r.Clone(r.Context())
	out.Body = io.NopCloser(body)
	out.ContentLength = length
	s.github.ServeHTTP(w, out)
}

// serveFromMirror answers a fetch from the mirror, or reports false having
// written nothing, which sends the request to GitHub.
//
// It holds writeMu from the mirror's fetch to the end of the answer. Another
// fetch's depth-limited fetch into the mirror rewrites its shallow boundary,
// and an upload-pack reading the mirror while that happens could cut a
// whole-history answer short. A fetch that finds the mirror busy, with a
// background refresh or with another fetch, goes to GitHub at once rather than
// wait: a refresh of a large repository runs for many minutes.
func (s *Service) serveFromMirror(
	w http.ResponseWriter, r *http.Request, repository, authorization string, request fetchRequest, body []byte,
) bool {
	if request.includeTag && request.depth > 0 && request.depth < infiniteDepth {
		// Following tags needs the tags brought in line with GitHub's, which
		// git refuses on the shallow mirror this fetch would leave (see
		// below). A clone --depth that follows tags goes to GitHub;
		// actions/checkout passes --no-tags.
		s.logForwarded(repository, "include-tag with deepen")
		return false
	}
	if !s.prepare(r.Context(), repository) {
		return false
	}
	ctx := r.Context()
	if err := s.authorize(ctx, repository, authorization); err != nil {
		s.logf("git mirror: GitHub did not let this client read %s, passing its fetch to GitHub: %v", repository, err)
		return false
	}
	if !s.writeMu.TryLock() {
		s.logf("git mirror: the mirror of %s is busy (a seed refresh or another fetch), fetching from GitHub directly", repository)
		return false
	}
	defer s.writeMu.Unlock()

	// A fetch without a depth completes without asking GitHub for a wanted
	// object the mirror already holds, so for those GitHub is asked here. A
	// depth-limited fetch names every want to GitHub, which refuses one it no
	// longer serves.
	var held []string
	if request.depth == 0 {
		absent, err := s.mirror.missing(ctx, request.wants)
		if err != nil {
			s.logf("git mirror: could not read the mirror of %s, fetching from GitHub directly: %v", repository, err)
			return false
		}
		held = without(request.wants, absent)
	}
	if err := s.mirror.fetchObjects(ctx, s.upstream(repository), authorization, request.wants, request.depth); err != nil {
		s.logf("git mirror: GitHub did not give the mirror %s's wanted objects, fetching from GitHub directly: %v", repository, err)
		return false
	}
	if len(held) > 0 {
		if err := s.confirmServed(ctx, repository, authorization, held); err != nil {
			s.logf("git mirror: GitHub does not serve every object this fetch of %s wants, fetching from GitHub directly: %v", repository, err)
			return false
		}
	}
	// The client's shallow commits as well as its wants: upload-pack ignores a
	// shallow commit it does not hold, and would then leave the client's
	// boundary where it was.
	needed := append(append([]string(nil), request.wants...), request.shallows...)
	if missing, err := s.mirror.missing(ctx, needed); err != nil || len(missing) > 0 {
		s.logf("git mirror: the mirror lacks %d wanted or shallow objects of %s, fetching from GitHub directly", len(missing), repository)
		return false
	}
	if request.includeTag {
		if s.mirror.shallow() {
			// Bringing the tags in line on a shallow mirror would need new
			// shallow boundaries, which git refuses.
			s.logf("git mirror: a depth-limited fetch of %s follows tags, fetching from GitHub directly", repository)
			return false
		}
		if err := s.mirror.syncTags(ctx, s.upstream(repository), authorization); err != nil {
			s.logf("git mirror: could not bring %s's tags in line with GitHub, fetching from GitHub directly: %v", repository, err)
			return false
		}
	}
	err := s.mirror.uploadPack(ctx, body, func() io.Writer {
		header := w.Header()
		header.Set("Content-Type", "application/x-git-upload-pack-result")
		header.Set("Cache-Control", "no-cache, max-age=0, must-revalidate")
		w.WriteHeader(http.StatusOK)
		return flushWriter{w}
	})
	if errors.Is(err, errNoAnswer) {
		s.logf("git mirror: upload-pack refused a fetch of %s, fetching from GitHub directly: %v", repository, err)
		return false
	}
	if err != nil {
		// The response had begun; git sees a truncated pack and fails this
		// fetch. Nothing can be taken back at this point.
		s.logf("git mirror: serving %s stopped part way: %v", repository, err)
	}
	return true
}

// logForwarded notes, once per kind of argument, that fetches carrying it go
// to GitHub because the mirror does not reproduce it exactly.
func (s *Service) logForwarded(repository, line string) {
	kind, _, _ := strings.Cut(line, " ")
	s.mu.Lock()
	if s.forwarded == nil {
		s.forwarded = map[string]bool{}
	}
	seen := s.forwarded[kind]
	s.forwarded[kind] = true
	s.mu.Unlock()
	if !seen {
		s.logf("git mirror: fetches of %s that send %q go to GitHub directly; the mirror cannot answer them exactly", repository, line)
	}
}

func without(values, remove []string) []string {
	var kept []string
	for _, value := range values {
		if !slices.Contains(remove, value) {
			kept = append(kept, value)
		}
	}
	return kept
}

// confirmServed asks GitHub whether it serves every object in oids to this
// client now, with a fetch that wants each one and says it already has each
// one. GitHub answers that with an empty pack, or refuses it with "not our
// ref" for an object it does not have: a commit purged after a sensitive-data
// removal, say, or one from an earlier repository of the same name. Only the
// start of the answer is needed, because upload-pack checks every want before
// it begins the packfile section.
func (s *Service) confirmServed(ctx context.Context, repository, authorization string, oids []string) error {
	var body bytes.Buffer
	writePkt := func(line string) { fmt.Fprintf(&body, "%04x%s\n", len(line)+5, line) }
	writePkt("command=fetch")
	writePkt("agent=git/erainfra-git-mirror")
	writePkt("object-format=sha1")
	body.WriteString("0001")
	writePkt("no-progress")
	for _, oid := range oids {
		writePkt("want " + oid)
	}
	for _, oid := range oids {
		writePkt("have " + oid)
	}
	writePkt("done")
	body.WriteString("0000")

	target := *s.config.GitHub
	target.Path = "/" + repository + "/git-upload-pack"
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, target.String(), &body)
	if err != nil {
		return err
	}
	if authorization != "" {
		request.Header.Set("Authorization", authorization)
	}
	request.Header.Set("Git-Protocol", "version=2")
	request.Header.Set("Content-Type", "application/x-git-upload-pack-request")
	request.Header.Set("Accept", "application/x-git-upload-pack-result")
	request.Header.Set("User-Agent", "git/erainfra-git-mirror")
	response, err := s.config.Transport.RoundTrip(request)
	if err != nil {
		return err
	}
	defer response.Body.Close() //nolint:errcheck // the first line is the answer
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("GitHub answered %d", response.StatusCode)
	}
	line, err := readPktLine(response.Body)
	if err != nil {
		return err
	}
	if line != "packfile" {
		return fmt.Errorf("GitHub answered %q", line)
	}
	// The empty pack that follows is a few dozen bytes; reading it lets the
	// connection be reused.
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 1<<20))
	return nil
}

// readPktLine reads one pkt-line and returns its payload without the newline.
func readPktLine(reader io.Reader) (string, error) {
	var header [4]byte
	if _, err := io.ReadFull(reader, header[:]); err != nil {
		return "", fmt.Errorf("read a pkt-line: %w", err)
	}
	length, err := strconv.ParseUint(string(header[:]), 16, 16)
	if err != nil {
		return "", fmt.Errorf("read a pkt-line: length %q", header[:])
	}
	if length < 4 {
		return "", fmt.Errorf("GitHub answered the special packet %04x", length)
	}
	payload := make([]byte, length-4)
	if _, err := io.ReadFull(reader, payload); err != nil {
		return "", fmt.Errorf("read a pkt-line: %w", err)
	}
	return strings.TrimSuffix(string(payload), "\n"), nil
}

// authorize asks GitHub whether this client's credential can read repository
// now, with the same ref advertisement request git opens every fetch with.
// It is separate from the mirror's own fetch because that fetch cannot be
// relied on to ask: when every wanted object is already in the mirror, git
// completes a fetch by object name without contacting the remote at all. So
// without this, a client GitHub would refuse could read whatever the seed
// holds.
func (s *Service) authorize(ctx context.Context, repository, authorization string) error {
	if s.recentlyAuthorized(repository, authorization) {
		return nil
	}
	target := *s.config.GitHub
	target.Path = "/" + repository + "/info/refs"
	target.RawQuery = "service=git-upload-pack"
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return err
	}
	if authorization != "" {
		request.Header.Set("Authorization", authorization)
	}
	request.Header.Set("Git-Protocol", "version=2")
	request.Header.Set("User-Agent", "git/erainfra-git-mirror")
	response, err := s.config.Transport.RoundTrip(request)
	if err != nil {
		return err
	}
	defer response.Body.Close() //nolint:errcheck // only the status is read
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 1<<20))
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("GitHub answered %d", response.StatusCode)
	}
	if contentType := response.Header.Get("Content-Type"); contentType != "application/x-git-upload-pack-advertisement" {
		return fmt.Errorf("GitHub answered %q, not a ref advertisement", contentType)
	}
	s.rememberAuthorized(repository, authorization)
	return nil
}

// authorizedFor is how long a ref advertisement GitHub granted a credential
// stands in for asking again. It covers the fetches of one git command, which
// follow its ref listing within milliseconds; a credential GitHub has revoked
// stops working on the mirror at most this long after it stops working on
// GitHub.
const authorizedFor = time.Minute

func authorizationKey(repository, authorization string) string {
	digest := sha256.Sum256([]byte(authorization))
	return strings.ToLower(repository) + "\x00" + hex.EncodeToString(digest[:])
}

func (s *Service) rememberAuthorized(repository, authorization string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.authorized == nil {
		s.authorized = map[string]time.Time{}
	}
	now := s.config.Now()
	for key, at := range s.authorized {
		if now.Sub(at) >= authorizedFor {
			delete(s.authorized, key)
		}
	}
	s.authorized[authorizationKey(repository, authorization)] = now
}

func (s *Service) recentlyAuthorized(repository, authorization string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	at, ok := s.authorized[authorizationKey(repository, authorization)]
	return ok && s.config.Now().Sub(at) < authorizedFor
}

// refsPath matches the ref advertisement a smart HTTP fetch starts with.
var refsPath = regexp.MustCompile(`^/([A-Za-z0-9][A-Za-z0-9-]*)/([A-Za-z0-9._-]+?)(?:\.git)?/info/refs$`)

func refsRepository(r *http.Request) (string, bool) {
	if r.Method != http.MethodGet || r.URL.Query().Get("service") != "git-upload-pack" {
		return "", false
	}
	match := refsPath.FindStringSubmatch(r.URL.Path)
	if match == nil {
		return "", false
	}
	return match[1] + "/" + match[2], true
}

// statusWriter records the status a forwarded response was given.
type statusWriter struct {
	http.ResponseWriter
	code int
}

func (w *statusWriter) WriteHeader(code int) {
	// An informational 1xx the proxy relays is not the response's status.
	if w.code == 0 && code >= http.StatusOK {
		w.code = code
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Write(p []byte) (int, error) {
	if w.code == 0 {
		w.code = http.StatusOK
	}
	return w.ResponseWriter.Write(p)
}

func (w *statusWriter) Flush() {
	_ = http.NewResponseController(w.ResponseWriter).Flush()
}

func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// upstream is the URL the mirror's git fetches repository from.
func (s *Service) upstream(repository string) string {
	return "http://" + s.fwdLn.Addr().String() + "/" + repository
}

// prepare reports whether the mirror can serve repository. Usually prewarm
// has already restored the job's seed; if it has not, the first fetch asks.
func (s *Service) prepare(ctx context.Context, repository string) bool {
	if done, ready := s.preparedFor(repository); done {
		return ready
	}
	s.prepareMu.Lock()
	defer s.prepareMu.Unlock()
	if done, ready := s.preparedFor(repository); done {
		return ready
	}
	s.mu.Lock()
	recentlyAsked := !s.askedAt.IsZero() && s.config.Now().Sub(s.askedAt) < askRetry
	s.mu.Unlock()
	if recentlyAsked {
		return false
	}
	s.load(context.WithoutCancel(ctx))
	_, ready := s.preparedFor(repository)
	return ready
}

// preparedFor reports whether the seed store has answered (done) and, if so,
// whether the mirror holds repository's seed.
func (s *Service) preparedFor(repository string) (done, ready bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.prepared {
		return false, false
	}
	return true, s.ready && strings.EqualFold(s.repository, repository)
}

// load asks the seed store about this job and restores the seed it returns.
// The caller holds prepareMu. The job's repository comes from the store's
// answer, never from a request, so whatever a job asks git to fetch, the seed
// restored is its own repository's.
func (s *Service) load(ctx context.Context) {
	ctx, cancel := context.WithTimeout(ctx, s.config.RestoreTimeout)
	defer cancel()
	info, seed, err := s.config.Seeds.Open(ctx)
	s.mu.Lock()
	if err != nil {
		// Logged once: until the job facts arrive, every ask fails the same way.
		first := s.askedAt.IsZero()
		s.askedAt = s.config.Now()
		s.mu.Unlock()
		if first {
			s.logf("git mirror: the cache service has no answer for this job yet: %v", err)
		}
		return
	}
	s.repository, s.writable, s.seedFound, s.seedCreated = info.Repository, info.Writable, info.Found, info.Created
	s.prepared = true
	s.mu.Unlock()
	if !info.RefusedUntil.IsZero() {
		s.logf("git mirror: the cache service refused %s's last seed as too large; no job builds another before %s",
			info.Repository, info.RefusedUntil.UTC().Format(time.RFC3339))
	}
	if seed == nil {
		s.logf("git mirror: %s has no seed in this job's scope yet; its checkout goes to GitHub directly", info.Repository)
		return
	}

	started := s.config.Now()
	s.writeMu.Lock()
	err = s.restore(ctx, seed)
	s.writeMu.Unlock()
	if err != nil {
		s.logf("git mirror: the seed for %s did not import; its checkout goes to GitHub directly: %v", info.Repository, err)
		return
	}
	s.mu.Lock()
	s.ready = true
	s.mu.Unlock()
	s.logf("git mirror: restored %s's seed from %s in %s", info.Repository,
		info.Created.UTC().Format(time.RFC3339), s.config.Now().Sub(started).Round(time.Millisecond))
}

// prewarm restores the job's seed before anything asks for it, so the
// checkout does not wait on the download and import. The guest starts the
// proxy at claim, a few seconds before the runner reaches its first step; the
// controller's job facts usually arrive in that window, and until they do the
// cache service does not know the job, so this asks again every
// prewarmInterval for up to PrewarmFor.
func (s *Service) prewarm(ctx context.Context) {
	defer s.background.Done()
	deadline := s.config.Now().Add(s.config.PrewarmFor)
	for {
		s.prepareMu.Lock()
		if done, _ := s.preparedFor(""); !done {
			s.load(ctx)
		}
		done, _ := s.preparedFor("")
		s.prepareMu.Unlock()
		if done || !s.config.Now().Before(deadline) {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(prewarmInterval):
		}
	}
}

// restore writes the seed to a file and imports it into a fresh mirror. A
// failure removes the mirror so that a later refresh starts clean.
func (s *Service) restore(ctx context.Context, seed io.ReadCloser) error {
	defer seed.Close() //nolint:errcheck // read-only body; a close error loses nothing
	file, err := os.CreateTemp(s.tmpDir, "seed-*.bundle")
	if err != nil {
		return err
	}
	path := file.Name()
	defer os.Remove(path) //nolint:errcheck // a temporary file in a directory that dies with the guest
	if _, err := io.Copy(file, seed); err != nil {
		_ = file.Close()
		return fmt.Errorf("download the seed: %w", err)
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := s.freshMirror(ctx); err != nil {
		return err
	}
	if err := s.mirror.restore(ctx, path); err != nil {
		_ = os.RemoveAll(s.mirror.dir)
		return err
	}
	return nil
}

func (s *Service) freshMirror(ctx context.Context) error {
	if err := os.RemoveAll(s.mirror.dir); err != nil {
		return err
	}
	return s.mirror.create(ctx)
}

// maybeRefresh starts the one refresh a guest makes, after the job's first
// fetch of its own repository, when this job may save a seed and the seed it
// found is missing or old. It uses the credential that fetch presented: the
// job's own token, scoped by GitHub to this repository and this job. No other
// credential exists in the guest for it to use.
func (s *Service) maybeRefresh(repository, authorization string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch {
	case s.closing, s.refreshStarted, !s.prepared, !s.writable, !strings.EqualFold(s.repository, repository):
		return
	case s.seedFound && s.config.Now().Sub(s.seedCreated) < s.config.RefreshAfter:
		return
	}
	s.refreshStarted = true
	s.background.Add(1)
	go func() {
		defer s.background.Done()
		s.refresh(repository, authorization)
	}()
}

func (s *Service) refresh(repository, authorization string) {
	ctx, cancel := context.WithTimeout(s.bgCtx, s.config.RefreshTimeout)
	defer cancel()
	started := s.config.Now()

	s.mu.Lock()
	ready := s.ready
	s.mu.Unlock()
	file, err := os.CreateTemp(s.tmpDir, "refresh-*.bundle")
	if err != nil {
		s.logf("git mirror: refresh of %s could not start: %v", repository, err)
		return
	}
	path := file.Name()
	_ = file.Close()
	defer os.Remove(path) //nolint:errcheck // a temporary file in a directory that dies with the guest

	s.writeMu.Lock()
	err = func() error {
		if !ready {
			if err := s.freshMirror(ctx); err != nil {
				return err
			}
		}
		if err := s.mirror.refresh(ctx, s.upstream(repository), authorization); err != nil {
			return err
		}
		// git bundle create refuses to overwrite nothing; it writes path.
		_ = os.Remove(path)
		return s.mirror.bundle(ctx, path)
	}()
	s.writeMu.Unlock()
	if err != nil {
		s.logf("git mirror: refresh of %s failed; later jobs keep the older seed: %v", repository, err)
		return
	}
	s.mu.Lock()
	s.ready = true
	s.mu.Unlock()

	stat, err := os.Stat(path)
	if err != nil {
		s.logf("git mirror: refresh of %s wrote no bundle: %v", repository, err)
		return
	}
	if err := s.config.Seeds.Save(ctx, path); err != nil {
		s.logf("git mirror: saving %s's seed failed; later jobs keep the older seed: %v", repository, err)
		return
	}
	s.logf("git mirror: saved a %d-byte seed of %s in %s", stat.Size(), repository,
		s.config.Now().Sub(started).Round(time.Millisecond))
}

// readBounded reads up to limit bytes. complete is false when the body is
// longer, in which case raw is what was read so far.
func readBounded(body io.Reader, limit int64) (raw []byte, complete bool, err error) {
	if body == nil {
		return nil, true, nil
	}
	raw, err = io.ReadAll(io.LimitReader(body, limit+1))
	if err != nil {
		return nil, false, err
	}
	if int64(len(raw)) > limit {
		return raw, false, nil
	}
	return raw, true, nil
}

// decodeBody undoes the gzip git applies to a large request body.
func decodeBody(encoding string, raw []byte) ([]byte, error) {
	switch strings.ToLower(strings.TrimSpace(encoding)) {
	case "", "identity":
		return raw, nil
	case "gzip", "x-gzip":
		reader, err := gzip.NewReader(bytes.NewReader(raw))
		if err != nil {
			return nil, err
		}
		decoded, err := io.ReadAll(io.LimitReader(reader, maxRequestBytes+1))
		if err != nil {
			return nil, err
		}
		if len(decoded) > maxRequestBytes {
			return nil, errors.New("gitmirror: request too large once decoded")
		}
		return decoded, nil
	default:
		return nil, fmt.Errorf("gitmirror: unknown content encoding %q", encoding)
	}
}

// flushWriter sends each write on at once, so git's progress lines and the
// pack reach the client as upload-pack produces them.
type flushWriter struct{ w http.ResponseWriter }

func (f flushWriter) Write(p []byte) (int, error) {
	n, err := f.w.Write(p)
	if err == nil {
		_ = http.NewResponseController(f.w).Flush()
	}
	return n, err
}
