package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Fanzzzd/erainfra/apps/cache-service/internal/adminapi"
)

const testKey = "erainfra-cache-service-test-signing-key-0123456789"

// stub is a cache service that checks admin signatures with the real verifier
// and records what it was asked.
type stub struct {
	*httptest.Server
	mu       sync.Mutex
	requests []*http.Request
}

func newStub(t *testing.T) *stub {
	t.Helper()
	verifier, err := adminapi.NewVerifier([]byte(testKey))
	if err != nil {
		t.Fatal(err)
	}
	s := &stub{}
	s.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if err := verifier.Verify(r, body); err != nil {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"message":"unauthorized"}`))
			return
		}
		s.mu.Lock()
		s.requests = append(s.requests, r)
		s.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		created := time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC)
		entry := adminapi.Entry{
			Key: "node-cache-linux-pnpm-abc", Version: strings.Repeat("ab", 32), Ref: "refs/heads/main",
			SizeInBytes: 3 << 20, CreatedAt: created, LastAccessedAt: created.Add(time.Hour),
		}
		if r.Method == http.MethodGet {
			_ = json.NewEncoder(w).Encode(adminapi.ListResponse{
				Repository: r.URL.Query().Get("repository"), TotalCount: 1, TotalBytes: entry.SizeInBytes,
				Page: 1, PerPage: 50, Entries: []adminapi.Entry{entry},
			})
			return
		}
		_ = json.NewEncoder(w).Encode(adminapi.DeleteResponse{
			Repository: r.URL.Query().Get("repository"), DeletedCount: 1,
			DeletedBytes: entry.SizeInBytes, Entries: []adminapi.Entry{entry},
		})
	}))
	t.Cleanup(s.Close)
	return s
}

func (s *stub) seen() []*http.Request {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]*http.Request(nil), s.requests...)
}

type outcome struct {
	code   int
	stdout string
	stderr string
}

func runWith(t *testing.T, s *stub, stdin string, interactive bool, args ...string) outcome {
	t.Helper()
	keyFile := filepath.Join(t.TempDir(), "cache-signing-key")
	if err := os.WriteFile(keyFile, []byte(testKey+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	vars := map[string]string{
		"ERAINFRA_CACHE_ADMIN_URL":        s.URL,
		"ERAINFRA_CACHE_SIGNING_KEY_FILE": keyFile,
	}
	var stdout, stderr bytes.Buffer
	code := runAdmin(context.Background(), args, adminEnv{
		getenv: func(name string) string { return vars[name] },
		stdin:  strings.NewReader(stdin), stdout: &stdout, stderr: &stderr,
		interactive: interactive,
	})
	return outcome{code: code, stdout: stdout.String(), stderr: stderr.String()}
}

func TestListSendsASignedFilteredRequestAndPrintsJSON(t *testing.T) {
	s := newStub(t)
	got := runWith(t, s, "", false, "list", "--repo", "Fanzzzd/erainfra", "--prefix", "node-cache-",
		"--scope", "refs/heads/main", "--sort-by", "size", "--sort-direction", "asc", "--per-page", "10")
	if got.code != 0 {
		t.Fatalf("exit %d, stderr %q", got.code, got.stderr)
	}
	var response adminapi.ListResponse
	if err := json.Unmarshal([]byte(got.stdout), &response); err != nil {
		t.Fatalf("stdout is not the JSON response: %v\n%s", err, got.stdout)
	}
	if response.TotalCount != 1 || response.Entries[0].Key != "node-cache-linux-pnpm-abc" {
		t.Fatalf("response = %+v", response)
	}
	requests := s.seen()
	if len(requests) != 1 || requests[0].Method != http.MethodGet {
		t.Fatalf("requests = %d, want one GET", len(requests))
	}
	query := requests[0].URL.Query()
	for name, want := range map[string]string{
		"repository": "Fanzzzd/erainfra", "prefix": "node-cache-", "ref": "refs/heads/main",
		"sort": "size", "direction": "asc", "per_page": "10",
	} {
		if got := query.Get(name); got != want {
			t.Errorf("query %s = %q, want %q", name, got, want)
		}
	}
}

func TestListTablePrintsOneRowPerEntry(t *testing.T) {
	s := newStub(t)
	got := runWith(t, s, "", false, "list", "--repo", "Fanzzzd/erainfra", "--format", "table")
	if got.code != 0 {
		t.Fatalf("exit %d, stderr %q", got.code, got.stderr)
	}
	for _, want := range []string{"KEY", "LAST USED", "node-cache-linux-pnpm-abc", "abababababab ", "3.0 MiB", "1 of 1 entries"} {
		if !strings.Contains(got.stdout, want) {
			t.Errorf("table lacks %q:\n%s", want, got.stdout)
		}
	}
}

// A delete never happens by accident: not from a script that forgot --yes, and
// not from a human who did not answer yes.
func TestDeleteAsksFirstAndRefusesWithoutATerminal(t *testing.T) {
	s := newStub(t)
	args := []string{"delete", "--repo", "Fanzzzd/erainfra", "--key", "k"}

	if got := runWith(t, s, "", false, args...); got.code != 2 || !strings.Contains(got.stderr, "--yes") {
		t.Fatalf("non-interactive without --yes: exit %d, stderr %q", got.code, got.stderr)
	}
	if got := runWith(t, s, "n\n", true, args...); got.code != 0 || !strings.Contains(got.stderr, "nothing deleted") {
		t.Fatalf("answered no: exit %d, stderr %q", got.code, got.stderr)
	}
	if len(s.seen()) != 0 {
		t.Fatal("a delete reached the service without consent")
	}
	if got := runWith(t, s, "y\n", true, args...); got.code != 0 {
		t.Fatalf("answered yes: exit %d, stderr %q", got.code, got.stderr)
	}
	if got := runWith(t, s, "", false, append(args, "--yes", "--version", "v1")...); got.code != 0 {
		t.Fatalf("--yes: exit %d, stderr %q", got.code, got.stderr)
	}
	requests := s.seen()
	if len(requests) != 2 {
		t.Fatalf("%d deletes reached the service, want 2", len(requests))
	}
	last := requests[1]
	if last.Method != http.MethodDelete || last.URL.Query().Get("key") != "k" ||
		last.URL.Query().Get("version") != "v1" || last.URL.Query().Has("all") {
		t.Fatalf("delete sent %s %s", last.Method, last.URL.RawQuery)
	}
}

func TestClearSendsAllAndPrintsWhatWentInTableForm(t *testing.T) {
	s := newStub(t)
	got := runWith(t, s, "", false, "clear", "--repo", "Fanzzzd/erainfra", "--yes", "--format", "table")
	if got.code != 0 {
		t.Fatalf("exit %d, stderr %q", got.code, got.stderr)
	}
	if !strings.Contains(got.stdout, "deleted 1 entries (3.0 MiB) from Fanzzzd/erainfra") {
		t.Fatalf("stdout = %q", got.stdout)
	}
	requests := s.seen()
	if len(requests) != 1 {
		t.Fatalf("%d requests", len(requests))
	}
	if query := requests[0].URL.Query(); query.Get("all") != "true" || query.Get("repository") != "Fanzzzd/erainfra" {
		t.Fatalf("clear sent %s", requests[0].URL.RawQuery)
	}
}

func TestUsageMistakesExitTwoAndSendNothing(t *testing.T) {
	s := newStub(t)
	for name, args := range map[string][]string{
		"no command":         {},
		"unknown command":    {"purge"},
		"no repo":            {"list"},
		"wildcard repo":      {"clear", "--repo", "*", "--yes"},
		"bare name":          {"list", "--repo", "erainfra"},
		"key and prefix":     {"delete", "--repo", "a/b", "--key", "k", "--prefix", "p", "--yes"},
		"neither":            {"delete", "--repo", "a/b", "--yes"},
		"positional key":     {"delete", "--repo", "a/b", "k", "--yes"},
		"bad format":         {"list", "--repo", "a/b", "--format", "yaml"},
		"undefined flag":     {"list", "--repo", "a/b", "--colour"},
		"clear takes no key": {"clear", "--repo", "a/b", "--key", "k", "--yes"},
	} {
		if got := runWith(t, s, "", false, args...); got.code != 2 {
			t.Errorf("%s: exit %d, want 2 (stderr %q)", name, got.code, got.stderr)
		}
	}
	if len(s.seen()) != 0 {
		t.Fatal("a malformed command reached the service")
	}
}

func TestAWrongKeyIsReportedAndExitsOne(t *testing.T) {
	s := newStub(t)
	wrong := filepath.Join(t.TempDir(), "wrong")
	if err := os.WriteFile(wrong, []byte("a-different-key-that-is-also-long-enough-000000"), 0o600); err != nil {
		t.Fatal(err)
	}
	got := runWith(t, s, "", false, "list", "--repo", "Fanzzzd/erainfra", "--key-file", wrong)
	if got.code != 1 || !strings.Contains(got.stderr, "401") {
		t.Fatalf("exit %d, stderr %q; want 1 and the service's 401", got.code, got.stderr)
	}
	short := filepath.Join(t.TempDir(), "short")
	if err := os.WriteFile(short, []byte("short"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := runWith(t, s, "", false, "list", "--repo", "a/b", "--key-file", short); got.code != 1 {
		t.Fatalf("a short key: exit %d, want 1", got.code)
	}
}

// With no URL given, the CLI reaches the service on this host at the port the
// service itself listens on, whichever way the listen address is spelled.
func TestDefaultURLFollowsTheListenAddress(t *testing.T) {
	for listen, want := range map[string]string{
		"":               "http://127.0.0.1:8721",
		":9000":          "http://127.0.0.1:9000",
		"0.0.0.0:9001":   "http://127.0.0.1:9001",
		"[::]:9002":      "http://127.0.0.1:9002",
		"127.0.0.1:9003": "http://127.0.0.1:9003",
	} {
		vars := map[string]string{"ERAINFRA_CACHE_LISTEN": listen, "ERAINFRA_CACHE_SIGNING_KEY": testKey}
		client, err := commonFlags{}.client(adminEnv{getenv: func(name string) string { return vars[name] }})
		if err != nil {
			t.Fatal(err)
		}
		if client.BaseURL != want {
			t.Errorf("ERAINFRA_CACHE_LISTEN=%q: URL %q, want %q", listen, client.BaseURL, want)
		}
	}
}

// --url wins over the environment, which is how an operator points one command
// at a second replica.
func TestURLFlagWinsOverTheEnvironment(t *testing.T) {
	s := newStub(t)
	other := newStub(t)
	got := runWith(t, s, "", false, "list", "--repo", "a/b", "--url", other.URL)
	if got.code != 0 {
		t.Fatalf("exit %d, stderr %q", got.code, got.stderr)
	}
	if len(s.seen()) != 0 || len(other.seen()) != 1 {
		t.Fatalf("requests: env URL %d, --url %d; want 0 and 1", len(s.seen()), len(other.seen()))
	}
}
