package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	goodToken  = "erainfra_good"
	readToken  = "erainfra_read"
	deployment = "https://fleet.example.test"
)

// handlerTransport serves requests from an http.Handler in memory: the tests
// never open a socket, let alone reach a network.
type handlerTransport struct{ handler http.Handler }

func (t handlerTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	rec := httptest.NewRecorder()
	t.handler.ServeHTTP(rec, r)
	return rec.Result(), nil
}

// fakeAPI answers like the control plane's /api/v1 and records every request.
type fakeAPI struct {
	mu       sync.Mutex
	requests []*http.Request
	routes   map[string]func(w http.ResponseWriter, r *http.Request)
	// tokenless paths are served without a token, as Convex file storage serves an upload URL.
	tokenless map[string]bool
}

func newFakeAPI() *fakeAPI {
	return &fakeAPI{routes: map[string]func(http.ResponseWriter, *http.Request){}}
}

func (f *fakeAPI) on(methodPath string, status int, body string) {
	f.routes[methodPath] = func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	}
}

func (f *fakeAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	f.requests = append(f.requests, r)
	f.mu.Unlock()
	if r.Host != "fleet.example.test" {
		http.Error(w, "wrong host", http.StatusBadGateway)
		return
	}
	if f.tokenless[r.URL.Path] {
		f.routes[r.Method+" "+r.URL.Path](w, r)
		return
	}
	switch r.Header.Get("Authorization") {
	case "Bearer " + goodToken:
	case "Bearer " + readToken:
		if r.Method != http.MethodGet {
			writeError(w, http.StatusForbidden, "forbidden", "This route needs an admin token")
			return
		}
	default:
		writeError(w, http.StatusUnauthorized, "unauthorized", "The API token is not valid or has been revoked")
		return
	}
	route, ok := f.routes[r.Method+" "+r.URL.Path]
	if !ok {
		writeError(w, http.StatusNotFound, "not_found", "No such API route")
		return
	}
	route(w, r)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"code": code, "message": message}})
}

type harness struct {
	t       *testing.T
	api     *fakeAPI
	env     map[string]string
	stdin   string
	stdout  bytes.Buffer
	stderr  bytes.Buffer
	gh      func(args []string) ([]byte, error)
	git     func(dir string, args []string) ([]byte, error)
	ghCalls [][]string
	// faults, when set, may fail a request before it reaches the fake API, as a dropped
	// connection does. sleep, when set, is App.Sleep.
	faults func(r *http.Request) error
	sleep  func(ctx context.Context, d time.Duration) error
}

// faultTransport fails a request with the error faults returns, or passes it on.
type faultTransport struct {
	next   http.RoundTripper
	faults func(r *http.Request) error
}

func (t faultTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if err := t.faults(r); err != nil {
		return nil, err
	}
	return t.next.RoundTrip(r)
}

var fixedNow = time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)

func newHarness(t *testing.T) *harness {
	t.Helper()
	return &harness{
		t:   t,
		api: newFakeAPI(),
		env: map[string]string{"XDG_CONFIG_HOME": t.TempDir(), "HOME": t.TempDir()},
	}
}

func (h *harness) loggedIn() *harness {
	h.t.Helper()
	path, err := configPath(h.getenv)
	if err != nil {
		h.t.Fatal(err)
	}
	if err := writeConfig(path, Config{URL: deployment, Token: goodToken}); err != nil {
		h.t.Fatal(err)
	}
	return h
}

func (h *harness) getenv(key string) string { return h.env[key] }

func (h *harness) run(args ...string) int {
	h.stdout.Reset()
	h.stderr.Reset()
	app := &App{
		Version: "test",
		Stdin:   strings.NewReader(h.stdin),
		Stdout:  &h.stdout,
		Stderr:  &h.stderr,
		Getenv:  h.getenv,
		HTTP:    &http.Client{Transport: handlerTransport{h.api}},
		Now:     func() time.Time { return fixedNow },
		LookPath: func(name string) (string, error) {
			if (name == "git" && h.git == nil) || (name != "git" && h.gh == nil) {
				return "", errors.New("not found")
			}
			return "/usr/bin/" + name, nil
		},
		RunGH: func(_ context.Context, _ string, args []string, _ io.Writer) ([]byte, error) {
			h.ghCalls = append(h.ghCalls, args)
			return h.gh(args)
		},
		RunGit: func(_ context.Context, dir string, args []string) ([]byte, error) {
			return h.git(dir, args)
		},
	}
	if h.faults != nil {
		app.HTTP.Transport = faultTransport{next: app.HTTP.Transport, faults: h.faults}
	}
	app.Sleep = h.sleep
	return app.Run(context.Background(), args)
}

func (h *harness) expect(code int, args ...string) {
	h.t.Helper()
	if got := h.run(args...); got != code {
		h.t.Fatalf("erainfra %s exited %d, want %d\nstdout:\n%s\nstderr:\n%s",
			strings.Join(args, " "), got, code, h.stdout.String(), h.stderr.String())
	}
}

func TestHelpListsEveryCommand(t *testing.T) {
	h := newHarness(t)
	h.expect(ExitOK, "--help")
	for _, c := range commands {
		if !strings.Contains(h.stdout.String(), c.path) {
			t.Errorf("top-level help does not mention %q", c.path)
		}
	}
	for _, want := range []string{"--format table|json", "ERAINFRA_TOKEN", "4 not logged in"} {
		if !strings.Contains(h.stdout.String(), want) {
			t.Errorf("top-level help lacks %q", want)
		}
	}

	h.expect(ExitUsage)
	if !strings.Contains(h.stderr.String(), "Usage:") {
		t.Errorf("no arguments should print usage on stderr, got %q", h.stderr.String())
	}

	h.expect(ExitOK, "jobs", "list", "--help")
	for _, flag := range []string{"--profile", "--state", "--repo", "--since", "--cursor", "--all", "--json"} {
		if !strings.Contains(h.stdout.String(), flag) {
			t.Errorf("jobs list --help lacks %s", flag)
		}
	}

	h.expect(ExitUsage, "jobs")
	if !strings.Contains(h.stderr.String(), "view <id>") {
		t.Errorf("a bare group should list its subcommands, got %q", h.stderr.String())
	}
	h.expect(ExitOK, "jobs", "--help")
	h.expect(ExitOK, "attempts", "--help")
	h.expect(ExitUsage, "rollout")
	h.expect(ExitUsage, "jobs", "delete")
	h.expect(ExitOK, "worker", "--help")
	if !strings.Contains(h.stdout.String(), "the same program as rc") {
		t.Errorf("erainfra worker --help should say it runs rc, got %q", h.stdout.String())
	}
	h.expect(ExitOK, "--help")
	if !strings.Contains(h.stdout.String(), "worker <command>") {
		t.Errorf("top-level help does not mention erainfra worker")
	}

	h.expect(ExitOK, "version")
	if h.stdout.String() != "erainfra test\n" {
		t.Errorf("version printed %q", h.stdout.String())
	}
}

func TestUsageErrorsExitTwoWithoutTouchingTheNetwork(t *testing.T) {
	h := newHarness(t).loggedIn()
	for _, args := range [][]string{
		{"profiles", "list", "--colour"},
		{"profiles", "list", "extra"},
		{"profiles", "list", "--format", "yaml"},
		{"profiles", "list", "--json", "--format", "table"},
		{"profiles", "list", "--json=yes"},
		{"jobs", "view"},
		{"jobs", "view", "a", "b"},
		{"jobs", "list", "--limit", "0"},
		{"jobs", "list", "--limit", "many"},
		{"jobs", "list", "--profile"},
		{"jobs", "list", "--state", "done", "--state", "failed"},
		{"workers", "add", "--os", "plan9"},
		{"auth", "login", "--token", "x"},
		{"auth", "login", "--url", deployment},
		{"auth", "login", "--url", "http://fleet.example.test", "--token", "x"},
		{"auth", "login", "--url", "ftp://fleet.example.test", "--token", "x"},
	} {
		h.expect(ExitUsage, args...)
		if !strings.HasPrefix(h.stderr.String(), "erainfra: ") {
			t.Errorf("%v: stderr %q does not explain the error", args, h.stderr.String())
		}
	}
	if len(h.api.requests) != 0 {
		t.Fatalf("usage errors sent %d requests", len(h.api.requests))
	}
}

func TestFlagsMayFollowPositionalArguments(t *testing.T) {
	p, err := parseArgs([]string{"abc", "--format=json", "--url", "--", "--not-a-flag"}, []flagSpec{{name: "url"}})
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(p.args, ","); got != "abc,--not-a-flag" {
		t.Errorf("positional arguments = %q", got)
	}
	if v, _ := p.value("format"); v != "json" || !p.bools["url"] {
		t.Errorf("flags = %v %v", p.values, p.bools)
	}
}

func TestAuthLoginChecksTheTokenAndStoresItPrivately(t *testing.T) {
	h := newHarness(t)
	h.api.on("GET /api/v1/token", 200, `{"token":{"name":"laptop","scope":"read"}}`)
	h.expect(ExitOK, "auth", "login", "--url", deployment+"/", "--token", goodToken)
	if !strings.Contains(h.stdout.String(), `Logged in to https://fleet.example.test with read token "laptop"`) {
		t.Errorf("stdout = %q", h.stdout.String())
	}
	path := filepath.Join(h.env["XDG_CONFIG_HOME"], "erainfra", "config.json")
	cfg, err := readConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg != (Config{URL: deployment, Token: goodToken}) {
		t.Errorf("stored %+v", cfg)
	}
	if runtime.GOOS != "windows" {
		info, _ := os.Stat(path)
		if info.Mode().Perm() != 0o600 {
			t.Errorf("config mode = %v, want 0600", info.Mode().Perm())
		}
		dir, _ := os.Stat(filepath.Dir(path))
		if dir.Mode().Perm() != 0o700 {
			t.Errorf("config directory mode = %v, want 0700", dir.Mode().Perm())
		}
	}
	if got := h.api.requests[0].Header.Get("User-Agent"); got != "erainfra-cli/test" {
		t.Errorf("User-Agent = %q", got)
	}
}

func TestAuthLoginReadsTheTokenFromStandardInput(t *testing.T) {
	h := newHarness(t)
	h.api.on("GET /api/v1/token", 200, `{"token":{"name":"ci","scope":"admin"}}`)
	h.stdin = goodToken + "\n"
	h.expect(ExitOK, "auth", "login", "--url", deployment, "--token", "-", "--json")
	var out map[string]any
	if err := json.Unmarshal(h.stdout.Bytes(), &out); err != nil {
		t.Fatalf("json output did not parse: %v\n%s", err, h.stdout.String())
	}
	if out["url"] != deployment || out["token"].(map[string]any)["scope"] != "admin" {
		t.Errorf("json output = %v", out)
	}
}

func TestAuthLoginRefusesARejectedTokenAndStoresNothing(t *testing.T) {
	h := newHarness(t)
	h.expect(ExitAuth, "auth", "login", "--url", deployment, "--token", "erainfra_revoked")
	if !strings.Contains(h.stderr.String(), "not valid or has been revoked (HTTP 401)") {
		t.Errorf("stderr = %q", h.stderr.String())
	}
	if _, err := os.Stat(filepath.Join(h.env["XDG_CONFIG_HOME"], "erainfra", "config.json")); !os.IsNotExist(err) {
		t.Errorf("a refused token was stored: %v", err)
	}
}

func TestAuthStatusAndTheEnvironmentOverride(t *testing.T) {
	h := newHarness(t)
	h.expect(ExitAuth, "auth", "status")
	if !strings.Contains(h.stderr.String(), "not logged in") {
		t.Errorf("stderr = %q", h.stderr.String())
	}

	h.api.on("GET /api/v1/token", 200, `{"token":{"name":"bot","scope":"read"}}`)
	h.env["ERAINFRA_URL"] = deployment
	h.expect(ExitAuth, "auth", "status")
	if !strings.Contains(h.stderr.String(), "set both ERAINFRA_URL and ERAINFRA_TOKEN") {
		t.Errorf("stderr = %q", h.stderr.String())
	}
	h.env["ERAINFRA_TOKEN"] = goodToken
	h.expect(ExitOK, "auth", "status")
	if !strings.Contains(h.stdout.String(), "From:  environment") {
		t.Errorf("stdout = %q", h.stdout.String())
	}

	delete(h.env, "ERAINFRA_URL")
	delete(h.env, "ERAINFRA_TOKEN")
	h.loggedIn()
	h.expect(ExitOK, "auth", "logout")
	h.expect(ExitAuth, "profiles", "list")
}

const profilesBody = `{"profiles":[{"name":"erainfra-4vcpu-ubuntu-2404","state":"active","executor":"firecracker","boundary":"guest-kernel","trustedOnly":false,"imageRelease":"ghcr.io/x@sha256:1","vcpus":4,"memoryMiB":16384,"warmPool":0,"fitPolicy":"balanced","minRunners":0,"maxRunners":4,"readyWorkers":1,"readySlots":3,"freeSlots":2,"readiness":{"ready":1,"preparing":1,"degraded":0,"failed":0},"workers":[],"updatedAt":"2026-11-05T11:00:00.000Z"}]}`

func TestProfilesListRendersTableAndPassesJSONThrough(t *testing.T) {
	h := newHarness(t).loggedIn()
	h.api.on("GET /api/v1/profiles", 200, profilesBody)

	// A control plane that predates workerLabels sends none: the Profile is not pinned.
	h.expect(ExitOK, "profiles", "list")
	want := "" +
		"NAME                        STATE   EXECUTOR     SIZE             READY  SLOTS  NOT READY    PINNED TO\n" +
		"erainfra-4vcpu-ubuntu-2404  active  firecracker  4 vCPU / 16 GiB  1      2/3    preparing 1  -\n"
	if h.stdout.String() != want {
		t.Errorf("table:\n%s\nwant:\n%s", h.stdout.String(), want)
	}

	h.expect(ExitOK, "profiles", "list", "--format", "json")
	var got, expected any
	if err := json.Unmarshal(h.stdout.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	_ = json.Unmarshal([]byte(profilesBody), &expected)
	gotJSON, _ := json.Marshal(got)
	wantJSON, _ := json.Marshal(expected)
	if !bytes.Equal(gotJSON, wantJSON) {
		t.Errorf("json output changed the server's body:\n%s", h.stdout.String())
	}
}

func TestWorkersListTable(t *testing.T) {
	h := newHarness(t).loggedIn()
	h.api.on("GET /api/v1/workers", 200, `{"workers":[
		{"id":"m1","name":"ubuntu0","os":"linux","arch":"x64","labels":["gpu","nvme"],"online":true,"lastHeartbeatAt":"2026-11-05T11:59:30.000Z","slots":{"max":3,"used":1,"policy":"auto","recommended":3},"readiness":[{"profile":"rc-linux-js","state":"ready"},{"profile":"erainfra-4vcpu-ubuntu-2404","state":"preparing"}],"activeAttempts":[]},
		{"id":"m2","name":"mac1","os":"mac","arch":null,"online":false,"lastHeartbeatAt":null,"slots":{"max":1,"used":0,"policy":"fixed","recommended":null},"readiness":[],"activeAttempts":[]}]}`)
	h.expect(ExitOK, "workers", "list")
	want := "" +
		"NAME     STATUS   HEARTBEAT  PLATFORM   SLOTS  LABELS    PROFILES\n" +
		"ubuntu0  online   30s ago    linux/x64  1/3    gpu,nvme  erainfra-4vcpu-ubuntu-2404=preparing, rc-linux-js=ready\n" +
		"mac1     offline  -          mac        0/1    -         -\n"
	if h.stdout.String() != want {
		t.Errorf("table:\n%s\nwant:\n%s", h.stdout.String(), want)
	}
}

const attemptJSON = `{"id":"j57abc","profile":"erainfra-4vcpu-ubuntu-2404","state":"completed","result":"succeeded","worker":"ubuntu0","repo":"acme/web","job":"test","workflowRunId":77,"workflowRunUrl":"https://github.com/acme/web/actions/runs/77","createdAt":"2026-11-05T11:00:00.000Z","queuedAt":"2026-11-05T11:00:01.000Z","startedAt":"2026-11-05T11:00:05.000Z","finishedAt":"2026-11-05T11:01:10.000Z","queueWaitMs":3000,"durationMs":65000,"error":null}`

func TestJobsListSendsFiltersAndRendersATable(t *testing.T) {
	h := newHarness(t).loggedIn()
	h.api.on("GET /api/v1/attempts", 200, `{"attempts":[`+attemptJSON+`],"nextCursor":"c2"}`)
	h.expect(ExitOK, "jobs", "list", "--profile", "erainfra-4vcpu-ubuntu-2404", "--state=completed",
		"--repo", "acme/web", "--since", "7d", "--limit", "1")
	query := h.api.requests[0].URL.Query()
	for key, want := range map[string]string{
		"profile": "erainfra-4vcpu-ubuntu-2404", "state": "completed", "repo": "acme/web", "since": "2026-10-29T12:00:00.000Z", "limit": "1",
	} {
		if query.Get(key) != want {
			t.Errorf("query %s = %q, want %q", key, query.Get(key), want)
		}
	}
	want := "" +
		"ID      STATE      RESULT     PROFILE                     REPO      JOB   WORKER   WAIT  DURATION  CREATED\n" +
		"j57abc  completed  succeeded  erainfra-4vcpu-ubuntu-2404  acme/web  test  ubuntu0  3s    1m05s     1h ago\n"
	if h.stdout.String() != want {
		t.Errorf("table:\n%s\nwant:\n%s", h.stdout.String(), want)
	}
	if h.stderr.String() != "More Attempts: add --cursor c2 and change --since 7d to --since 2026-10-29T12:00:00.000Z\n" {
		t.Errorf("stderr = %q", h.stderr.String())
	}
}

func TestJobsListAllFollowsTheCursor(t *testing.T) {
	h := newHarness(t).loggedIn()
	h.api.routes["GET /api/v1/attempts"] = func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("cursor") == "" {
			_, _ = io.WriteString(w, `{"attempts":[{"id":"a"},{"id":"b"}],"nextCursor":"next"}`)
			return
		}
		_, _ = io.WriteString(w, `{"attempts":[{"id":"c"}],"nextCursor":null}`)
	}
	h.expect(ExitOK, "jobs", "list", "--all", "--json")
	var page struct {
		Attempts   []struct{ ID string } `json:"attempts"`
		NextCursor *string               `json:"nextCursor"`
	}
	if err := json.Unmarshal(h.stdout.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Attempts) != 3 || page.Attempts[2].ID != "c" || page.NextCursor != nil {
		t.Errorf("merged page = %+v", page)
	}
	if got := h.api.requests[0].URL.Query().Get("limit"); got != "100" {
		t.Errorf("--all should ask for full pages, sent limit=%q", got)
	}
	if got := h.api.requests[1].URL.Query().Get("cursor"); got != "next" {
		t.Errorf("second page cursor = %q", got)
	}
}

// Regression: `jobs list --since 720h --all` failed on page 2 with "cursor is not valid for these
// filters (HTTP 400)". The API resolves a span against its own clock on each request, and a cursor
// is bound to the window it was issued for. The fake API does the same, with a clock that moves
// one second per request.
func TestJobsListAllKeepsTheSinceWindowAcrossPages(t *testing.T) {
	h := newHarness(t).loggedIn()
	clock := fixedNow
	windowOf := map[string]string{}
	h.api.routes["GET /api/v1/attempts"] = func(w http.ResponseWriter, r *http.Request) {
		clock = clock.Add(time.Second)
		window, _ := resolveSince(r.URL.Query().Get("since"), clock)
		switch cursor := r.URL.Query().Get("cursor"); {
		case cursor == "":
			windowOf["p2"] = window
			_, _ = io.WriteString(w, `{"attempts":[{"id":"a"}],"nextCursor":"p2"}`)
		case windowOf[cursor] != window:
			w.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(w, `{"error":{"code":"invalid_cursor","message":"cursor is not valid for these filters"}}`)
		default:
			_, _ = io.WriteString(w, `{"attempts":[{"id":"b"}],"nextCursor":null}`)
		}
	}
	h.expect(ExitOK, "jobs", "list", "--since", "720h", "--all", "--json")
	if len(h.api.requests) != 2 {
		t.Fatalf("requests = %d, want 2", len(h.api.requests))
	}
	for i, r := range h.api.requests {
		if got := r.URL.Query().Get("since"); got != "2026-10-06T12:00:00.000Z" {
			t.Errorf("page %d since = %q, want the span resolved once", i+1, got)
		}
	}

	// An RFC 3339 time is already fixed, so it goes out as given.
	h.expect(ExitOK, "jobs", "list", "--since", "2026-11-01T00:00:00Z", "--all", "--json")
	if got := h.api.requests[3].URL.Query().Get("since"); got != "2026-11-01T00:00:00Z" {
		t.Errorf("since = %q, want it unchanged", got)
	}
}

func TestJobsListPrintsAnEmptyJSONArray(t *testing.T) {
	h := newHarness(t).loggedIn()
	h.api.on("GET /api/v1/attempts", 200, `{"attempts":[],"nextCursor":null}`)
	h.expect(ExitOK, "jobs", "list", "--json")
	if strings.TrimSpace(h.stdout.String()) != "{\n  \"attempts\": [],\n  \"nextCursor\": null\n}" {
		t.Errorf("stdout = %q", h.stdout.String())
	}
	h.expect(ExitOK, "jobs", "list")
	if h.stdout.Len() != 0 || h.stderr.String() != "No Attempts match.\n" {
		t.Errorf("stdout = %q stderr = %q", h.stdout.String(), h.stderr.String())
	}
}

func TestJobsViewTable(t *testing.T) {
	h := newHarness(t).loggedIn()
	detail := strings.TrimSuffix(attemptJSON, "}") +
		`,"executor":"firecracker","imageRelease":"ghcr.io/x@sha256:1","vcpus":4,"memoryMiB":16384,"runnerName":"r-1","runnerId":9,"executorExitCode":0}`
	h.api.on("GET /api/v1/attempts/j57abc", 200, `{"attempt":`+detail+`}`)
	h.expect(ExitOK, "jobs", "view", "j57abc")
	for _, want := range []string{
		"State:             completed",
		"Executor:          firecracker, 4 vCPU / 16 GiB",
		"Run:               https://github.com/acme/web/actions/runs/77",
		"Queue wait:        3s",
		"Executor exit:     0",
		"Last error:        -",
	} {
		if !strings.Contains(h.stdout.String(), want) {
			t.Errorf("jobs view lacks %q:\n%s", want, h.stdout.String())
		}
	}

	h.expect(ExitError, "jobs", "view", "missing")
	if !strings.Contains(h.stderr.String(), "HTTP 404") {
		t.Errorf("stderr = %q", h.stderr.String())
	}
}

func TestJobsViewShowsTheRunnerCause(t *testing.T) {
	h := newHarness(t).loggedIn()
	detail := strings.TrimSuffix(attemptJSON, "}") +
		`,"executor":"firecracker","imageRelease":"ghcr.io/x@sha256:1","vcpus":4,"memoryMiB":16384,"runnerName":"r-1","runnerId":9,` +
		`"lastError":"Executor exited with code 137","cause":{"code":"executor-killed","summary":"The executor was killed.",` +
		`"docs":[{"title":"GitHub-hosted runners: machine specifications","url":"https://docs.github.com/x"}]}}`
	h.api.on("GET /api/v1/attempts/j57abc", 200, `{"attempt":`+detail+`}`)
	h.expect(ExitOK, "jobs", "view", "j57abc")
	for _, want := range []string{
		"Runner cause:      executor-killed: The executor was killed.",
		"See:               GitHub-hosted runners: machine specifications https://docs.github.com/x",
	} {
		if !strings.Contains(h.stdout.String(), want) {
			t.Errorf("jobs view lacks %q:\n%s", want, h.stdout.String())
		}
	}
}

func TestJobsViewShowsARetiringAttempt(t *testing.T) {
	h := newHarness(t).loggedIn()
	detail := strings.TrimSuffix(attemptJSON, "}") +
		`,"executor":"firecracker","imageRelease":"ghcr.io/x@sha256:1","vcpus":4,"memoryMiB":16384,"runnerName":"r-1","runnerId":9,` +
		`"retiring":{"outcome":"cancelled","reason":"GitHub reduced the desired runner count","since":"2026-11-06T09:00:00.000Z"}}`
	h.api.on("GET /api/v1/attempts/j57abc", 200, `{"attempt":`+detail+`}`)
	h.expect(ExitOK, "jobs", "view", "j57abc")
	want := "Retiring:          since 2026-11-06T09:00:00.000Z, then cancelled: GitHub reduced the desired runner count"
	if !strings.Contains(h.stdout.String(), want) {
		t.Errorf("jobs view lacks %q:\n%s", want, h.stdout.String())
	}
}

func TestJobsLogs(t *testing.T) {
	h := newHarness(t).loggedIn()
	h.api.on("GET /api/v1/attempts/j57abc", 200, `{"attempt":`+attemptJSON+`}`)
	h.api.on("GET /api/v1/attempts/idle", 200, `{"attempt":{"id":"idle","state":"cancelled","repo":null,"workflowRunId":null,"workflowRunUrl":null}}`)

	// No gh: the run URL, and a hint on stderr.
	h.expect(ExitOK, "jobs", "logs", "j57abc")
	if h.stdout.String() != "https://github.com/acme/web/actions/runs/77\n" {
		t.Errorf("stdout = %q", h.stdout.String())
	}
	if !strings.Contains(h.stderr.String(), "GitHub CLI (gh) is not installed") {
		t.Errorf("stderr = %q", h.stderr.String())
	}

	// With gh: this job's lines only.
	h.gh = func([]string) ([]byte, error) {
		return []byte("build\tSet up job\tline 1\ntest\tRun tests\tok 1\ntest\tRun tests\tok 2\n"), nil
	}
	h.expect(ExitOK, "jobs", "logs", "j57abc")
	if h.stdout.String() != "test\tRun tests\tok 1\ntest\tRun tests\tok 2\n" {
		t.Errorf("stdout = %q", h.stdout.String())
	}
	if got := strings.Join(h.ghCalls[0], " "); got != "run view 77 --repo acme/web --log" {
		t.Errorf("gh args = %q", got)
	}

	h.expect(ExitOK, "jobs", "logs", "j57abc", "--url")
	if h.stdout.String() != "https://github.com/acme/web/actions/runs/77\n" || len(h.ghCalls) != 1 {
		t.Errorf("--url should print the URL without running gh; stdout = %q", h.stdout.String())
	}

	h.expect(ExitError, "jobs", "logs", "idle")
	if !strings.Contains(h.stderr.String(), "never ran a GitHub job") {
		t.Errorf("stderr = %q", h.stderr.String())
	}
}

func TestWorkersAdd(t *testing.T) {
	h := newHarness(t).loggedIn()
	h.api.on("POST /api/v1/workers/registration-tokens", 201,
		`{"registrationToken":"rcreg_1","expiresAt":"2026-11-05T12:15:00.000Z","installCommands":{"posix":"curl posix","windows":"irm windows"}}`)
	h.expect(ExitOK, "workers", "add")
	if h.stdout.String() != "curl posix\n" {
		t.Errorf("stdout = %q", h.stdout.String())
	}
	h.expect(ExitOK, "workers", "add", "--os", "windows")
	if h.stdout.String() != "irm windows\n" {
		t.Errorf("stdout = %q", h.stdout.String())
	}

	path, _ := configPath(h.getenv)
	_ = writeConfig(path, Config{URL: deployment, Token: readToken})
	h.expect(ExitAuth, "workers", "add")
	if !strings.Contains(h.stderr.String(), "needs an admin token (HTTP 403)") {
		t.Errorf("stderr = %q", h.stderr.String())
	}
}

func TestServerFailuresMapToExitCodes(t *testing.T) {
	h := newHarness(t).loggedIn()
	h.api.on("GET /api/v1/profiles", 500, `{"error":{"code":"internal","message":"boom"}}`)
	h.api.on("GET /api/v1/attempts", 400, `{"error":{"code":"invalid_request","message":"since must be a span"}}`)
	h.api.on("GET /api/v1/workers", 200, `<html>not the API</html>`)

	h.expect(ExitError, "profiles", "list")
	h.expect(ExitUsage, "jobs", "list", "--since", "yesterday")
	if !strings.Contains(h.stderr.String(), "since must be a span (HTTP 400)") {
		t.Errorf("stderr = %q", h.stderr.String())
	}
	h.expect(ExitError, "workers", "list")
	if !strings.Contains(h.stderr.String(), "not the operator API") {
		t.Errorf("stderr = %q", h.stderr.String())
	}

	path, _ := configPath(h.getenv)
	_ = writeConfig(path, Config{URL: deployment, Token: "erainfra_revoked"})
	h.expect(ExitAuth, "profiles", "list")
}

func TestNormalizeBaseURL(t *testing.T) {
	for raw, want := range map[string]string{
		"https://x.convex.site":   "https://x.convex.site",
		"https://x.convex.site/":  "https://x.convex.site",
		" https://x.convex.site ": "https://x.convex.site",
		"http://localhost:3211":   "http://localhost:3211",
		"http://127.0.0.1:3211/":  "http://127.0.0.1:3211",
		"http://[::1]:3211":       "http://[::1]:3211",
	} {
		got, err := normalizeBaseURL(raw)
		if err != nil || got != want {
			t.Errorf("normalizeBaseURL(%q) = %q, %v; want %q", raw, got, err, want)
		}
	}
	for _, raw := range []string{
		"x.convex.site",
		"http://x.convex.site",
		"http://localhost.evil.test",
		"https://user:pw@x.convex.site",
		"https://x.convex.site/?a=1",
		"file:///etc/passwd",
	} {
		if got, err := normalizeBaseURL(raw); err == nil {
			t.Errorf("normalizeBaseURL(%q) = %q, want an error", raw, got)
		}
	}
}

func TestConfigPathFollowsXDG(t *testing.T) {
	env := map[string]string{"HOME": "/home/op"}
	getenv := func(k string) string { return env[k] }
	if runtime.GOOS != "windows" {
		if got, _ := configPath(getenv); got != "/home/op/.config/erainfra/config.json" {
			t.Errorf("default path = %q", got)
		}
	}
	env["XDG_CONFIG_HOME"] = filepath.Join(string(filepath.Separator), "xdg")
	if got, _ := configPath(getenv); got != filepath.Join(env["XDG_CONFIG_HOME"], "erainfra", "config.json") {
		t.Errorf("XDG path = %q", got)
	}
}

func TestProfilesListShowsThePin(t *testing.T) {
	h := newHarness(t).loggedIn()
	h.api.on("GET /api/v1/profiles", 200, `{"profiles":[{"name":"erainfra-4vcpu-ubuntu-2404-gpu","state":"active","executor":"firecracker","vcpus":4,"memoryMiB":16384,"readyWorkers":0,"readySlots":0,"freeSlots":0,"readiness":{},"workerLabels":["gpu","hk"]}]}`)
	h.expect(ExitOK, "profiles", "list")
	if !strings.Contains(h.stdout.String(), "PINNED TO") || !strings.HasSuffix(strings.TrimSpace(h.stdout.String()), "gpu,hk") {
		t.Errorf("table:\n%s", h.stdout.String())
	}
}

func TestProfilesListWarnsAboutAnOverlappingScaleSet(t *testing.T) {
	h := newHarness(t).loggedIn()
	h.api.on("GET /api/v1/profiles", 200, `{"profiles":[`+
		`{"name":"gpu","state":"active","executor":"firecracker","vcpus":4,"memoryMiB":16384,"readiness":{},"workerLabels":["gpu"],"labelConflicts":["scale-set label plain is Profile plain's name; its jobs could run on this Profile instead (ADR 0017)"]},`+
		`{"name":"plain","state":"active","executor":"firecracker","vcpus":4,"memoryMiB":16384,"readiness":{},"workerLabels":[]}]}`)
	h.expect(ExitOK, "profiles", "list")
	want := "warning: Profile gpu: scale-set label plain is Profile plain's name; its jobs could run on this Profile instead (ADR 0017)\n"
	if h.stderr.String() != want {
		t.Errorf("stderr = %q, want %q", h.stderr.String(), want)
	}
}

func TestWorkersSetLabelsSaysWhatItMovedOff(t *testing.T) {
	h := newHarness(t).loggedIn()
	h.api.on("PUT /api/v1/workers/gpu-1/labels", 200, `{"worker":{"name":"gpu-1","labels":[]},"retiredRunners":1,"requeuedAttempts":2}`)
	h.expect(ExitOK, "workers", "set-labels", "gpu-1", "--clear")
	want := "gpu-1 host labels: none\n" +
		"gpu-1 no longer serves some pinned Profiles: retired 1 idle Runner(s), sent 2 placed Attempt(s) back to the queue\n"
	if h.stdout.String() != want {
		t.Errorf("stdout = %q, want %q", h.stdout.String(), want)
	}
}

func TestWorkersSetLabelsReplacesTheLabels(t *testing.T) {
	h := newHarness(t).loggedIn()
	var sent struct {
		Labels []string `json:"labels"`
	}
	var path string
	h.api.routes["PUT /api/v1/workers/hk-worker01/labels"] = func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		_ = json.NewDecoder(r.Body).Decode(&sent)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"worker": map[string]any{"name": "hk-worker01", "labels": sent.Labels}})
	}
	h.expect(ExitOK, "workers", "set-labels", "hk-worker01", "GPU", "nvme")
	if path != "/api/v1/workers/hk-worker01/labels" || strings.Join(sent.Labels, ",") != "gpu,nvme" {
		t.Errorf("sent %v to %s", sent.Labels, path)
	}
	if h.stdout.String() != "hk-worker01 host labels: gpu, nvme\n" {
		t.Errorf("stdout = %q", h.stdout.String())
	}

	h.expect(ExitOK, "workers", "set-labels", "hk-worker01", "--clear")
	if sent.Labels == nil || len(sent.Labels) != 0 || h.stdout.String() != "hk-worker01 host labels: none\n" {
		t.Errorf("--clear sent %v, printed %q", sent.Labels, h.stdout.String())
	}

	requests := len(h.api.requests)
	for _, args := range [][]string{
		{"workers", "set-labels", "hk-worker01"},
		{"workers", "set-labels", "hk-worker01", "gpu", "--clear"},
		{"workers", "set-labels", "hk-worker01", "has space"},
		{"workers", "set-labels", "hk-worker01", "-leading"},
		{"workers", "set-labels", "../etc", "gpu"},
	} {
		h.expect(ExitUsage, args...)
	}
	if len(h.api.requests) != requests {
		t.Errorf("usage errors sent %d requests", len(h.api.requests)-requests)
	}

	// A read token is refused by the server; the CLI says so with exit 4.
	h.env["ERAINFRA_URL"], h.env["ERAINFRA_TOKEN"] = deployment, readToken
	h.expect(ExitAuth, "workers", "set-labels", "hk-worker01", "gpu")
}
