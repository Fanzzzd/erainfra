package githubapi

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/actions/scaleset"
	"github.com/golang-jwt/jwt/v4"
)

func TestAPIURL(t *testing.T) {
	for registration, want := range map[string]string{
		"https://github.com/Fanzzzd/erainfra":     "https://api.github.com",
		"https://www.github.com/Fanzzzd":          "https://api.github.com",
		"https://tenant.ghe.com/enterprises/acme": "https://api.tenant.ghe.com",
		"https://ghes.example.com/org/repo/":      "https://ghes.example.com/api/v3",
	} {
		got, err := APIURL(registration)
		if err != nil || got != want {
			t.Fatalf("APIURL(%q) = %q, %v; want %q", registration, got, err, want)
		}
	}
	if _, err := APIURL("not a url"); err == nil {
		t.Fatal("APIURL accepted a URL with no scheme or host")
	}
}

func testKey(t *testing.T) (*rsa.PrivateKey, string) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	encoded := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
	return key, string(encoded)
}

// An App's installation token is minted once from a JWT the App's key signs, and
// reused for later lookups until it nears expiry.
func TestAppInstallationTokenIsCachedUntilNearExpiry(t *testing.T) {
	key, pemKey := testKey(t)
	var minted atomic.Int32
	now := time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/app/installations/99/access_tokens":
			raw := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
			claims := &jwt.RegisteredClaims{}
			if _, err := jwt.ParseWithClaims(raw, claims, func(*jwt.Token) (any, error) {
				return &key.PublicKey, nil
			}, jwt.WithoutClaimsValidation()); err != nil || claims.Issuer != "Iv1.client" {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			n := minted.Add(1)
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"token":      fmt.Sprintf("ghs_%d", n),
				"expires_at": now.Add(time.Hour).Format(time.RFC3339),
			})
		case r.URL.Path == "/repos/o/r":
			if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ghs_") {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"default_branch": "trunk"})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	client, err := New(Config{
		APIURL: server.URL,
		App:    &scaleset.GitHubAppAuth{ClientID: "Iv1.client", InstallationID: 99, PrivateKey: pemKey},
	})
	if err != nil {
		t.Fatal(err)
	}
	var clock sync.Mutex
	client.now = func() time.Time { clock.Lock(); defer clock.Unlock(); return now }
	advance := func(d time.Duration) { clock.Lock(); now = now.Add(d); clock.Unlock() }

	for range 3 {
		if _, err := client.authorization(t.Context()); err != nil {
			t.Fatal(err)
		}
	}
	branch, err := client.DefaultBranch(t.Context(), "o/r")
	if err != nil || branch != "trunk" {
		t.Fatalf("DefaultBranch = %q, %v", branch, err)
	}
	if got := minted.Load(); got != 1 {
		t.Fatalf("minted %d installation tokens, want 1", got)
	}

	advance(56 * time.Minute) // inside the refresh margin of a one-hour token
	if _, err := client.authorization(t.Context()); err != nil {
		t.Fatal(err)
	}
	if got := minted.Load(); got != 2 {
		t.Fatalf("minted %d installation tokens after nearing expiry, want 2", got)
	}
}

func TestNewRefusesAmbiguousOrBrokenCredentials(t *testing.T) {
	if _, err := New(Config{APIURL: "https://api.github.com"}); err == nil {
		t.Fatal("accepted no credentials")
	}
	if _, err := New(Config{
		APIURL: "https://api.github.com",
		Token:  "pat",
		App:    &scaleset.GitHubAppAuth{ClientID: "c", InstallationID: 1, PrivateKey: "k"},
	}); err == nil {
		t.Fatal("accepted both a token and an App")
	}
	if _, err := New(Config{
		APIURL: "https://api.github.com",
		App:    &scaleset.GitHubAppAuth{ClientID: "c", InstallationID: 1, PrivateKey: "not a key"},
	}); err == nil {
		t.Fatal("accepted an App whose key does not parse")
	}
}

func TestWorkflowRunDecodesTheFieldsTheScopeNeeds(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/repos/o/r/actions/runs/5" || r.Header.Get("Authorization") != "Bearer pat" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = w.Write([]byte(`{
			"id": 5, "event": "pull_request", "head_branch": "feature", "head_sha": "abc",
			"path": ".github/workflows/ci.yml@refs/heads/feature",
			"repository": {"id": 1, "full_name": "o/r"},
			"head_repository": null,
			"pull_requests": [{"number": 3, "head": {"ref": "feature", "sha": "abc", "repo": {"id": 1}},
			                   "base": {"ref": "main", "sha": "def", "repo": {"id": 1}}}]
		}`))
	}))
	defer server.Close()
	client, err := New(Config{APIURL: server.URL, Token: "pat"})
	if err != nil {
		t.Fatal(err)
	}
	run, err := client.WorkflowRun(t.Context(), "o/r", 5)
	if err != nil {
		t.Fatal(err)
	}
	if run.Path != ".github/workflows/ci.yml" || run.HeadRepository != nil || run.Repository.ID != 1 ||
		len(run.PullRequests) != 1 || run.PullRequests[0] != (PullRequest{
		Number: 3, HeadRef: "feature", HeadSHA: "abc", HeadRepoID: 1, BaseRef: "main", BaseRepoID: 1,
	}) {
		t.Fatalf("run = %#v", run)
	}
}

func TestRefExists(t *testing.T) {
	var paths []string
	var mu sync.Mutex
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		paths = append(paths, r.URL.EscapedPath())
		mu.Unlock()
		if r.URL.Path == "/repos/o/r/git/ref/heads/feature/x" {
			_, _ = w.Write([]byte(`{"ref":"refs/heads/feature/x"}`))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()
	client, err := New(Config{APIURL: server.URL, Token: "pat"})
	if err != nil {
		t.Fatal(err)
	}
	if ok, err := client.RefExists(t.Context(), "o/r", "heads/feature/x"); err != nil || !ok {
		t.Fatalf("branch: %v, %v", ok, err)
	}
	if ok, err := client.RefExists(t.Context(), "o/r", "tags/feature/x"); err != nil || ok {
		t.Fatalf("missing tag: %v, %v", ok, err)
	}
	if _, err := client.RefExists(t.Context(), "o/r", "pull/1/merge"); err == nil {
		t.Fatal("accepted a ref outside heads/ and tags/")
	}
	if ok, _ := client.RefExists(t.Context(), "o/r", "tags/a b"); ok {
		t.Fatal("found a ref that does not exist")
	}
	if paths[len(paths)-1] != "/repos/o/r/git/ref/tags/a%20b" {
		t.Fatalf("ref segments were not escaped: %q", paths)
	}
}

// Concurrent lookups of one key make one request; a failure is not remembered;
// a success is, until it expires.
func TestMemo(t *testing.T) {
	now := time.Unix(0, 0)
	m := newMemo[int](time.Minute, 2, func() time.Time { return now })
	var calls atomic.Int32
	release := make(chan struct{})
	var wg sync.WaitGroup
	for range 5 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			value, err := m.get(context.Background(), "k", func() (int, error) {
				calls.Add(1)
				<-release
				return 7, nil
			})
			if err != nil || value != 7 {
				t.Errorf("get = %d, %v", value, err)
			}
		}()
	}
	time.Sleep(20 * time.Millisecond)
	close(release)
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatalf("five concurrent lookups made %d requests", calls.Load())
	}

	failing := errors.New("boom")
	if _, err := m.get(context.Background(), "bad", func() (int, error) { return 0, failing }); !errors.Is(err, failing) {
		t.Fatal(err)
	}
	if value, err := m.get(context.Background(), "bad", func() (int, error) { return 1, nil }); err != nil || value != 1 {
		t.Fatalf("a failure was remembered: %d, %v", value, err)
	}

	now = now.Add(2 * time.Minute)
	if _, err := m.get(context.Background(), "k", func() (int, error) { calls.Add(1); return 8, nil }); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 2 {
		t.Fatal("an expired entry was served")
	}
	_, _ = m.get(context.Background(), "c", func() (int, error) { return 0, nil })
	if len(m.entries) > 2 {
		t.Fatalf("memo holds %d entries, bound is 2", len(m.entries))
	}
}

func TestDynamicTokenSourceRefreshAndFailClosed(t *testing.T) {
	var requests atomic.Int32
	var credential atomic.Value
	credential.Store("first-token")
	var unavailable atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if got := r.Header.Get("Authorization"); got != "Bearer "+credential.Load().(string) {
			t.Errorf("Authorization = %q", got)
		}
		_, _ = w.Write([]byte(`{"default_branch":"main"}`))
	}))
	defer server.Close()
	client, err := New(Config{
		APIURL: server.URL,
		TokenSource: func(ctx context.Context) (string, error) {
			if err := ctx.Err(); err != nil {
				return "", err
			}
			if unavailable.Load() {
				return "", errors.New("upstream contains secret-token")
			}
			return credential.Load().(string), nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.DefaultBranch(t.Context(), "o/first"); err != nil {
		t.Fatal(err)
	}
	credential.Store("second-token")
	if _, err := client.DefaultBranch(t.Context(), "o/second"); err != nil {
		t.Fatal(err)
	}
	unavailable.Store(true)
	if _, err := client.DefaultBranch(t.Context(), "o/third"); err == nil || strings.Contains(err.Error(), "secret-token") {
		t.Fatalf("unavailable credential error = %v", err)
	}
	if requests.Load() != 2 {
		t.Fatal("unavailable credential sent a request")
	}
	unavailable.Store(false)
	credential.Store("")
	if _, err := client.DefaultBranch(t.Context(), "o/fourth"); err == nil {
		t.Fatal("empty credential was accepted")
	}
	credential.Store("secret\r\nInjected: yes")
	if _, err := client.DefaultBranch(t.Context(), "o/fifth"); err == nil || strings.Contains(err.Error(), "secret") {
		t.Fatalf("invalid token error = %v", err)
	}
	if requests.Load() != 2 {
		t.Fatal("invalid credential sent a request")
	}
}

func TestDynamicTokenSourceIsExclusive(t *testing.T) {
	source := func(context.Context) (string, error) { return "dynamic", nil }
	for _, config := range []Config{
		{Token: "static", TokenSource: source},
		{App: &scaleset.GitHubAppAuth{}, TokenSource: source},
		{Token: "static", App: &scaleset.GitHubAppAuth{}, TokenSource: source},
	} {
		config.APIURL = "https://api.github.com"
		if _, err := New(config); err == nil {
			t.Fatal("ambiguous credential configuration accepted")
		}
	}
}

func TestDynamicTokenRequestsKeepIndependentAuthorization(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, repository, _ := strings.Cut(strings.TrimPrefix(r.URL.Path, "/repos/"), "/")
		if got := r.Header.Get("Authorization"); got != "Bearer "+repository {
			t.Errorf("Authorization = %q for %s", got, r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"default_branch":"main"}`))
	}))
	defer server.Close()
	client, err := New(Config{APIURL: server.URL, TokenSource: func(ctx context.Context) (string, error) {
		value, _ := ctx.Value(dynamicTestKey{}).(string)
		return value, nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	var group sync.WaitGroup
	for n := range 30 {
		group.Go(func() {
			name := fmt.Sprintf("repo-%d", n)
			ctx := context.WithValue(t.Context(), dynamicTestKey{}, name)
			if _, err := client.DefaultBranch(ctx, "o/"+name); err != nil {
				t.Error(err)
			}
		})
	}
	group.Wait()
}

type dynamicTestKey struct{}

func TestDynamicTokenClientRejectsRedirectWithoutChangingSharedClient(t *testing.T) {
	var redirected atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/target" {
			redirected.Add(1)
			w.WriteHeader(http.StatusNoContent)
			return
		}
		http.Redirect(w, r, "/target", http.StatusFound)
	}))
	defer server.Close()
	shared := &http.Client{}
	client, err := New(Config{APIURL: server.URL, HTTPClient: shared, TokenSource: func(context.Context) (string, error) { return "secret", nil }})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.DefaultBranch(t.Context(), "o/r"); err == nil {
		t.Fatal("redirect was accepted")
	}
	if redirected.Load() != 0 {
		t.Fatal("redirect target received a request")
	}
	if shared.CheckRedirect != nil {
		t.Fatal("mutated caller-owned HTTP client")
	}
}

func TestRunRunnersListsAssignedUnfinishedJobs(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/repos/o/r/actions/runs/7/jobs" || r.URL.Query().Get("filter") != "latest" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = w.Write([]byte(`{"total_count": 4, "jobs": [
			{"status": "in_progress", "runner_name": "erainfra-4vcpu-ubuntu-2404-a"},
			{"status": "queued", "runner_name": null},
			{"status": "completed", "runner_name": "erainfra-4vcpu-ubuntu-2404-old"},
			{"status": "queued", "runner_name": "erainfra-4vcpu-ubuntu-2404-b"}
		]}`))
	}))
	defer server.Close()
	client, err := New(Config{APIURL: server.URL, Token: "pat"})
	if err != nil {
		t.Fatal(err)
	}
	runners, err := client.RunRunners(t.Context(), "o/r", 7)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(runners, ",") != "erainfra-4vcpu-ubuntu-2404-a,erainfra-4vcpu-ubuntu-2404-b" {
		t.Fatalf("runners = %q", runners)
	}
}
