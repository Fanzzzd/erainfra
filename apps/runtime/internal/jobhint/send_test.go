package jobhint

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const testToken = "runner-bearer-for-tests"

func fastSender(t *testing.T, url string) *Sender {
	t.Helper()
	sender, err := NewSender(url, testToken)
	if err != nil {
		t.Fatal(err)
	}
	sender.Backoff = time.Millisecond
	return sender
}

func TestSendPostsTheHintWithTheRunnerBearer(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != http.MethodPost || r.URL.Path != Path {
			t.Errorf("request = %s %s, want POST %s", r.Method, r.URL.Path, Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer "+testToken {
			t.Errorf("Authorization = %q", got)
		}
		if got := r.Header.Get("Content-Type"); got != "application/json" {
			t.Errorf("Content-Type = %q", got)
		}
		body, _ := io.ReadAll(r.Body)
		// Numbers, not strings: the cache service compares them with GitHub's.
		if want := `{"repository":"octo-org/octo-repo","runID":42820231088,"runAttempt":1}`; string(body) != want {
			t.Errorf("body = %s, want %s", body, want)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	// A trailing slash on the configured URL must not double up in the path.
	if err := fastSender(t, server.URL+"/").Send(t.Context(), fixtureHint); err != nil {
		t.Fatalf("Send: %v", err)
	}
	if calls.Load() != 1 {
		t.Fatalf("calls = %d, want 1", calls.Load())
	}
}

func TestSendRetriesAServerError(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var hint Hint
		if err := json.NewDecoder(r.Body).Decode(&hint); err != nil || hint != fixtureHint {
			t.Errorf("retried body = %+v, %v", hint, err)
		}
		if calls.Add(1) < 3 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	if err := fastSender(t, server.URL).Send(t.Context(), fixtureHint); err != nil {
		t.Fatalf("Send: %v", err)
	}
	if calls.Load() != 3 {
		t.Fatalf("calls = %d, want 3", calls.Load())
	}
}

func TestSendGivesUpOnAClientError(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusBadRequest)
	}))
	defer server.Close()
	err := fastSender(t, server.URL).Send(t.Context(), fixtureHint)
	if err == nil || !strings.Contains(err.Error(), "400") {
		t.Fatalf("Send = %v, want a 400 error", err)
	}
	if calls.Load() != 1 {
		t.Fatalf("calls = %d, want 1: a 4xx is not retried", calls.Load())
	}
}

func TestSendStopsRetryingAtItsBudget(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer server.Close()
	sender := fastSender(t, server.URL)
	sender.Budget = 100 * time.Millisecond
	sender.Backoff = 20 * time.Millisecond
	start := time.Now()
	if err := sender.Send(t.Context(), fixtureHint); err == nil {
		t.Fatal("Send succeeded against a server that only fails")
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("Send took %v, want it bounded by its budget", elapsed)
	}
	if calls.Load() < 2 {
		t.Fatalf("calls = %d, want at least one retry", calls.Load())
	}
}

func TestSendRefusesAnInvalidHint(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("an invalid hint reached the server")
	}))
	defer server.Close()
	if err := fastSender(t, server.URL).Send(t.Context(), Hint{Repository: "nope", RunID: 1, RunAttempt: 1}); err == nil {
		t.Fatal("Send accepted an invalid hint")
	}
}

func TestNewSenderRefusesABadConfiguration(t *testing.T) {
	for _, tc := range []struct{ url, token string }{
		{"", testToken},
		{"not a url", testToken},
		{"ftp://cache.example", testToken},
		{"http://cache.example", ""},
	} {
		if _, err := NewSender(tc.url, tc.token); err == nil {
			t.Errorf("NewSender(%q, %q) succeeded", tc.url, tc.token)
		}
	}
}

func TestRunSendsOnceAndLogsWithoutTheBearer(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "Worker_20261110-081402-utc.log"), []byte(readFixture(t)), 0o644); err != nil {
		t.Fatal(err)
	}
	var lines []string
	Run(t.Context(), Config{
		DiagDir:         dir,
		CacheServiceURL: server.URL,
		RunnerToken:     testToken,
		Logf: func(format string, args ...any) {
			lines = append(lines, strings.TrimSpace(fmt.Sprintf(format, args...)))
		},
	})
	if calls.Load() != 1 {
		t.Fatalf("calls = %d, want 1", calls.Load())
	}
	if len(lines) != 1 || !strings.Contains(lines[0], "octo-org/octo-repo") || strings.Contains(lines[0], testToken) {
		t.Fatalf("log = %q, want one line naming the repository and not the bearer", lines)
	}
}
