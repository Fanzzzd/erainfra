package controller

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Fanzzzd/erainfra/apps/cache-service/cachetoken"
	"github.com/Fanzzzd/erainfra/apps/controller/internal/cachefacts"
	"github.com/Fanzzzd/erainfra/apps/controller/internal/githubapi"
	"github.com/actions/scaleset"
)

const (
	testRepoID   = 1001
	testForkID   = 2002
	testRunID    = 77
	testHeadSHA  = "1111111111111111111111111111111111111111"
	testRepoName = "Fanzzzd/erainfra"
)

var testSigningKey = []byte("0123456789abcdef0123456789abcdef")

// fakeGitHub serves the three REST endpoints the cache scope reads. Everything
// it does not know is a 404, as on GitHub.
type fakeGitHub struct {
	run           map[string]any
	defaultBranch string
	refs          map[string]bool // "tags/v1", "heads/main"
	status        int             // non-zero: every request answers this
	block         chan struct{}   // non-nil: every request waits for it or the client
	runRequests   atomic.Int32
	refRequests   atomic.Int32
}

func (g *fakeGitHub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if g.block != nil {
		select {
		case <-g.block:
		case <-r.Context().Done():
			return
		}
	}
	if g.status != 0 {
		w.WriteHeader(g.status)
		return
	}
	if r.Header.Get("Authorization") != "Bearer test-pat" {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	repo := "/repos/" + testRepoName
	switch {
	case r.URL.Path == repo+"/actions/runs/"+strconv.Itoa(testRunID) && g.run != nil:
		g.runRequests.Add(1)
		_ = json.NewEncoder(w).Encode(g.run)
	case r.URL.Path == repo && g.defaultBranch != "":
		_ = json.NewEncoder(w).Encode(map[string]any{"full_name": testRepoName, "default_branch": g.defaultBranch})
	case strings.HasPrefix(r.URL.Path, repo+"/git/ref/"):
		g.refRequests.Add(1)
		if g.refs[strings.TrimPrefix(r.URL.Path, repo+"/git/ref/")] {
			_ = json.NewEncoder(w).Encode(map[string]any{"ref": "refs/" + strings.TrimPrefix(r.URL.Path, repo+"/git/ref/")})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

// fakeCacheService is the cache service's facts endpoint: it checks the HMAC the
// controller signs with and records the decoded body.
type fakeCacheService struct {
	mu     sync.Mutex
	pushed []wireFacts
}

type wireFacts struct {
	Runner         string `json:"runner"`
	Repository     string `json:"repository"`
	HeadRepository string `json:"headRepository"`
	Event          string `json:"event"`
	Ref            string `json:"ref"`
	BaseRef        string `json:"baseRef"`
	DefaultBranch  string `json:"defaultBranch"`
}

func (c *fakeCacheService) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	mac := hmac.New(sha256.New, testSigningKey)
	mac.Write(body)
	if r.URL.Path != "/_erainfra-cache-admin/facts" ||
		!hmac.Equal([]byte(r.Header.Get("X-Erainfra-Cache-Admin")), []byte(hex.EncodeToString(mac.Sum(nil)))) {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	var facts wireFacts
	if err := json.Unmarshal(body, &facts); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	c.mu.Lock()
	c.pushed = append(c.pushed, facts)
	c.mu.Unlock()
	w.WriteHeader(http.StatusNoContent)
}

func (c *fakeCacheService) all() []wireFacts {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]wireFacts(nil), c.pushed...)
}

func run(event, headBranch string, fields map[string]any) map[string]any {
	body := map[string]any{
		"id":              testRunID,
		"event":           event,
		"head_branch":     headBranch,
		"head_sha":        testHeadSHA,
		"path":            ".github/workflows/ci.yml",
		"repository":      map[string]any{"id": testRepoID, "full_name": testRepoName},
		"head_repository": map[string]any{"id": testRepoID, "full_name": testRepoName},
		"pull_requests":   []any{},
	}
	for key, value := range fields {
		body[key] = value
	}
	return body
}

func pullRequest(number int, headRef string, headRepoID int, baseRef string, baseRepoID int) map[string]any {
	return map[string]any{
		"number": number,
		"head":   map[string]any{"ref": headRef, "sha": testHeadSHA, "repo": map[string]any{"id": headRepoID}},
		"base":   map[string]any{"ref": baseRef, "sha": "2222", "repo": map[string]any{"id": baseRepoID}},
	}
}

func startedJob(runner, workflowRef, event string) *scaleset.JobStarted {
	return &scaleset.JobStarted{
		RunnerName: runner,
		JobMessageBase: scaleset.JobMessageBase{
			OwnerName:      "Fanzzzd",
			RepositoryName: "erainfra",
			JobWorkflowRef: workflowRef,
			WorkflowRunID:  testRunID,
			EventName:      event,
		},
	}
}

// publish runs jobs through a Scaler wired to a real GitHub API client against
// github and a real cache facts client against a fake cache service, and returns
// what reached the service.
func publish(t *testing.T, github *fakeGitHub, budget time.Duration, jobs ...*scaleset.JobStarted) []wireFacts {
	t.Helper()
	githubServer := httptest.NewServer(github)
	t.Cleanup(githubServer.Close)
	if github.block != nil {
		// Unblock before the server closes, or Close waits on the handlers.
		t.Cleanup(func() { close(github.block) })
	}
	service := &fakeCacheService{}
	serviceServer := httptest.NewServer(service)
	t.Cleanup(serviceServer.Close)

	runs, err := githubapi.New(githubapi.Config{APIURL: githubServer.URL, Token: "test-pat"})
	if err != nil {
		t.Fatal(err)
	}
	publisher, err := cachefacts.New(serviceServer.URL, testSigningKey, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	store := &fakeStore{}
	scaler, err := NewScaler(
		validConfig("rc-linux-js", 1),
		store,
		&fakeIssuer{},
		names("unused"),
		WithCachePublisher(publisher, nil),
		WithWorkflowRuns(runs),
	)
	if err != nil {
		t.Fatal(err)
	}
	if budget > 0 {
		scaler.cacheScopeBudget = budget
	}
	for _, job := range jobs {
		if err := scaler.HandleJobStarted(t.Context(), job); err != nil {
			t.Fatal(err)
		}
	}
	// MarkJobStarted never waits on the publish.
	if len(store.started) != len(jobs) {
		t.Fatalf("recorded %d job starts, want %d", len(store.started), len(jobs))
	}
	scaler.publishing.Wait()
	return service.all()
}

// scope is the cache service's own decision over what was pushed.
func scope(t *testing.T, facts wireFacts) cachetoken.Claims {
	t.Helper()
	claims, err := cachetoken.Scope(cachetoken.JobFacts{
		Repository:     facts.Repository,
		HeadRepository: facts.HeadRepository,
		Event:          facts.Event,
		Ref:            facts.Ref,
		BaseRef:        facts.BaseRef,
		DefaultBranch:  facts.DefaultBranch,
	})
	if err != nil {
		t.Fatalf("the cache service would refuse %#v: %v", facts, err)
	}
	return claims
}

func onlyFacts(t *testing.T, pushed []wireFacts) wireFacts {
	t.Helper()
	if len(pushed) != 1 {
		t.Fatalf("pushed %d facts, want 1: %#v", len(pushed), pushed)
	}
	return pushed[0]
}

func assertScope(t *testing.T, claims cachetoken.Claims, write bool, reads ...string) {
	t.Helper()
	if claims.CanWrite() != write {
		t.Fatalf("CanWrite = %v, want %v (claims %#v)", claims.CanWrite(), write, claims)
	}
	if got := claims.ReadScopes(); !slices.Equal(got, reads) {
		t.Fatalf("ReadScopes = %q, want %q", got, reads)
	}
}

// A push to a feature branch from the run's own workflow: the job's workflow ref
// names the run's ref, it agrees with head_branch, and the job reads and writes
// its own branch and reads the default branch.
func TestCacheScopeBranchPush(t *testing.T) {
	github := &fakeGitHub{run: run("push", "feature/x", nil), defaultBranch: "main"}
	facts := onlyFacts(t, publish(t, github, 0,
		startedJob("rc-a", "Fanzzzd/erainfra/.github/workflows/ci.yml@refs/heads/feature/x", "push")))

	want := wireFacts{
		Runner:         "rc-a",
		Repository:     testRepoName,
		HeadRepository: testRepoName,
		Event:          "push",
		Ref:            "refs/heads/feature/x",
		DefaultBranch:  "refs/heads/main",
	}
	if facts != want {
		t.Fatalf("facts = %#v, want %#v", facts, want)
	}
	claims := scope(t, facts)
	assertScope(t, claims, true, "refs/heads/feature/x", "refs/heads/main")
	if claims.WriteScope() != "refs/heads/feature/x" {
		t.Fatalf("WriteScope = %q", claims.WriteScope())
	}
	if github.refRequests.Load() != 0 {
		t.Fatalf("asked git about refs %d times; the top-level workflow ref already said", github.refRequests.Load())
	}
}

// A job in a reusable workflow called at @main carries main in its workflow ref.
// The run says the push was to feature, so feature is what the job writes: the
// workflow ref must not hand a feature branch write access to main's cache. The
// same holds when the top-level workflow calls itself at main.
func TestCacheScopeReusableWorkflowDoesNotWriteTheCalleesRef(t *testing.T) {
	for name, workflowRef := range map[string]string{
		"another file":          "Fanzzzd/erainfra/.github/workflows/reusable.yml@refs/heads/main",
		"another repository":    "Fanzzzd/shared/.github/workflows/ci.yml@refs/heads/main",
		"the same file at main": "Fanzzzd/erainfra/.github/workflows/ci.yml@refs/heads/main",
	} {
		t.Run(name, func(t *testing.T) {
			github := &fakeGitHub{run: run("push", "feature", nil), defaultBranch: "main"}
			facts := onlyFacts(t, publish(t, github, 0, startedJob("rc-a", workflowRef, "push")))
			if facts.Ref != "refs/heads/feature" {
				t.Fatalf("Ref = %q, want refs/heads/feature", facts.Ref)
			}
			claims := scope(t, facts)
			assertScope(t, claims, true, "refs/heads/feature", "refs/heads/main")
			if claims.WriteScope() != "refs/heads/feature" {
				t.Fatalf("WriteScope = %q, want refs/heads/feature", claims.WriteScope())
			}
		})
	}
}

// A same-repository pull request writes only to its merge ref and reads its base
// branch and the default branch, as on GitHub. A pull request listed for the run
// whose base is another repository is not mistaken for it.
func TestCacheScopeSameRepositoryPullRequest(t *testing.T) {
	github := &fakeGitHub{
		run: run("pull_request", "feature", map[string]any{
			"pull_requests": []any{
				pullRequest(9, "feature", testRepoID, "main", 3003), // into someone's fork
				pullRequest(42, "feature", testRepoID, "develop", testRepoID),
			},
		}),
		defaultBranch: "main",
	}
	facts := onlyFacts(t, publish(t, github, 0,
		startedJob("rc-a", "Fanzzzd/erainfra/.github/workflows/ci.yml@refs/pull/42/merge", "pull_request")))

	want := wireFacts{
		Runner:         "rc-a",
		Repository:     testRepoName,
		HeadRepository: testRepoName,
		Event:          "pull_request",
		Ref:            "refs/pull/42/merge",
		BaseRef:        "refs/heads/develop",
		DefaultBranch:  "refs/heads/main",
	}
	if facts != want {
		t.Fatalf("facts = %#v, want %#v", facts, want)
	}
	claims := scope(t, facts)
	assertScope(t, claims, true, "refs/pull/42/merge", "refs/heads/develop", "refs/heads/main")
	if claims.WriteScope() != "refs/pull/42/merge" {
		t.Fatalf("WriteScope = %q", claims.WriteScope())
	}
}

// A pull request from a fork: GitHub lists no pull request for the run, the head
// repository is the fork, and the job reads the default branch and writes nothing.
func TestCacheScopeForkPullRequestIsReadOnly(t *testing.T) {
	github := &fakeGitHub{
		run: run("pull_request", "main", map[string]any{
			"head_repository": map[string]any{"id": testForkID, "full_name": "attacker/erainfra"},
		}),
		defaultBranch: "main",
	}
	facts := onlyFacts(t, publish(t, github, 0,
		startedJob("rc-a", "Fanzzzd/erainfra/.github/workflows/ci.yml@refs/pull/43/merge", "pull_request")))

	if facts.HeadRepository != "attacker/erainfra" || facts.BaseRef != "" {
		t.Fatalf("facts = %#v, want the fork named as head and no base", facts)
	}
	assertScope(t, scope(t, facts), false, "refs/heads/main")
}

// A fork pull request that GitHub does list for the run reads its real base.
func TestCacheScopeForkPullRequestReadsItsBase(t *testing.T) {
	github := &fakeGitHub{
		run: run("pull_request", "patch-1", map[string]any{
			"head_repository": map[string]any{"id": testForkID, "full_name": "contributor/erainfra"},
			"pull_requests":   []any{pullRequest(44, "patch-1", testForkID, "release", testRepoID)},
		}),
		defaultBranch: "main",
	}
	facts := onlyFacts(t, publish(t, github, 0,
		startedJob("rc-a", "Fanzzzd/erainfra/.github/workflows/ci.yml@refs/pull/44/merge", "pull_request")))
	assertScope(t, scope(t, facts), false, "refs/heads/release", "refs/heads/main")
}

// A tag push scopes to refs/tags/<tag>, both from the run's own workflow and from
// a reusable workflow, where git is asked whether the name is a tag.
func TestCacheScopeTagPush(t *testing.T) {
	for name, workflowRef := range map[string]string{
		"top-level workflow": "Fanzzzd/erainfra/.github/workflows/ci.yml@refs/tags/v1.2.0",
		"reusable workflow":  "Fanzzzd/erainfra/.github/workflows/release.yml@refs/heads/main",
	} {
		t.Run(name, func(t *testing.T) {
			github := &fakeGitHub{
				run:           run("push", "v1.2.0", nil),
				defaultBranch: "main",
				refs:          map[string]bool{"tags/v1.2.0": true},
			}
			facts := onlyFacts(t, publish(t, github, 0, startedJob("rc-a", workflowRef, "push")))
			if facts.Ref != "refs/tags/v1.2.0" {
				t.Fatalf("Ref = %q, want refs/tags/v1.2.0", facts.Ref)
			}
			assertScope(t, scope(t, facts), true, "refs/tags/v1.2.0", "refs/heads/main")
		})
	}
}

// A name that is both a branch and a tag cannot be resolved without the job's own
// ref, so the job gets cold facts rather than a guess.
func TestCacheScopeAmbiguousRefIsCold(t *testing.T) {
	github := &fakeGitHub{
		run:           run("push", "v2", nil),
		defaultBranch: "main",
		refs:          map[string]bool{"tags/v2": true, "heads/v2": true},
	}
	facts := onlyFacts(t, publish(t, github, 0,
		startedJob("rc-a", "Fanzzzd/shared/.github/workflows/build.yml@refs/heads/main", "push")))
	assertScope(t, scope(t, facts), false)
}

// Any failure to read the run from GitHub, an error answer or no answer within
// the budget, publishes facts that grant nothing: read-only, nothing to read.
func TestCacheScopeLookupFailureIsCold(t *testing.T) {
	cases := map[string]*fakeGitHub{
		"server error": {status: http.StatusInternalServerError},
		"forbidden":    {status: http.StatusForbidden},
		"timeout":      {block: make(chan struct{})},
	}
	for name, github := range cases {
		t.Run(name, func(t *testing.T) {
			began := time.Now()
			facts := onlyFacts(t, publish(t, github, 200*time.Millisecond,
				startedJob("rc-a", "Fanzzzd/erainfra/.github/workflows/ci.yml@refs/heads/main", "push")))
			if elapsed := time.Since(began); elapsed > 3*time.Second {
				t.Fatalf("publishing took %s; the lookup budget did not hold", elapsed)
			}
			want := wireFacts{
				Runner:         "rc-a",
				Repository:     testRepoName,
				HeadRepository: unverifiedHeadRepository,
				Event:          "push",
				Ref:            unresolvedRef,
			}
			if facts != want {
				t.Fatalf("facts = %#v, want %#v", facts, want)
			}
			claims := scope(t, facts)
			assertScope(t, claims, false)
			if claims.WriteScope() != "" {
				t.Fatalf("cold facts have a write scope %q", claims.WriteScope())
			}
		})
	}
}

// A run that GitHub says belongs to another repository is not trusted.
func TestCacheScopeRepositoryMismatchIsCold(t *testing.T) {
	github := &fakeGitHub{
		run: run("push", "main", map[string]any{
			"repository": map[string]any{"id": 9, "full_name": "someone/else"},
		}),
		defaultBranch: "main",
	}
	facts := onlyFacts(t, publish(t, github, 0,
		startedJob("rc-a", "Fanzzzd/erainfra/.github/workflows/ci.yml@refs/heads/main", "push")))
	assertScope(t, scope(t, facts), false)
}

// A matrix starts several jobs from one run; they cost GitHub one run lookup.
func TestCacheScopeMatrixSharesOneRunLookup(t *testing.T) {
	github := &fakeGitHub{run: run("push", "main", nil), defaultBranch: "main"}
	pushed := publish(t, github, 0,
		startedJob("rc-a", "Fanzzzd/erainfra/.github/workflows/ci.yml@refs/heads/main", "push"),
		startedJob("rc-b", "Fanzzzd/erainfra/.github/workflows/ci.yml@refs/heads/main", "push"),
		startedJob("rc-c", "Fanzzzd/erainfra/.github/workflows/ci.yml@refs/heads/main", "push"),
	)
	if len(pushed) != 3 {
		t.Fatalf("pushed %d facts, want 3", len(pushed))
	}
	for _, facts := range pushed {
		assertScope(t, scope(t, facts), true, "refs/heads/main")
	}
	if got := github.runRequests.Load(); got != 1 {
		t.Fatalf("fetched the run %d times, want 1", got)
	}
}
