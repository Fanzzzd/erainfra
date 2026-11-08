package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// uploadRoutes serves a deploy whose every upload URL carries a different one-use token, as
// Convex file storage issues them.
func uploadRoutes(t *testing.T, h *harness, uploadStatus int) (slots, uploads *capture, dir string) {
	t.Helper()
	slots, uploads = &capture{}, &capture{}
	var replies []string
	for i := 1; i <= 6; i++ {
		replies = append(replies, fmt.Sprintf(`{"uploadUrl":"https://fleet.example.test/api/storage/upload?token=secret%d"}`, i))
	}
	h.api.routes["POST /api/v1/deployments/uploads"] = slots.sequence([]int{201}, replies)
	h.api.routes["POST /api/storage/upload"] = uploads.route(uploadStatus, `{"storageId":"kg2storage"}`)
	h.api.tokenless = map[string]bool{"/api/storage/upload": true}
	h.api.on("POST /api/v1/deployments", 202, `{"deployment":{"id":"dep1","app":"site","stage":"queued","detail":"queued"}}`)
	h.api.on("GET /api/v1/deployments/dep1", 200, `{"deployment":{"id":"dep1","app":"site","stage":"done","detail":"deployed"}}`)
	dir = filepath.Join(t.TempDir(), "site")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "Dockerfile"), []byte("FROM scratch\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return slots, uploads, dir
}

// failUploads drops the connection of the first n uploads with err.
func failUploads(h *harness, n int, err error) *int {
	var mu sync.Mutex
	failed := 0
	h.faults = func(r *http.Request) error {
		if r.URL.Path != "/api/storage/upload" {
			return nil
		}
		mu.Lock()
		defer mu.Unlock()
		if failed >= n {
			return nil
		}
		failed++
		return err
	}
	return &failed
}

func tokensOf(c *capture) []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	var tokens []string
	for _, r := range c.requests {
		q, _ := url.ParseQuery(r.query)
		tokens = append(tokens, q.Get("token"))
	}
	return tokens
}

func TestDeployRetriesAnUploadWhoseConnectionDropped(t *testing.T) {
	h := newHarness(t).loggedIn()
	slots, uploads, dir := uploadRoutes(t, h, 200)
	failUploads(h, 2, io.EOF)
	var waits []time.Duration
	h.sleep = func(_ context.Context, d time.Duration) error {
		waits = append(waits, d)
		return nil
	}
	h.expect(ExitOK, "deploy", dir)
	if len(slots.requests) != 3 {
		t.Errorf("asked for %d upload URLs, want a fresh one for each of 3 attempts", len(slots.requests))
	}
	// The two dropped uploads never reached storage; the third used the third URL.
	if got := tokensOf(uploads); strings.Join(got, ",") != "secret3" {
		t.Errorf("storage saw tokens %v, want only secret3", got)
	}
	stderr := h.stderr.String()
	if strings.Count(stderr, "trying again") != 2 || !strings.Contains(stderr, "EOF") {
		t.Errorf("each retry should be announced with its cause:\n%s", stderr)
	}
	if strings.Contains(stderr, "secret") {
		t.Errorf("stderr leaks an upload token:\n%s", stderr)
	}
	if len(waits) < 2 || waits[0] < retryBase/2 || waits[1] < retryBase {
		t.Errorf("waits before the retries = %v, want growing backoff", waits)
	}
}

func TestDeployGivesUpAfterFourAttemptsWithoutPrintingTheToken(t *testing.T) {
	h := newHarness(t).loggedIn()
	slots, _, dir := uploadRoutes(t, h, 200)
	failUploads(h, 100, syscall.ECONNRESET)
	h.expect(ExitError, "deploy", dir)
	if len(slots.requests) != maxAttempts {
		t.Errorf("made %d attempts, want %d", len(slots.requests), maxAttempts)
	}
	stderr := h.stderr.String()
	if strings.Contains(stderr, "secret") {
		t.Errorf("stderr leaks an upload token:\n%s", stderr)
	}
	if !strings.Contains(stderr, "erainfra: upload the source to fleet.example.test: connection reset by peer (failed 4 times)") {
		t.Errorf("the final error should name the host, the cause and the attempts:\n%s", stderr)
	}
}

func TestDeployRetriesAStorage5xxButNotA4xx(t *testing.T) {
	h := newHarness(t).loggedIn()
	slots, uploads, dir := uploadRoutes(t, h, http.StatusServiceUnavailable)
	h.expect(ExitError, "deploy", dir)
	if len(slots.requests) != maxAttempts || len(uploads.requests) != maxAttempts {
		t.Errorf("a 503 from storage: %d URLs, %d uploads, want %d of each", len(slots.requests), len(uploads.requests), maxAttempts)
	}

	h = newHarness(t).loggedIn()
	slots, uploads, dir = uploadRoutes(t, h, http.StatusBadRequest)
	h.expect(ExitError, "deploy", dir)
	if len(slots.requests) != 1 || len(uploads.requests) != 1 {
		t.Errorf("a 400 from storage: %d URLs, %d uploads, want 1 of each", len(slots.requests), len(uploads.requests))
	}
	if !strings.Contains(h.stderr.String(), "upload the source: HTTP 400") {
		t.Errorf("stderr = %q", h.stderr.String())
	}
}

func TestDeployStopsRetryingWhenInterrupted(t *testing.T) {
	h := newHarness(t).loggedIn()
	slots, _, dir := uploadRoutes(t, h, 200)
	failUploads(h, 100, io.EOF)
	h.sleep = func(context.Context, time.Duration) error { return context.Canceled }
	h.expect(ExitError, "deploy", dir)
	if len(slots.requests) != 1 {
		t.Errorf("made %d attempts after the wait was cancelled, want 1", len(slots.requests))
	}
}

func TestIdempotentRequestsRetryAndOthersAreSentOnce(t *testing.T) {
	h := newHarness(t).loggedIn()
	var nodes capture
	h.api.routes["GET /api/v1/nodes"] = nodes.sequence([]int{502, 500, 200}, []string{`{}`, `{}`, `{"nodes":[]}`})
	h.expect(ExitOK, "nodes", "list")
	if len(nodes.requests) != 3 {
		t.Errorf("GET /nodes sent %d times, want 3", len(nodes.requests))
	}

	var missing capture
	h.api.routes["GET /api/v1/apps/ghost"] = missing.route(404, `{"error":{"code":"not_found","message":"No App named ghost"}}`)
	h.expect(ExitError, "apps", "view", "ghost")
	if len(missing.requests) != 1 {
		t.Errorf("a 404 was retried: %d requests", len(missing.requests))
	}

	var roles capture
	h.api.routes["PUT /api/v1/nodes/edge-1/roles"] = roles.sequence([]int{503, 200}, []string{`{}`, `{"node":{"name":"edge-1","placementRoles":["gateway"]}}`})
	h.expect(ExitOK, "nodes", "set-roles", "edge-1", "gateway")
	if len(roles.requests) != 2 {
		t.Errorf("PUT roles sent %d times, want 2", len(roles.requests))
	}

	// A POST creates something and a DELETE answers a repeat differently: neither is sent twice.
	var enroll capture
	h.api.routes["POST /api/v1/nodes"] = enroll.route(503, `{}`)
	h.expect(ExitError, "nodes", "enroll", "edge-2")
	if len(enroll.requests) != 1 {
		t.Errorf("POST /nodes sent %d times, want 1", len(enroll.requests))
	}
	var remove capture
	h.api.routes["DELETE /api/v1/apps/site"] = remove.route(503, `{}`)
	h.expect(ExitError, "apps", "remove", "site", "--yes")
	if len(remove.requests) != 1 {
		t.Errorf("DELETE /apps sent %d times, want 1", len(remove.requests))
	}
}

func TestEveryPrintedErrorHidesTokenQueries(t *testing.T) {
	h := newHarness(t)
	h.env["ERAINFRA_URL"] = "https://fleet.example.test/?token=hunter2"
	h.env["ERAINFRA_TOKEN"] = goodToken
	h.faults = func(*http.Request) error { return errors.New("x509: certificate signed by unknown authority") }
	h.expect(ExitError, "nodes", "list")
	stderr := h.stderr.String()
	if strings.Contains(stderr, "hunter2") || !strings.Contains(stderr, "token=REDACTED") {
		t.Errorf("stderr = %q", stderr)
	}
	if strings.Contains(stderr, "trying again") {
		t.Errorf("a certificate failure is not transient: %q", stderr)
	}
}

func TestTransientClassification(t *testing.T) {
	for _, tc := range []struct {
		err  error
		want bool
	}{
		{io.EOF, true},
		{&url.Error{Op: "Post", URL: "https://x", Err: io.ErrUnexpectedEOF}, true},
		{fmt.Errorf("reach: %w", syscall.ECONNRESET), true},
		{&apiError{Status: 500}, true},
		{&apiError{Status: 504}, true},
		{&apiError{Status: 501}, false},
		{&apiError{Status: 429}, true},
		{&apiError{Status: 408}, true},
		{&apiError{Status: 409}, false},
		{&apiError{Status: 404}, false},
		{&uploadStatusError{status: 502}, true},
		{&uploadStatusError{status: 403}, false},
		{&uploadStatusError{status: 429}, true},
		{errors.New("x509: certificate signed by unknown authority"), false},
	} {
		if got := transient(tc.err); got != tc.want {
			t.Errorf("transient(%v) = %v, want %v", tc.err, got, tc.want)
		}
	}
}

func TestBackoffIsBoundedAndJittered(t *testing.T) {
	seen := map[time.Duration]bool{}
	for attempt := 1; attempt <= 10; attempt++ {
		ceiling := min(retryCap, retryBase<<(attempt-1))
		for range 50 {
			d := backoff(attempt)
			if d < ceiling/2 || d > ceiling {
				t.Fatalf("backoff(%d) = %s, want %s to %s", attempt, d, ceiling/2, ceiling)
			}
			seen[d] = true
		}
	}
	if len(seen) < 10 {
		t.Errorf("backoff produced only %d distinct waits; it is not jittered", len(seen))
	}
}

func TestRedactSecrets(t *testing.T) {
	in := `Post "https://a.convex.cloud/api/storage/upload?token=abc.DEF-123": EOF; https://x/?a=1&access_token=zz&b=2`
	want := `Post "https://a.convex.cloud/api/storage/upload?token=REDACTED": EOF; https://x/?a=1&access_token=REDACTED&b=2`
	if got := redactSecrets(in); got != want {
		t.Errorf("redactSecrets = %q", got)
	}
}

// throttle answers the first n requests with 429 and retryAfter, then 200 with reply.
func throttle(n int, retryAfter, reply string) (func(http.ResponseWriter, *http.Request), *int) {
	var mu sync.Mutex
	seen := 0
	return func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		seen++
		limited := seen <= n
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if limited {
			if retryAfter != "" {
				w.Header().Set("Retry-After", retryAfter)
			}
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = io.WriteString(w, `{"error":{"code":"rate_limited","message":"Too many requests"}}`)
			return
		}
		_, _ = io.WriteString(w, reply)
	}, &seen
}

func TestA429WaitsAtLeastItsRetryAfter(t *testing.T) {
	h := newHarness(t).loggedIn()
	route, seen := throttle(2, "5", `{"nodes":[]}`)
	h.api.routes["GET /api/v1/nodes"] = route
	var waits []time.Duration
	h.sleep = func(_ context.Context, d time.Duration) error {
		waits = append(waits, d)
		return nil
	}
	h.expect(ExitOK, "nodes", "list")
	if *seen != 3 {
		t.Errorf("GET /nodes sent %d times, want 3", *seen)
	}
	if len(waits) != 2 || waits[0] < 5*time.Second || waits[1] < 5*time.Second {
		t.Errorf("waits = %v, want two of at least the 5s Retry-After", waits)
	}
	if !strings.Contains(h.stderr.String(), "trying again in 5s") {
		t.Errorf("the retry should announce the server's wait:\n%s", h.stderr.String())
	}
}

func TestA429WithoutRetryAfterUsesTheBackoff(t *testing.T) {
	h := newHarness(t).loggedIn()
	route, seen := throttle(1, "", `{"nodes":[]}`)
	h.api.routes["GET /api/v1/nodes"] = route
	var waits []time.Duration
	h.sleep = func(_ context.Context, d time.Duration) error {
		waits = append(waits, d)
		return nil
	}
	h.expect(ExitOK, "nodes", "list")
	if *seen != 2 || len(waits) != 1 || waits[0] > retryBase {
		t.Errorf("sent %d times with waits %v, want 2 and one backoff of at most %s", *seen, waits, retryBase)
	}
}

func TestA429ThatAsksForMoreThanAMinuteFailsAtOnce(t *testing.T) {
	h := newHarness(t).loggedIn()
	route, seen := throttle(100, "120", `{"nodes":[]}`)
	h.api.routes["GET /api/v1/nodes"] = route
	h.sleep = func(context.Context, time.Duration) error {
		t.Error("the CLI slept although the server asked for more than maxRetryAfter")
		return nil
	}
	h.expect(ExitError, "nodes", "list")
	if *seen != 1 {
		t.Errorf("GET /nodes sent %d times, want 1", *seen)
	}
	if !strings.Contains(h.stderr.String(), "the server asks to wait 2m0s before trying again") {
		t.Errorf("stderr should say how long to wait:\n%s", h.stderr.String())
	}
}

func TestAPostIsNotRetriedEvenAfterA429(t *testing.T) {
	h := newHarness(t).loggedIn()
	route, seen := throttle(1, "1", `{"node":{"name":"edge-2"}}`)
	h.api.routes["POST /api/v1/nodes"] = route
	h.expect(ExitError, "nodes", "enroll", "edge-2")
	if *seen != 1 {
		t.Errorf("POST /nodes sent %d times, want 1", *seen)
	}
}

func TestDeployRetriesAStorage429AfterItsRetryAfter(t *testing.T) {
	h := newHarness(t).loggedIn()
	slots, _, dir := uploadRoutes(t, h, 200)
	route, seen := throttle(1, "3", `{"storageId":"kg2storage"}`)
	h.api.routes["POST /api/storage/upload"] = route
	var waits []time.Duration
	h.sleep = func(_ context.Context, d time.Duration) error {
		waits = append(waits, d)
		return nil
	}
	h.expect(ExitOK, "deploy", dir)
	if *seen != 2 || len(slots.requests) != 2 {
		t.Errorf("%d uploads with %d URLs, want 2 of each", *seen, len(slots.requests))
	}
	if len(waits) != 1 || waits[0] < 3*time.Second {
		t.Errorf("waits = %v, want one of at least 3s", waits)
	}
}

func TestRetryAfterHeaderParsesSecondsAndDates(t *testing.T) {
	now := time.Date(2026, 11, 8, 12, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		value string
		want  time.Duration
	}{
		{"", 0},
		{"7", 7 * time.Second},
		{" 0 ", 0},
		{"-3", 0},
		{"soon", 0},
		{"4294967296", 4294967296 * time.Second},
		{"1844674407370955161600", time.Duration(1<<63 - 1)},
		{now.Add(90 * time.Second).Format(http.TimeFormat), 90 * time.Second},
		{now.Add(-time.Minute).Format(http.TimeFormat), 0},
	} {
		if got := retryAfterHeader(tc.value, now); got != tc.want {
			t.Errorf("retryAfterHeader(%q) = %s, want %s", tc.value, got, tc.want)
		}
	}
}
