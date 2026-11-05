package convexnode

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeExecutor struct {
	calls int
	wait  bool
}

func (f *fakeExecutor) Execute(ctx context.Context, _ Payload) string {
	f.calls++
	if f.wait {
		<-ctx.Done()
		return "unknown"
	}
	return "success"
}

type fakeAPI struct {
	mu                          sync.Mutex
	result                      string
	reportFail, renewFail, huge bool
	claims                      int
	refusedFirst                bool
}

func (f *fakeAPI) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer erainfra_node_") {
		w.WriteHeader(401)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	send := func(v any) { _ = json.NewEncoder(w).Encode(v) }
	switch r.URL.Path {
	case "/api/v1/nodes/heartbeat":
		send(map[string]string{"nodeId": "node-a"})
	case "/api/v1/nodes/state":
		if f.huge {
			send(strings.Repeat("x", maxWireBytes+1))
			return
		}
		send(map[string]any{"revision": "rev1", "unchanged": false, "desired": map[string]any{"v": 1, "exposures": []any{}}})
	case "/api/v1/nodes/commands":
		if f.result != "" {
			send(map[string]any{"cursor": nil, "commands": []any{}})
			return
		}
		commands := []any{map[string]string{"id": "cmd-1", "idempotencyKey": "restart-1", "kind": "operate"}}
		if f.refusedFirst {
			commands = append([]any{map[string]string{"id": "stale-app", "idempotencyKey": "stale-1", "kind": "deploy"}}, commands...)
		}
		send(map[string]any{"cursor": nil, "commands": commands})
	case "/api/v1/nodes/commands/claim":
		var claim struct {
			ID string `json:"commandId"`
		}
		if json.NewDecoder(r.Body).Decode(&claim) != nil {
			w.WriteHeader(400)
			return
		}
		if claim.ID == "stale-app" {
			w.WriteHeader(409)
			return
		}
		f.claims++
		send(map[string]any{"epoch": f.claims, "leaseUntil": time.Now().Add(time.Minute).UnixMilli()})
	case "/api/v1/nodes/commands/payload":
		send(map[string]any{"kind": "operate", "operation": map[string]any{"name": "systemctl.restart", "args": map[string]string{"unit": "portless-agent"}}})
	case "/api/v1/nodes/commands/renew":
		if f.renewFail {
			w.WriteHeader(409)
			return
		}
		send(nil)
	case "/api/v1/nodes/commands/result":
		if f.reportFail {
			w.WriteHeader(503)
			return
		}
		var b map[string]any
		if json.NewDecoder(r.Body).Decode(&b) != nil {
			w.WriteHeader(400)
			return
		}
		f.result, _ = b["outcome"].(string)
		if len(b) != 4 {
			w.WriteHeader(400)
			return
		}
		send(nil)
	default:
		w.WriteHeader(404)
	}
}
func clientFor(t *testing.T, api *fakeAPI, dir string, exec *fakeExecutor) (*Client, string) {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(api.serve))
	t.Cleanup(server.Close)
	c, err := New(Config{URL: server.URL, Credential: "erainfra_node_" + strings.Repeat("a", 64), StateDir: dir, AllowHTTPForTests: true}, exec)
	if err != nil {
		t.Fatal(err)
	}
	return c, server.URL
}
func TestResultReplayAfterNetworkFailureAndAgentRestart(t *testing.T) {
	ctx := context.Background()
	api := &fakeAPI{reportFail: true}
	exec := &fakeExecutor{}
	dir := privateDir(t)
	c, url := clientFor(t, api, dir, exec)
	if _, err := c.Step(ctx); err == nil {
		t.Fatal("expected report failure")
	}
	if exec.calls != 1 {
		t.Fatal(exec.calls)
	}
	if err := c.Close(); err != nil {
		t.Fatal(err)
	}
	api.mu.Lock()
	api.reportFail = false
	api.mu.Unlock()
	next, err := New(Config{URL: url, Credential: c.cfg.Credential, StateDir: dir, AllowHTTPForTests: true}, exec)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = next.Close() }()
	if _, err = next.Step(ctx); err != nil {
		t.Fatal(err)
	}
	if exec.calls != 1 {
		t.Fatal("restarted an already completed external effect")
	}
	api.mu.Lock()
	defer api.mu.Unlock()
	if api.result != "success" {
		t.Fatal(api.result)
	}
	data, err := os.ReadFile(filepath.Join(dir, "execution.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "operation") || strings.Contains(string(data), "portless-agent") {
		t.Fatal("payload leaked into journal")
	}
}
func TestInterruptedAcceptanceBecomesUnknownWithoutReexecution(t *testing.T) {
	dir := privateDir(t)
	j, err := OpenJournal(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err = j.append("node-a:restart-1", "cmd-1", "accepted"); err != nil {
		t.Fatal(err)
	}
	if err = j.Close(); err != nil {
		t.Fatal(err)
	}
	api := &fakeAPI{}
	exec := &fakeExecutor{}
	c, _ := clientFor(t, api, dir, exec)
	defer func() { _ = c.Close() }()
	if _, err = c.Step(context.Background()); err != nil {
		t.Fatal(err)
	}
	if exec.calls != 0 {
		t.Fatal("interrupted non-idempotent operation was executed again")
	}
	api.mu.Lock()
	defer api.mu.Unlock()
	if api.result != "unknown" {
		t.Fatal(api.result)
	}
}
func TestJournalExclusiveLockAndCorruptTailFailClosed(t *testing.T) {
	dir := privateDir(t)
	j, err := OpenJournal(dir)
	if err != nil {
		t.Fatal(err)
	}
	if other, err := OpenJournal(dir); err == nil {
		_ = other.Close()
		t.Fatal("two processes admitted")
	}
	if err = j.Close(); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(dir, "execution.jsonl"), []byte(`{"key":"interrupted"`), 0600); err != nil {
		t.Fatal(err)
	}
	if j, err = OpenJournal(dir); err == nil {
		_ = j.Close()
		t.Fatal("corrupt journal accepted")
	}
}
func TestExecutionCancelsWhenClaimCannotRenew(t *testing.T) {
	api := &fakeAPI{renewFail: true}
	exec := &fakeExecutor{wait: true}
	c, _ := clientFor(t, api, privateDir(t), exec)
	defer func() { _ = c.Close() }()
	c.RenewInterval = time.Millisecond
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := c.Step(ctx); err != nil {
		t.Fatal(err)
	}
	if exec.calls != 1 {
		t.Fatal(exec.calls)
	}
	api.mu.Lock()
	defer api.mu.Unlock()
	if api.result != "unknown" {
		t.Fatal(api.result)
	}
}
func TestResponseBufferBound(t *testing.T) {
	api := &fakeAPI{huge: true}
	exec := &fakeExecutor{}
	c, _ := clientFor(t, api, privateDir(t), exec)
	defer func() { _ = c.Close() }()
	if _, err := c.Step(context.Background()); err == nil || !strings.Contains(err.Error(), "limit") {
		t.Fatal(err)
	}
	if exec.calls != 0 {
		t.Fatal("executed from oversized response")
	}
}
func TestRefusedStaleCommandDoesNotStarveOtherApps(t *testing.T) {
	api := &fakeAPI{refusedFirst: true}
	exec := &fakeExecutor{}
	c, _ := clientFor(t, api, privateDir(t), exec)
	defer func() { _ = c.Close() }()
	if _, err := c.Step(context.Background()); err != nil {
		t.Fatal(err)
	}
	if exec.calls != 1 {
		t.Fatal("stale App blocked the rest of the queue")
	}
}
func TestFullJournalRefusesExecution(t *testing.T) {
	api := &fakeAPI{}
	exec := &fakeExecutor{}
	c, _ := clientFor(t, api, privateDir(t), exec)
	defer func() { _ = c.Close() }()
	c.journal.bytes = maxJournalBytes
	if _, err := c.Step(context.Background()); err == nil {
		t.Fatal("full journal accepted work")
	}
	if exec.calls != 0 {
		t.Fatal("executed without durable acceptance")
	}
}

func TestModeAndPollingBounds(t *testing.T) {
	if ValidateMode("connect", "wss://hub", "", "") != nil {
		t.Fatal("legacy mode changed")
	}
	if ValidateMode("connect", "wss://hub", "https://site", "") == nil {
		t.Fatal("mixed mode admitted")
	}
	if ValidateMode("connect-convex", "wss://hub", "https://site", "node") == nil {
		t.Fatal("mixed mode admitted")
	}
	delay := time.Duration(0)
	for i := 0; i < 20; i++ {
		delay = idleDelay(delay, false)
	}
	if delay != 30*time.Second || idleDelay(delay, true) != time.Second {
		t.Fatal(delay)
	}
	_, err := New(Config{URL: "http://127.0.0.1:1", Credential: "erainfra_node_" + strings.Repeat("a", 64), StateDir: privateDir(t)}, &fakeExecutor{})
	if err == nil {
		t.Fatal("cleartext allowed in production")
	}
}

func privateDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	return dir
}
