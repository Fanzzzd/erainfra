package gitmirror

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"io"
	"net/http"
	"net/http/cgi"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// These tests hold the mirror to one rule: whatever a job asks git to fetch of
// its own repository, it ends with exactly what it would have had from GitHub.
// Each runs the same git commands twice, once with no seed (every request goes
// to GitHub) and once with a seed, and compares.

func extraHeader(token string) string {
	return "AUTHORIZATION: basic " + base64.StdEncoding.EncodeToString([]byte("x-access-token:"+token))
}

// emptyClone is a repository with origin set up the way actions/checkout sets
// it up, before its first fetch.
func (g *guest) emptyClone(t *testing.T, repository string) string {
	t.Helper()
	path := t.TempDir()
	runGit(t, g.env, path, "init", "--quiet")
	runGit(t, g.env, path, "remote", "add", "origin", "https://github.com/"+repository)
	runGit(t, g.env, path, "config", "--local", "http.https://github.com/.extraheader", extraHeader(goodToken))
	return path
}

func noSeed() SeedStore { return &memorySeeds{openErr: ErrSeedUnavailable} }

func seeded(seed []byte) SeedStore {
	return &memorySeeds{repository: "acme/app", seed: seed, created: time.Now()}
}

// `git fetch --deepen=N` after a depth-1 checkout counts N from the client's
// own shallow boundary. The mirror's fetch from GitHub has its own boundary,
// so the mirror cannot answer it and sends it to GitHub.
func TestDeepenRelativeMatchesGitHub(t *testing.T) {
	gitPath := requireGit(t)
	fake := newFakeGitHub(t, gitPath)
	repo := fake.newRepository(t, "acme/app")
	basicHistory(repo)
	seedOnly := runGit(t, repo.env, repo.bare, "rev-parse", "refs/heads/main")
	seed := repo.seedBundle()
	repo.commit(map[string]int{"src/one.txt": 1 << 10})
	afterSeed := repo.commit(map[string]int{"src/two.txt": 1 << 10})

	for name, sha := range map[string]string{"commit after the seed": afterSeed, "commit in the seed": seedOnly} {
		t.Run(name, func(t *testing.T) {
			run := func(seeds SeedStore) (string, string) {
				g := startGuest(t, fake, seeds)
				path, err := g.checkout(t, "acme/app", sha, goodToken)
				if err != nil {
					t.Fatal(err)
				}
				runGit(t, g.env, path, "-c", "protocol.version=2", "fetch", "--quiet", "--deepen=3", "origin",
					"+"+sha+":refs/remotes/origin/main")
				runGit(t, g.env, path, "fsck", "--full", "--no-dangling")
				shallow, _ := os.ReadFile(filepath.Join(path, ".git", "shallow"))
				return runGit(t, g.env, path, "rev-list", "--count", "HEAD"), strings.TrimSpace(string(shallow))
			}
			directCount, directShallow := run(noSeed())
			mirrorCount, mirrorShallow := run(seeded(seed))
			if directCount != mirrorCount || directShallow != mirrorShallow {
				t.Fatalf("after --deepen=3 the job has %s commits shallow at %q through the mirror, %s at %q from GitHub",
					mirrorCount, mirrorShallow, directCount, directShallow)
			}
		})
	}
}

// Absolute depth and a date limit are answered by the mirror and agree with
// GitHub.
func TestAbsoluteDeepeningMatchesGitHub(t *testing.T) {
	gitPath := requireGit(t)
	fake := newFakeGitHub(t, gitPath)
	repo := fake.newRepository(t, "acme/app")
	basicHistory(repo)
	seed := repo.seedBundle()
	repo.commit(map[string]int{"src/one.txt": 1 << 10})
	sha := repo.commit(map[string]int{"src/two.txt": 1 << 10})

	for _, args := range [][]string{{"--depth=4"}, {"--shallow-since=1970-01-02"}} {
		run := func(seeds SeedStore) string {
			g := startGuest(t, fake, seeds)
			path, err := g.checkout(t, "acme/app", sha, goodToken)
			if err != nil {
				t.Fatal(err)
			}
			fetch := append([]string{"-c", "protocol.version=2", "fetch", "--quiet"}, args...)
			runGit(t, g.env, path, append(fetch, "origin", "+"+sha+":refs/remotes/origin/main")...)
			runGit(t, g.env, path, "fsck", "--full", "--no-dangling")
			return runGit(t, g.env, path, "rev-list", "--count", "HEAD")
		}
		if direct, mirrored := run(noSeed()), run(seeded(seed)); direct != mirrored {
			t.Errorf("%v: %s commits through the mirror, %s from GitHub", args, mirrored, direct)
		}
	}
}

// actions/checkout with filter: blob:none, and the lazy blob fetches that
// follow.
func TestBloblessCheckoutThroughTheMirror(t *testing.T) {
	gitPath := requireGit(t)
	fake := newFakeGitHub(t, gitPath)
	repo := fake.newRepository(t, "acme/app")
	basicHistory(repo)
	runGit(t, repo.env, repo.bare, "config", "uploadpack.allowFilter", "true")
	runGit(t, repo.env, repo.bare, "config", "uploadpack.allowAnySHA1InWant", "true")
	seed := repo.seedBundle()
	sha := repo.commit(map[string]int{"src/new.txt": 1 << 10})

	g := startGuest(t, fake, seeded(seed))
	path := g.emptyClone(t, "acme/app")
	runGit(t, g.env, path, "-c", "protocol.version=2", "fetch", "--no-tags", "--prune", "--no-recurse-submodules",
		"--filter=blob:none", "--depth=1", "origin", "+"+sha+":refs/remotes/origin/main")
	runGit(t, g.env, path, "-c", "protocol.version=2", "checkout", "--quiet", "--force", "-B", "main", "refs/remotes/origin/main")
	if got, want := runGit(t, g.env, path, "ls-tree", "-r", "HEAD"), runGit(t, repo.env, repo.bare, "ls-tree", "-r", sha); got != want {
		t.Fatal("the checked-out tree differs from GitHub's")
	}
	if status := runGit(t, g.env, path, "status", "--porcelain"); status != "" {
		t.Fatalf("work tree not clean: %q", status)
	}
}

// A commit that was in the seed but that GitHub no longer serves: its branch
// deleted and its objects purged, as after a sensitive-data removal. GitHub
// refuses a fetch of it by object name, and so does the mirror, at any depth.
func TestAPurgedCommitIsNotServedFromTheSeed(t *testing.T) {
	gitPath := requireGit(t)
	fake := newFakeGitHub(t, gitPath)
	repo := fake.newRepository(t, "acme/app")
	basicHistory(repo)
	runGit(t, repo.env, repo.work, "checkout", "--quiet", "-b", "leak")
	runGit(t, repo.env, repo.work, "commit", "--quiet", "--allow-empty", "-m", "secret=hunter2")
	leaked := runGit(t, repo.env, repo.work, "rev-parse", "HEAD")
	runGit(t, repo.env, repo.work, "push", "--quiet", "origin", "HEAD:refs/heads/leak")
	seed := repo.seedBundle()
	runGit(t, repo.env, repo.bare, "update-ref", "-d", "refs/heads/leak")
	runGit(t, repo.env, repo.bare, "reflog", "expire", "--expire=now", "--all")
	runGit(t, repo.env, repo.bare, "gc", "--quiet", "--prune=now")
	if _, err := tryGit(repo.env, repo.bare, "cat-file", "-e", leaked); err == nil {
		t.Fatal("fixture: the commit is still on the fake GitHub")
	}

	for _, depth := range [][]string{nil, {"--depth=1"}} {
		fetch := func(seeds SeedStore) error {
			g := startGuest(t, fake, seeds)
			path := g.emptyClone(t, "acme/app")
			args := append([]string{"-c", "protocol.version=2", "fetch", "--quiet", "--no-tags"}, depth...)
			_, err := tryGit(g.env, path, append(args, "origin", "+"+leaked+":refs/remotes/origin/leak")...)
			return err
		}
		if fetch(noSeed()) == nil {
			t.Fatalf("depth %v: fixture: GitHub served the purged commit", depth)
		}
		if fetch(seeded(seed)) == nil {
			t.Errorf("depth %v: the mirror served a commit GitHub no longer has", depth)
		}
	}
}

// A repository deleted and created again under the same name has another
// history. Restoring the earlier repository's seed (which the seed's
// repository ID now prevents, see the cache service) must still never hand a
// job an object of the earlier repository, and must not break its checkout.
func TestAnEarlierRepositoryOfTheSameNameIsNeverServed(t *testing.T) {
	gitPath := requireGit(t)
	fake := newFakeGitHub(t, gitPath)
	earlier := fake.newRepository(t, "acme/app")
	basicHistory(earlier)
	oldSHA := runGit(t, earlier.env, earlier.bare, "rev-parse", "refs/heads/main")
	seed := earlier.seedBundle()
	if err := os.RemoveAll(earlier.bare); err != nil {
		t.Fatal(err)
	}
	repo := fake.newRepository(t, "acme/app")
	basicHistory(repo)
	sha := runGit(t, repo.env, repo.bare, "rev-parse", "refs/heads/main")

	g := startGuest(t, fake, seeded(seed))
	old := g.emptyClone(t, "acme/app")
	if _, err := tryGit(g.env, old, "-c", "protocol.version=2", "fetch", "--quiet", "--no-tags", "origin",
		"+"+oldSHA+":refs/remotes/origin/old"); err == nil {
		t.Fatal("the mirror served a commit of the earlier repository")
	}
	path, err := g.checkout(t, "acme/app", sha, goodToken)
	if err != nil {
		t.Fatal(err)
	}
	assertCheckedOut(t, g.env, path, sha, repo)

	full := g.emptyClone(t, "acme/app")
	runGit(t, g.env, full, "-c", "protocol.version=2", "fetch", "--quiet", "--prune", "--no-recurse-submodules",
		"origin", "+refs/heads/*:refs/remotes/origin/*", "+refs/tags/*:refs/tags/*")
	runGit(t, g.env, full, "fsck", "--full", "--no-dangling")
	if _, err := tryGit(g.env, full, "cat-file", "-e", oldSHA); err == nil {
		t.Fatal("a whole-history fetch received an object of the earlier repository")
	}
}

// Fetches that follow tags ("include-tag": a fetch-depth 0 checkout, a plain
// git fetch, a clone) get exactly GitHub's tags: one created after the seed
// is there, one deleted after it is not, not even as an object.
func TestTagFollowingMatchesGitHub(t *testing.T) {
	gitPath := requireGit(t)
	fake := newFakeGitHub(t, gitPath)
	repo := fake.newRepository(t, "acme/app")
	basicHistory(repo)
	tag := func(name, target string) string {
		runGit(t, repo.env, repo.work, "tag", "--annotate", "--message", "release "+name, name, target)
		runGit(t, repo.env, repo.work, "push", "--quiet", "origin", "refs/tags/"+name)
		return runGit(t, repo.env, repo.bare, "rev-parse", "refs/tags/"+name)
	}
	first := runGit(t, repo.env, repo.bare, "rev-parse", "refs/heads/main~3")
	tag("v1", first)
	gone := tag("gone", "HEAD~1")
	seed := repo.seedBundle()
	runGit(t, repo.env, repo.bare, "update-ref", "-d", "refs/tags/gone")
	runGit(t, repo.env, repo.bare, "reflog", "expire", "--expire=now", "--all")
	runGit(t, repo.env, repo.bare, "gc", "--quiet", "--prune=now")
	sha := repo.commit(map[string]int{"src/new.txt": 1 << 10})
	tag("v2", sha)

	refs := func(env []string, path string) string {
		return runGit(t, env, path, "for-each-ref", "--format=%(objectname) %(refname)")
	}
	cases := map[string]func(g *guest) string{
		"fetch-depth 0 checkout": func(g *guest) string {
			path := g.emptyClone(t, "acme/app")
			runGit(t, g.env, path, "-c", "protocol.version=2", "fetch", "--quiet", "--prune", "--no-recurse-submodules",
				"origin", "+refs/heads/*:refs/remotes/origin/*", "+refs/tags/*:refs/tags/*")
			return path
		},
		"fetch that follows tags": func(g *guest) string {
			path := g.emptyClone(t, "acme/app")
			runGit(t, g.env, path, "-c", "protocol.version=2", "fetch", "--quiet", "origin",
				"+refs/heads/main:refs/remotes/origin/main")
			return path
		},
		"single-branch clone": func(g *guest) string {
			path := filepath.Join(t.TempDir(), "clone")
			runGit(t, g.env, t.TempDir(), "-c", "protocol.version=2", "-c",
				"http.https://github.com/.extraheader="+extraHeader(goodToken),
				"clone", "--quiet", "--single-branch", "--no-checkout", "https://github.com/acme/app", path)
			return path
		},
		"shallow clone": func(g *guest) string {
			path := filepath.Join(t.TempDir(), "clone")
			runGit(t, g.env, t.TempDir(), "-c", "protocol.version=2", "-c",
				"http.https://github.com/.extraheader="+extraHeader(goodToken),
				"clone", "--quiet", "--depth=1", "--no-checkout", "https://github.com/acme/app", path)
			return path
		},
	}
	for name, fetch := range cases {
		t.Run(name, func(t *testing.T) {
			direct := startGuest(t, fake, noSeed())
			want := refs(direct.env, fetch(direct))
			mirrored := startGuest(t, fake, seeded(seed))
			fake.sent.Store(0)
			path := fetch(mirrored)
			if got := refs(mirrored.env, path); got != want {
				t.Fatalf("refs through the mirror:\n%s\nfrom GitHub:\n%s", got, want)
			}
			runGit(t, mirrored.env, path, "fsck", "--full", "--no-dangling")
			if _, err := tryGit(mirrored.env, path, "cat-file", "-e", gone); err == nil {
				t.Fatal("the job received the object of a tag GitHub deleted")
			}
			t.Logf("GitHub sent %d bytes", fake.sent.Load())
		})
	}
}

// A whole-history fetch that follows tags is still answered by the mirror.
func TestAFetchDepthZeroCheckoutUsesTheMirror(t *testing.T) {
	gitPath := requireGit(t)
	fake := newFakeGitHub(t, gitPath)
	repo := fake.newRepository(t, "acme/app")
	basicHistory(repo)
	runGit(t, repo.env, repo.work, "tag", "--annotate", "--message", "release", "v1", "HEAD~2")
	runGit(t, repo.env, repo.work, "push", "--quiet", "origin", "refs/tags/v1")
	seed := repo.seedBundle()
	repo.commit(map[string]int{"src/new.txt": 1 << 10})

	g := startGuest(t, fake, seeded(seed))
	path := g.emptyClone(t, "acme/app")
	fake.sent.Store(0)
	runGit(t, g.env, path, "-c", "protocol.version=2", "fetch", "--quiet", "--prune", "--no-recurse-submodules",
		"origin", "+refs/heads/*:refs/remotes/origin/*", "+refs/tags/*:refs/tags/*")
	if sent := fake.sent.Load(); sent > 64<<10 {
		t.Fatalf("a fetch-depth 0 checkout moved %d bytes from GitHub, want only the delta", sent)
	}
}

// slowRefreshFake is fakeGitHub, except a v2 ls-refs that asks for tags,
// which among these requests only the mirror's background refresh sends
// (actions/checkout passes --no-tags), takes delay: a refresh of a large
// repository.
func slowRefreshFake(t *testing.T, gitPath string, delay time.Duration) *fakeGitHub {
	t.Helper()
	fake := &fakeGitHub{t: t, root: t.TempDir()}
	backend := &cgi.Handler{
		Path: gitPath, Args: []string{"http-backend"},
		Env: []string{"GIT_PROJECT_ROOT=" + fake.root, "GIT_HTTP_EXPORT_ALL=1",
			"GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=" + os.DevNull},
		InheritEnv: []string{"PATH"},
	}
	fake.server = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if user, password, ok := r.BasicAuth(); !ok || user != "x-access-token" || password != goodToken {
			w.Header().Set("WWW-Authenticate", `Basic realm="GitHub"`)
			http.Error(w, "authentication required", http.StatusUnauthorized)
			return
		}
		for _, suffix := range []string{"/info/refs", "/git-upload-pack"} {
			if prefix, ok := strings.CutSuffix(r.URL.Path, suffix); ok && !strings.HasSuffix(prefix, ".git") {
				r.URL.Path = prefix + ".git" + suffix
			}
		}
		if r.Method == http.MethodPost {
			body, _ := io.ReadAll(r.Body)
			r.Body = io.NopCloser(bytes.NewReader(body))
			if bytes.Contains(body, []byte("command=ls-refs")) && bytes.Contains(body, []byte("ref-prefix refs/tags/")) {
				time.Sleep(delay)
			}
		}
		backend.ServeHTTP(w, r)
	}))
	t.Cleanup(fake.server.Close)
	return fake
}

// The background refresh holds the mirror for as long as it runs. A second
// fetch in the same job goes to GitHub instead of waiting for it.
func TestASecondFetchDoesNotWaitForTheSeedRefresh(t *testing.T) {
	gitPath := requireGit(t)
	const delay = 10 * time.Second
	fake := slowRefreshFake(t, gitPath, delay)
	repo := fake.newRepository(t, "acme/app")
	basicHistory(repo)
	seed := repo.seedBundle()
	sha := repo.commit(map[string]int{"src/new.txt": 1 << 10})
	seeds := &memorySeeds{repository: "acme/app", writable: true, seed: seed, created: time.Now().Add(-48 * time.Hour)}

	g := startGuest(t, fake, seeds)
	if _, err := g.checkout(t, "acme/app", sha, goodToken); err != nil {
		t.Fatal(err)
	}
	time.Sleep(500 * time.Millisecond) // the refresh reaches GitHub and holds the mirror
	start := time.Now()
	path, err := g.checkout(t, "acme/app", sha, goodToken)
	if err != nil {
		t.Fatal(err)
	}
	assertCheckedOut(t, g.env, path, sha, repo)
	if second := time.Since(start); second > delay/2 {
		t.Fatalf("the job's second fetch waited %s on the background seed refresh", second.Round(time.Second))
	}
}

// A whole-history fetch running beside depth-1 fetches of its ancestors,
// which rewrite the mirror's shallow boundary, still gets whole history.
func TestConcurrentShallowFetchesDoNotTruncateAWholeHistoryFetch(t *testing.T) {
	gitPath := requireGit(t)
	fake := newFakeGitHub(t, gitPath)
	repo := fake.newRepository(t, "acme/app")
	var shas []string
	for i := range 12 {
		shas = append(shas, repo.commit(map[string]int{"src/f" + string(rune('a'+i)) + ".txt": 4 << 10}))
	}
	seed := repo.seedBundle()
	tip := shas[len(shas)-1]
	want := runGit(t, repo.env, repo.bare, "rev-list", "--count", tip)
	g := startGuest(t, fake, seeded(seed))

	for round := range 10 {
		var wg sync.WaitGroup
		full := g.emptyClone(t, "acme/app")
		var fullOut string
		var fullErr error
		wg.Go(func() {
			fullOut, fullErr = tryGit(g.env, full, "-c", "protocol.version=2", "fetch", "--quiet", "--no-tags",
				"origin", "+"+tip+":refs/remotes/origin/main")
		})
		for i := range 4 {
			sha := shas[2+i*2+round%2]
			wg.Go(func() { _, _ = g.checkout(t, "acme/app", sha, goodToken) })
		}
		wg.Wait()
		shallow, _ := os.ReadFile(filepath.Join(full, ".git", "shallow"))
		count, _ := tryGit(g.env, full, "rev-list", "--count", tip)
		if fullErr != nil || len(shallow) > 0 || strings.TrimSpace(count) != want {
			t.Fatalf("round %d: whole-history fetch err=%v %q, shallow %q, %s commits, want %s",
				round, fullErr, strings.TrimSpace(fullOut), strings.TrimSpace(string(shallow)), strings.TrimSpace(count), want)
		}
	}
}

// refusingSeeds is the cache service refusing every seed save as too large,
// and remembering it: the lookups after a refusal answer not writable.
type refusingSeeds struct {
	memorySeeds
	attempts atomic.Int32
}

func (r *refusingSeeds) Save(context.Context, string) error {
	r.attempts.Add(1)
	r.mu.Lock()
	r.writable = false
	r.mu.Unlock()
	return errors.New("gitmirror: saving the seed answered 413")
}

// A repository whose seed the cache service refuses is not downloaded whole
// in the background by every writable job.
func TestARefusedSeedIsNotRebuiltByEveryJob(t *testing.T) {
	gitPath := requireGit(t)
	fake := newFakeGitHub(t, gitPath)
	repo := fake.newRepository(t, "acme/app")
	basicHistory(repo)
	sha := runGit(t, repo.env, repo.bare, "rev-parse", "refs/heads/main")
	seeds := &refusingSeeds{memorySeeds: memorySeeds{repository: "acme/app", writable: true}}

	for range 3 {
		g := startGuest(t, fake, seeds)
		if _, err := g.checkout(t, "acme/app", sha, goodToken); err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		_ = g.service.Close(ctx)
		cancel()
	}
	if attempts := seeds.attempts.Load(); attempts != 1 {
		t.Fatalf("%d jobs built a seed the cache service refuses, want only the first", attempts)
	}
}

// A job that points GIT_SSL_CAINFO at a bundle of its own replaces the CA
// bundle the guest gave git for github.com. The guest's CA directory is still
// trusted, so the job's fetches still reach the mirror instead of failing TLS.
func TestAJobThatSetsGitSSLCAInfoStillUsesTheMirror(t *testing.T) {
	gitPath := requireGit(t)
	fake := newFakeGitHub(t, gitPath)
	repo := fake.newRepository(t, "acme/app")
	basicHistory(repo)
	sha := runGit(t, repo.env, repo.bare, "rev-parse", "refs/heads/main")
	g := startGuest(t, fake, seeded(repo.seedBundle()))
	own := filepath.Join(t.TempDir(), "own-roots.pem")
	if err := os.WriteFile(own, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: fake.server.Certificate().Raw}), 0o644); err != nil {
		t.Fatal(err)
	}
	g.env = append(g.env, "GIT_SSL_CAINFO="+own)

	fake.sent.Store(0)
	path, err := g.checkout(t, "acme/app", sha, goodToken)
	if err != nil {
		t.Fatalf("a job that sets GIT_SSL_CAINFO could not fetch github.com: %v", err)
	}
	assertCheckedOut(t, g.env, path, sha, repo)
	if sent := fake.sent.Load(); sent > 16<<10 {
		t.Fatalf("GitHub sent %d bytes; the mirror should have answered", sent)
	}
}

// A credential for another repository, or none, never reads the seed,
// whatever spelling of the job's repository the request path uses, even
// after that credential's ref listing of another repository was remembered.
func TestACredentialForAnotherRepositoryNeverReadsTheSeed(t *testing.T) {
	const appToken, libToken = "ghs_token_for_acme_app_only", "ghs_token_for_acme_lib_only"
	gitPath := requireGit(t)
	tokens := map[string]string{appToken: "acme/app", libToken: "acme/lib"}
	fake := &fakeGitHub{t: t, root: t.TempDir()}
	backend := &cgi.Handler{
		Path: gitPath, Args: []string{"http-backend"},
		Env: []string{"GIT_PROJECT_ROOT=" + fake.root, "GIT_HTTP_EXPORT_ALL=1",
			"GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=" + os.DevNull},
		InheritEnv: []string{"PATH"},
	}
	fake.server = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		segments := strings.SplitN(strings.TrimPrefix(r.URL.Path, "/"), "/", 3)
		repository := ""
		if len(segments) >= 2 {
			repository = strings.ToLower(segments[0] + "/" + strings.TrimSuffix(segments[1], ".git"))
		}
		if user, password, ok := r.BasicAuth(); !ok || user != "x-access-token" || tokens[password] != repository {
			w.Header().Set("WWW-Authenticate", `Basic realm="GitHub"`)
			http.Error(w, "authentication required", http.StatusUnauthorized)
			return
		}
		for _, suffix := range []string{"/info/refs", "/git-upload-pack"} {
			if prefix, ok := strings.CutSuffix(r.URL.Path, suffix); ok && !strings.HasSuffix(prefix, ".git") {
				r.URL.Path = prefix + ".git" + suffix
			}
		}
		backend.ServeHTTP(w, r)
	}))
	t.Cleanup(fake.server.Close)
	app := fake.newRepository(t, "acme/app")
	basicHistory(app)
	lib := fake.newRepository(t, "acme/lib")
	basicHistory(lib)
	sha := runGit(t, app.env, app.bare, "rev-parse", "refs/heads/main")
	g := startGuest(t, fake, seeded(app.seedBundle()))

	basic := func(token string) string {
		return "Basic " + base64.StdEncoding.EncodeToString([]byte("x-access-token:"+token))
	}
	do := func(method, rawPath, authorization string, body []byte) *httptest.ResponseRecorder {
		request := httptest.NewRequestWithContext(t.Context(), method, "https://github.com"+rawPath, bytes.NewReader(body))
		request.Header.Set("Git-Protocol", "version=2")
		if authorization != "" {
			request.Header.Set("Authorization", authorization)
		}
		recorder := httptest.NewRecorder()
		g.service.serveGitHub(recorder, request)
		return recorder
	}
	if got := do(http.MethodPost, "/acme/app/git-upload-pack", basic(appToken), fetchBody(sha)); !bytes.Contains(got.Body.Bytes(), []byte("packfile")) {
		t.Fatalf("the job's own token got %d %q, want a pack", got.Code, firstBytes(got.Body.Bytes()))
	}
	if got := do(http.MethodGet, "/acme/lib/info/refs?service=git-upload-pack", basic(libToken), nil); got.Code != http.StatusOK {
		t.Fatalf("lib's ref listing with lib's token: %d", got.Code)
	}
	if got := do(http.MethodGet, "/acme/app/info/refs?service=git-upload-pack", basic(libToken), nil); got.Code == http.StatusOK {
		t.Fatal("app's ref listing with lib's token answered 200")
	}
	for _, path := range []string{
		"/acme/app/git-upload-pack",
		"/ACME/App/git-upload-pack",
		"/acme/app.git/git-upload-pack",
		"/acme/App.git/git-upload-pack",
		"/acme%2Fapp/git-upload-pack",
		"/acme/%61pp/git-upload-pack",
		"//acme/app/git-upload-pack",
		"/acme/lib/../app/git-upload-pack",
	} {
		for name, authorization := range map[string]string{"lib's token": basic(libToken), "no credential": "", "garbage": "Bearer x"} {
			if got := do(http.MethodPost, path, authorization, fetchBody(sha)); bytes.Contains(got.Body.Bytes(), []byte("packfile")) {
				t.Errorf("%s with %s got a pack (%d)", path, name, got.Code)
			}
		}
	}
}
