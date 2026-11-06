package gitmirror

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/cgi"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/cacheca"
)

// These tests run real git end to end and offline. A local bare repository
// served by git http-backend over TLS stands in for GitHub, the client runs
// the exact commands actions/checkout@v4 runs, and git reaches "github.com"
// only through this package's proxy.

const (
	goodToken = "ghs_the_jobs_own_token"
	badToken  = "ghs_a_token_for_something_else"
)

func requireGit(t *testing.T) string {
	t.Helper()
	path, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git is not installed")
	}
	return path
}

// fakeGitHub serves bare repositories under root the way github.com serves
// smart HTTP, requires goodToken for every repository, and counts the bytes
// it sends in upload-pack responses: the transfer the mirror exists to cut.
type fakeGitHub struct {
	t      *testing.T
	root   string
	server *httptest.Server
	sent   atomic.Int64
}

func newFakeGitHub(t *testing.T, gitPath string) *fakeGitHub {
	t.Helper()
	fake := &fakeGitHub{t: t, root: t.TempDir()}
	backend := &cgi.Handler{
		Path: gitPath,
		Args: []string{"http-backend"},
		Env: []string{
			"GIT_PROJECT_ROOT=" + fake.root,
			"GIT_HTTP_EXPORT_ALL=1",
			"GIT_CONFIG_NOSYSTEM=1",
			"GIT_CONFIG_GLOBAL=" + os.DevNull,
		},
		InheritEnv: []string{"PATH"},
	}
	fake.server = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, password, ok := r.BasicAuth()
		if !ok || user != "x-access-token" || password != goodToken {
			w.Header().Set("WWW-Authenticate", `Basic realm="GitHub"`)
			http.Error(w, "authentication required", http.StatusUnauthorized)
			return
		}
		// GitHub's paths carry no .git; http-backend's need the directory.
		path := r.URL.Path
		for _, suffix := range []string{"/info/refs", "/git-upload-pack", "/git-receive-pack"} {
			if prefix, ok := strings.CutSuffix(path, suffix); ok && !strings.HasSuffix(prefix, ".git") {
				path = prefix + ".git" + suffix
			}
		}
		r.URL.Path = path
		if r.Method == http.MethodPost && strings.HasSuffix(path, "/git-upload-pack") {
			backend.ServeHTTP(&countingWriter{ResponseWriter: w, count: &fake.sent}, r)
			return
		}
		backend.ServeHTTP(w, r)
	}))
	t.Cleanup(fake.server.Close)
	return fake
}

// transport reaches the fake as if it were github.com.
func (f *fakeGitHub) transport() *http.Transport {
	pool := x509.NewCertPool()
	pool.AddCert(f.server.Certificate())
	transport := DirectTransport()
	transport.TLSClientConfig = &tls.Config{RootCAs: pool, ServerName: "example.com", MinVersion: tls.VersionTLS12}
	address := f.server.Listener.Addr().String()
	transport.DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, address)
	}
	return transport
}

type countingWriter struct {
	http.ResponseWriter
	count *atomic.Int64
}

func (c *countingWriter) Write(p []byte) (int, error) {
	c.count.Add(int64(len(p)))
	return c.ResponseWriter.Write(p)
}

func (c *countingWriter) Flush() {
	if f, ok := c.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// gitEnv is an environment that reads no configuration but the file given.
func gitEnv(home, global string) []string {
	return []string{
		"PATH=" + os.Getenv("PATH"),
		"HOME=" + home,
		"LC_ALL=C",
		"GIT_CONFIG_NOSYSTEM=1",
		"GIT_CONFIG_GLOBAL=" + global,
		"GIT_TERMINAL_PROMPT=0",
		"GIT_AUTHOR_NAME=EraInfra", "GIT_AUTHOR_EMAIL=ci@erainfra.invalid",
		"GIT_COMMITTER_NAME=EraInfra", "GIT_COMMITTER_EMAIL=ci@erainfra.invalid",
	}
}

func runGit(t *testing.T, env []string, dir string, args ...string) string {
	t.Helper()
	output, err := tryGit(env, dir, args...)
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, output)
	}
	return strings.TrimSpace(output)
}

func tryGit(env []string, dir string, args ...string) (string, error) {
	command := exec.CommandContext(context.Background(), "git", args...)
	command.Dir = dir
	command.Env = env
	output, err := command.CombinedOutput()
	return string(output), err
}

// origin is one repository on the fake GitHub and a work tree to commit to it.
type origin struct {
	t    *testing.T
	env  []string
	bare string
	work string
}

func (f *fakeGitHub) newRepository(t *testing.T, name string) *origin {
	t.Helper()
	home := t.TempDir()
	env := gitEnv(home, os.DevNull)
	bare := filepath.Join(f.root, name+".git")
	runGit(t, env, f.root, "init", "--quiet", "--bare", "--initial-branch=main", bare)
	runGit(t, env, bare, "config", "http.receivepack", "true")
	runGit(t, env, bare, "config", "uploadpack.allowReachableSHA1InWant", "true")
	work := t.TempDir()
	runGit(t, env, work, "init", "--quiet", "--initial-branch=main")
	runGit(t, env, work, "remote", "add", "origin", bare)
	return &origin{t: t, env: env, bare: bare, work: work}
}

// commit writes files of random content, which does not delta-compress, so
// a byte count tells a full transfer from a delta.
func (o *origin) commit(files map[string]int) string {
	o.t.Helper()
	for name, size := range files {
		content := make([]byte, size)
		_, _ = rand.Read(content)
		path := filepath.Join(o.work, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			o.t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(hex.EncodeToString(content)), 0o644); err != nil {
			o.t.Fatal(err)
		}
	}
	runGit(o.t, o.env, o.work, "add", "--all")
	runGit(o.t, o.env, o.work, "commit", "--quiet", "--message", "change")
	runGit(o.t, o.env, o.work, "push", "--quiet", "origin", "HEAD:refs/heads/main")
	return runGit(o.t, o.env, o.work, "rev-parse", "HEAD")
}

// seedBundle is what a guest would have saved: the repository's branches and
// tags as a bundle.
func (o *origin) seedBundle() []byte {
	o.t.Helper()
	path := filepath.Join(o.t.TempDir(), "seed.bundle")
	runGit(o.t, o.env, o.bare, "bundle", "create", path, "--branches", "--tags")
	content, err := os.ReadFile(path)
	if err != nil {
		o.t.Fatal(err)
	}
	return content
}

// memorySeeds is a seed store in memory.
type memorySeeds struct {
	mu         sync.Mutex
	repository string
	writable   bool
	seed       []byte
	created    time.Time
	openErr    error
	opens      int
	saves      int
}

func (m *memorySeeds) Open(context.Context) (SeedInfo, io.ReadCloser, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.opens++
	if m.openErr != nil {
		return SeedInfo{}, nil, m.openErr
	}
	info := SeedInfo{Repository: m.repository, Writable: m.writable}
	if m.seed == nil {
		return info, nil, nil
	}
	info.Found, info.Created = true, m.created
	return info, io.NopCloser(bytes.NewReader(m.seed)), nil
}

func (m *memorySeeds) Save(_ context.Context, path string) error {
	content, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.saves++
	m.seed, m.created = content, time.Now()
	return nil
}

func (m *memorySeeds) snapshot() (seed []byte, opens, saves int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.seed, m.opens, m.saves
}

// guest is one guest's proxy and the git configuration that points at it.
type guest struct {
	service *Service
	env     []string
}

func startGuest(t *testing.T, fake *fakeGitHub, seeds SeedStore) *guest {
	t.Helper()
	authority, err := cacheca.MintFor(GitHubHost, time.Now(), time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	service, err := Start(Config{
		Dir:       t.TempDir(),
		Seeds:     seeds,
		Authority: authority,
		Transport: fake.transport(),
		Logf:      t.Logf,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = service.Close(context.Background()) })

	dir := t.TempDir()
	caFile := filepath.Join(dir, "ca.pem")
	if err := os.WriteFile(caFile, authority.TrustAnchorPEM, 0o644); err != nil {
		t.Fatal(err)
	}
	caDir := filepath.Join(dir, "ca.d")
	name, err := caPathName(authority.TrustAnchorPEM)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(caDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(caDir, name), authority.TrustAnchorPEM, 0o644); err != nil {
		t.Fatal(err)
	}
	global := filepath.Join(dir, "gitconfig")
	if err := os.WriteFile(global, []byte(GitConfig(service.ProxyURL(), caFile, caDir)), 0o644); err != nil {
		t.Fatal(err)
	}
	return &guest{service: service, env: gitEnv(t.TempDir(), global)}
}

// checkout runs what actions/checkout@v4 runs for a push event with the
// default fetch-depth of 1, and returns the work tree.
func (g *guest) checkout(t *testing.T, repository, sha, token string) (string, error) {
	t.Helper()
	path := t.TempDir()
	header := "AUTHORIZATION: basic " + base64.StdEncoding.EncodeToString([]byte("x-access-token:"+token))
	for _, args := range [][]string{
		{"init", "--quiet", path},
		{"remote", "add", "origin", "https://github.com/" + repository},
		{"config", "--local", "gc.auto", "0"},
		{"config", "--local", "http.https://github.com/.extraheader", header},
	} {
		runGit(t, g.env, path, args...)
	}
	if output, err := tryGit(g.env, path, "-c", "protocol.version=2", "fetch", "--no-tags", "--prune",
		"--no-recurse-submodules", "--depth=1", "origin", "+"+sha+":refs/remotes/origin/main"); err != nil {
		return path, errors.New(output)
	}
	runGit(t, g.env, path, "checkout", "--quiet", "--force", "-B", "main", "refs/remotes/origin/main")
	return path, nil
}

// assertCheckedOut proves the work tree is exactly what GitHub would have
// produced: the right commit, complete and self-contained, shallow at one
// commit, with no refs and no object store borrowed from the mirror.
func assertCheckedOut(t *testing.T, env []string, path, sha string, expect *origin) {
	t.Helper()
	if head := runGit(t, env, path, "rev-parse", "HEAD"); head != sha {
		t.Fatalf("HEAD is %s, want %s", head, sha)
	}
	runGit(t, env, path, "fsck", "--full", "--no-dangling")
	if _, err := os.Stat(filepath.Join(path, ".git", "objects", "info", "alternates")); !os.IsNotExist(err) {
		t.Fatalf("the work tree borrows objects through alternates: %v", err)
	}
	if shallow, err := os.ReadFile(filepath.Join(path, ".git", "shallow")); err != nil || strings.TrimSpace(string(shallow)) != sha {
		t.Fatalf("shallow file %q (%v), want exactly the checked-out commit", shallow, err)
	}
	refs := runGit(t, env, path, "for-each-ref", "--format=%(refname)")
	if refs != "refs/heads/main\nrefs/remotes/origin/main" {
		t.Fatalf("refs %q, want only what actions/checkout creates", refs)
	}
	want := runGit(t, expect.env, expect.bare, "ls-tree", "-r", sha)
	if got := runGit(t, env, path, "ls-tree", "-r", "HEAD"); got != want {
		t.Fatalf("checked-out tree differs from GitHub's")
	}
}

func basicHistory(o *origin) {
	for i := range 6 {
		o.commit(map[string]int{"src/part" + string(rune('a'+i)) + ".txt": 64 << 10})
	}
}

// The headline: a commit pushed after the seed was saved still checks out
// correctly, and GitHub sends only what the seed lacks.
func TestCheckoutAfterTheSeedTransfersOnlyTheDelta(t *testing.T) {
	gitPath := requireGit(t)
	fake := newFakeGitHub(t, gitPath)
	repo := fake.newRepository(t, "acme/app")
	basicHistory(repo)
	seeds := &memorySeeds{repository: "acme/app", writable: true, seed: repo.seedBundle(), created: time.Now()}

	// Pushed after the seed: the mirror has never seen it.
	sha := repo.commit(map[string]int{"src/new.txt": 2 << 10})

	baseline := startGuest(t, fake, &memorySeeds{openErr: ErrSeedUnavailable})
	fake.sent.Store(0)
	path, err := baseline.checkout(t, "acme/app", sha, goodToken)
	if err != nil {
		t.Fatal(err)
	}
	assertCheckedOut(t, baseline.env, path, sha, repo)
	full := fake.sent.Load()

	mirrored := startGuest(t, fake, seeds)
	fake.sent.Store(0)
	path, err = mirrored.checkout(t, "acme/app", sha, goodToken)
	if err != nil {
		t.Fatal(err)
	}
	assertCheckedOut(t, mirrored.env, path, sha, repo)
	delta := fake.sent.Load()

	t.Logf("GitHub sent %d bytes without the mirror and %d with it", full, delta)
	if full < 300<<10 {
		t.Fatalf("the baseline checkout moved only %d bytes; the fixture is too small to tell", full)
	}
	if delta*10 > full {
		t.Fatalf("with a seed GitHub still sent %d of %d bytes, want under a tenth", delta, full)
	}
}

// A depth-1 checkout leaves the mirror shallow at the new commit. A later
// fetch that asks for whole history, from the same job, must still get all
// of it: from fetch-depth: 0, or from `git fetch --unshallow` in a step.
func TestWholeHistoryIsServedAfterAShallowCheckout(t *testing.T) {
	gitPath := requireGit(t)
	fake := newFakeGitHub(t, gitPath)
	repo := fake.newRepository(t, "acme/app")
	basicHistory(repo)
	seeds := &memorySeeds{repository: "acme/app", writable: true, seed: repo.seedBundle(), created: time.Now()}
	repo.commit(map[string]int{"src/one.txt": 1 << 10})
	sha := repo.commit(map[string]int{"src/two.txt": 1 << 10})

	g := startGuest(t, fake, seeds)
	path, err := g.checkout(t, "acme/app", sha, goodToken)
	if err != nil {
		t.Fatal(err)
	}
	assertCheckedOut(t, g.env, path, sha, repo)

	fake.sent.Store(0)
	runGit(t, g.env, path, "-c", "protocol.version=2", "fetch", "--quiet", "--unshallow", "origin")
	want := runGit(t, repo.env, repo.bare, "rev-list", "--count", sha)
	if got := runGit(t, g.env, path, "rev-list", "--count", "HEAD"); got != want {
		t.Fatalf("after --unshallow the job has %s commits, want all %s", got, want)
	}
	runGit(t, g.env, path, "fsck", "--full", "--no-dangling")
	if sent := fake.sent.Load(); sent > 64<<10 {
		t.Fatalf("unshallowing moved %d bytes from GitHub; the seed already had the history", sent)
	}

	// fetch-depth: 0, as actions/checkout runs it.
	full := t.TempDir()
	header := "AUTHORIZATION: basic " + base64.StdEncoding.EncodeToString([]byte("x-access-token:"+goodToken))
	runGit(t, g.env, full, "init", "--quiet")
	runGit(t, g.env, full, "remote", "add", "origin", "https://github.com/acme/app")
	runGit(t, g.env, full, "config", "--local", "http.https://github.com/.extraheader", header)
	fake.sent.Store(0)
	runGit(t, g.env, full, "-c", "protocol.version=2", "fetch", "--quiet", "--prune", "--no-recurse-submodules",
		"origin", "+refs/heads/*:refs/remotes/origin/*", "+refs/tags/*:refs/tags/*")
	runGit(t, g.env, full, "checkout", "--quiet", "--force", "-B", "main", "refs/remotes/origin/main")
	if got := runGit(t, g.env, full, "rev-list", "--count", "HEAD"); got != want {
		t.Fatalf("a fetch-depth 0 checkout has %s commits, want %s", got, want)
	}
	runGit(t, g.env, full, "fsck", "--full", "--no-dangling")
	if sent := fake.sent.Load(); sent > 64<<10 {
		t.Fatalf("a fetch-depth 0 checkout moved %d bytes from GitHub, want only the delta", sent)
	}
}

// The job's credential is checked by GitHub on every fetch the mirror
// answers, even when every wanted object is already in the mirror. A client
// that cannot read the repository gets GitHub's refusal, not the seed.
func TestMirrorNeverServesAClientGitHubWouldRefuse(t *testing.T) {
	gitPath := requireGit(t)
	fake := newFakeGitHub(t, gitPath)
	repo := fake.newRepository(t, "acme/private-app")
	basicHistory(repo)
	sha := runGit(t, repo.env, repo.bare, "rev-parse", "refs/heads/main")
	seeds := &memorySeeds{repository: "acme/private-app", seed: repo.seedBundle(), created: time.Now()}

	g := startGuest(t, fake, seeds)
	if _, err := g.checkout(t, "acme/private-app", sha, goodToken); err != nil {
		t.Fatalf("the job's own checkout failed: %v", err)
	}
	if _, err := g.checkout(t, "acme/private-app", sha, badToken); err == nil {
		t.Fatal("a fetch with a credential GitHub refuses was answered from the mirror")
	}
}

// The mirror serves the job's own repository and nothing else. A checkout of
// another repository in the same job passes through to GitHub whole, the
// job's seed is never applied to it, and no seed is built from it. The job's
// own checkout afterwards still uses the mirror.
func TestOtherRepositoriesPassThroughUntouched(t *testing.T) {
	gitPath := requireGit(t)
	fake := newFakeGitHub(t, gitPath)
	app := fake.newRepository(t, "acme/app")
	basicHistory(app)
	lib := fake.newRepository(t, "acme/lib")
	basicHistory(lib)
	libSHA := runGit(t, lib.env, lib.bare, "rev-parse", "refs/heads/main")
	seeds := &memorySeeds{repository: "acme/app", writable: true, seed: app.seedBundle(), created: time.Now()}

	g := startGuest(t, fake, seeds)
	fake.sent.Store(0)
	path, err := g.checkout(t, "acme/lib", libSHA, goodToken)
	if err != nil {
		t.Fatal(err)
	}
	assertCheckedOut(t, g.env, path, libSHA, lib)
	if sent := fake.sent.Load(); sent < 300<<10 {
		t.Fatalf("GitHub sent only %d bytes for acme/lib; something other than GitHub answered", sent)
	}
	g.service.mu.Lock()
	refreshStarted := g.service.refreshStarted
	g.service.mu.Unlock()
	if refreshStarted {
		t.Fatal("a fetch of another repository started a seed refresh")
	}

	appSHA := runGit(t, app.env, app.bare, "rev-parse", "refs/heads/main")
	fake.sent.Store(0)
	path, err = g.checkout(t, "acme/app", appSHA, goodToken)
	if err != nil {
		t.Fatal(err)
	}
	assertCheckedOut(t, g.env, path, appSHA, app)
	if sent := fake.sent.Load(); sent > 16<<10 {
		t.Fatalf("GitHub sent %d bytes for the job's own repository; the mirror should have answered", sent)
	}
}

// Prewarming restores the seed as soon as the cache service knows the job,
// before the checkout asks, so the checkout does not wait for it.
func TestPrewarmRestoresTheSeedBeforeTheCheckoutAsks(t *testing.T) {
	gitPath := requireGit(t)
	fake := newFakeGitHub(t, gitPath)
	repo := fake.newRepository(t, "acme/app")
	basicHistory(repo)
	seeds := &factsArriveLate{memorySeeds: memorySeeds{
		repository: "acme/app", seed: repo.seedBundle(), created: time.Now(),
	}, refusals: 2}

	authority, err := cacheca.MintFor(GitHubHost, time.Now(), time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	service, err := Start(Config{
		Dir: t.TempDir(), Seeds: seeds, Authority: authority, Transport: fake.transport(),
		Logf: t.Logf, PrewarmFor: time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close(context.Background()) //nolint:errcheck // the test is over
	deadline := time.Now().Add(30 * time.Second)
	for {
		if _, ready := service.preparedFor("acme/app"); ready {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("prewarm never restored the seed")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if _, opens, _ := seeds.snapshot(); opens != 3 {
		t.Fatalf("prewarm asked %d times, want two refusals and one answer", opens)
	}
}

// factsArriveLate refuses the first few asks, as the cache service does
// until the controller's job facts arrive.
type factsArriveLate struct {
	memorySeeds
	refusals int
}

func (f *factsArriveLate) Open(ctx context.Context) (SeedInfo, io.ReadCloser, error) {
	f.mu.Lock()
	if f.refusals > 0 {
		f.refusals--
		f.opens++
		f.mu.Unlock()
		return SeedInfo{}, nil, ErrSeedUnavailable
	}
	f.mu.Unlock()
	return f.memorySeeds.Open(ctx)
}

// Every way the seed can be unavailable leaves a normal checkout from GitHub.
func TestEveryFailureFallsBackToGitHub(t *testing.T) {
	gitPath := requireGit(t)
	fake := newFakeGitHub(t, gitPath)
	repo := fake.newRepository(t, "acme/app")
	basicHistory(repo)
	sha := runGit(t, repo.env, repo.bare, "rev-parse", "refs/heads/main")

	unreachable, err := NewSeedClient("http://127.0.0.1:1", "erainfra-cache-runner-v1.x.y", nil)
	if err != nil {
		t.Fatal(err)
	}
	truncated := repo.seedBundle()
	cases := map[string]SeedStore{
		"cache service unreachable": unreachable,
		"facts not yet pushed":      &memorySeeds{openErr: ErrSeedUnavailable},
		"no seed yet":               &memorySeeds{repository: "acme/app"},
		"seed is not a bundle":      &memorySeeds{repository: "acme/app", seed: []byte("not a bundle"), created: time.Now()},
		"seed is truncated":         &memorySeeds{repository: "acme/app", seed: truncated[:len(truncated)/2], created: time.Now()},
	}
	for name, seeds := range cases {
		t.Run(name, func(t *testing.T) {
			g := startGuest(t, fake, seeds)
			path, err := g.checkout(t, "acme/app", sha, goodToken)
			if err != nil {
				t.Fatalf("checkout failed instead of falling back to GitHub: %v", err)
			}
			assertCheckedOut(t, g.env, path, sha, repo)
		})
	}
}

// A job whose repository has no seed saves one with its own credential, and
// the next guest checks out from it.
func TestAColdJobSavesASeedTheNextJobUses(t *testing.T) {
	gitPath := requireGit(t)
	fake := newFakeGitHub(t, gitPath)
	repo := fake.newRepository(t, "acme/app")
	basicHistory(repo)
	sha := runGit(t, repo.env, repo.bare, "rev-parse", "refs/heads/main")
	seeds := &memorySeeds{repository: "acme/app", writable: true}

	first := startGuest(t, fake, seeds)
	if _, err := first.checkout(t, "acme/app", sha, goodToken); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	if err := first.service.Close(ctx); err != nil {
		t.Fatal(err)
	}
	seed, _, saves := seeds.snapshot()
	if saves != 1 || len(seed) == 0 {
		t.Fatalf("the cold job saved %d seeds (%d bytes), want one", saves, len(seed))
	}

	next := repo.commit(map[string]int{"src/next.txt": 1 << 10})
	second := startGuest(t, fake, seeds)
	fake.sent.Store(0)
	path, err := second.checkout(t, "acme/app", next, goodToken)
	if err != nil {
		t.Fatal(err)
	}
	assertCheckedOut(t, second.env, path, next, repo)
	if sent := fake.sent.Load(); sent > 64<<10 {
		t.Fatalf("GitHub sent %d bytes to a job with a fresh seed, want only the delta", sent)
	}
	// The seed was fresh, so the second job did not save another.
	if err := second.service.Close(ctx); err != nil {
		t.Fatal(err)
	}
	if _, _, saves := seeds.snapshot(); saves != 1 {
		t.Fatalf("a job with a fresh seed saved again (%d saves)", saves)
	}
}

// A job that may not write the cache (a fork pull request) never builds a seed.
func TestAReadOnlyJobNeverSavesASeed(t *testing.T) {
	gitPath := requireGit(t)
	fake := newFakeGitHub(t, gitPath)
	repo := fake.newRepository(t, "acme/app")
	basicHistory(repo)
	sha := runGit(t, repo.env, repo.bare, "rev-parse", "refs/heads/main")
	seeds := &memorySeeds{repository: "acme/app", writable: false}

	g := startGuest(t, fake, seeds)
	if _, err := g.checkout(t, "acme/app", sha, goodToken); err != nil {
		t.Fatal(err)
	}
	if err := g.service.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, _, saves := seeds.snapshot(); saves != 0 {
		t.Fatalf("a read-only job saved %d seeds", saves)
	}
}

// Everything that is not a fetch goes to GitHub as it came: here, a push.
func TestPushesPassThrough(t *testing.T) {
	gitPath := requireGit(t)
	fake := newFakeGitHub(t, gitPath)
	repo := fake.newRepository(t, "acme/app")
	basicHistory(repo)
	sha := runGit(t, repo.env, repo.bare, "rev-parse", "refs/heads/main")
	g := startGuest(t, fake, &memorySeeds{repository: "acme/app", seed: repo.seedBundle(), created: time.Now()})

	path, err := g.checkout(t, "acme/app", sha, goodToken)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(path, "pushed.txt"), []byte("from the job\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGit(t, g.env, path, "add", "pushed.txt")
	runGit(t, g.env, path, "commit", "--quiet", "--message", "push through the proxy")
	pushed := runGit(t, g.env, path, "rev-parse", "HEAD")
	runGit(t, g.env, path, "push", "--quiet", "origin", "HEAD:refs/heads/from-job")
	if got := runGit(t, repo.env, repo.bare, "rev-parse", "refs/heads/from-job"); got != pushed {
		t.Fatalf("GitHub has %s, want the pushed %s", got, pushed)
	}
}

// The proxy tunnels to github.com only.
func TestProxyRefusesTunnelsToOtherHosts(t *testing.T) {
	gitPath := requireGit(t)
	fake := newFakeGitHub(t, gitPath)
	g := startGuest(t, fake, &memorySeeds{openErr: ErrSeedUnavailable})
	proxyURL, _ := url.Parse(g.service.ProxyURL())
	client := &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(proxyURL)}}
	request, _ := http.NewRequestWithContext(t.Context(), http.MethodGet, "https://example.com/", nil)
	response, err := client.Do(request)
	if err == nil {
		_ = response.Body.Close()
		t.Fatal("the proxy tunnelled to example.com")
	}
	if !strings.Contains(err.Error(), "Forbidden") {
		t.Fatalf("tunnel to example.com failed with %v, want the proxy's 403", err)
	}
}

// Activation is what the guest does: it writes the configuration to its own
// file, includes that file from git's system configuration, and takes it
// away when the proxy stops, after which git goes to GitHub as if the mirror
// had never been there.
func TestActivationRoutesGitUntilTheProxyStops(t *testing.T) {
	gitPath := requireGit(t)
	fake := newFakeGitHub(t, gitPath)
	repo := fake.newRepository(t, "acme/app")
	basicHistory(repo)
	sha := runGit(t, repo.env, repo.bare, "rev-parse", "refs/heads/main")

	authority, err := cacheca.MintFor(GitHubHost, time.Now(), time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	service, err := Start(Config{
		Dir: t.TempDir(), Seeds: &memorySeeds{repository: "acme/app", seed: repo.seedBundle(), created: time.Now()},
		Authority: authority, Transport: fake.transport(), Logf: t.Logf,
	})
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	roots := filepath.Join(dir, "roots.pem")
	if err := os.WriteFile(roots, []byte("# the system roots\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	system := filepath.Join(dir, "gitconfig")
	cfg := ActivateConfig{
		SystemRoots: roots,
		CABundle:    filepath.Join(dir, "erainfra", "ca.pem"),
		CADir:       filepath.Join(dir, "erainfra", "ca.d"),
		ConfigFile:  filepath.Join(dir, "erainfra", "mirror.gitconfig"),
		CAPEM:       authority.TrustAnchorPEM,
		Include: func(_ context.Context, file string) error {
			return os.WriteFile(system, []byte("[include]\n\tpath = "+file+"\n"), 0o644)
		},
		Logf: t.Logf,
	}
	deactivate, err := Activate(context.Background(), service, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer deactivate()
	bundle, _ := os.ReadFile(cfg.CABundle)
	if !bytes.HasPrefix(bundle, []byte("# the system roots\n")) || !bytes.Contains(bundle, authority.TrustAnchorPEM) {
		t.Fatalf("the CA bundle %q holds the system roots and the per-guest CA", bundle)
	}

	g := &guest{service: service, env: gitEnv(t.TempDir(), system)}
	fake.sent.Store(0)
	path, err := g.checkout(t, "acme/app", sha, goodToken)
	if err != nil {
		t.Fatal(err)
	}
	assertCheckedOut(t, g.env, path, sha, repo)
	if sent := fake.sent.Load(); sent > 16<<10 {
		t.Fatalf("GitHub sent %d bytes for a commit the seed holds; the activated mirror should have answered", sent)
	}

	if err := service.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(cfg.ConfigFile); os.IsNotExist(err) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the git configuration outlived the proxy")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if output, err := tryGit(g.env, path, "config", "--get", "http.https://github.com/.proxy"); err == nil {
		t.Fatalf("git still has a proxy for github.com after the proxy stopped: %s", output)
	}
}
