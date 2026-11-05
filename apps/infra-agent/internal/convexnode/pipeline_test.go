package convexnode

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/Fanzzzd/erainfra/apps/infra-agent/internal/agent"
)

// recordingExecutor is an Infra Agent executor that records each payload it is asked to run and
// can read a spec.
type recordingExecutor struct {
	payloads  []Payload
	specReads int
	spec      string
	specErr   error
}

func (r *recordingExecutor) Execute(_ context.Context, p Payload) string {
	r.payloads = append(r.payloads, p)
	return "success"
}
func (r *recordingExecutor) ReadSpec(_ context.Context, p Payload) (string, error) {
	r.payloads = append(r.payloads, p)
	r.specReads++
	return r.spec, r.specErr
}

func TestBuildStepReplaysItsJournaledOutcomeAfterACrash(t *testing.T) {
	ctx := context.Background()
	api := &fakeAPI{kind: "build", reportFail: true}
	exec := &recordingExecutor{}
	dir := privateDir(t)
	c, url := clientFor(t, api, dir, nil)
	c.exec = exec
	// The build ran and pushed, then the result never reached Convex and the agent died.
	if _, err := c.Step(ctx); err == nil {
		t.Fatal("expected the result to fail")
	}
	if len(exec.payloads) != 1 || exec.payloads[0].Image != "127.0.0.1:5000/shop-web:abc" ||
		exec.payloads[0].Source.Kind != "upload" {
		t.Fatalf("payloads = %+v", exec.payloads)
	}
	if err := c.Close(); err != nil {
		t.Fatal(err)
	}
	api.mu.Lock()
	api.reportFail = false
	api.mu.Unlock()
	// Convex re-delivers the same command (same id, same deterministic key) to the restarted agent.
	next, err := New(Config{URL: url, Credential: c.cfg.Credential, StateDir: dir, AllowHTTPForTests: true}, exec)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = next.Close() }()
	if _, err := next.Step(ctx); err != nil {
		t.Fatal(err)
	}
	if len(exec.payloads) != 1 {
		t.Fatal("a re-delivered build ran a second time")
	}
	api.mu.Lock()
	defer api.mu.Unlock()
	if api.result != "success" {
		t.Fatal(api.result)
	}
}

func TestBuildInterruptedMidStepIsUnknownAndNotRebuilt(t *testing.T) {
	dir := privateDir(t)
	j, err := OpenJournal(dir)
	if err != nil {
		t.Fatal(err)
	}
	// Accepted and fsynced, then the process died before the outcome was written.
	if err = j.append("node-a:restart-1", "cmd-1", "accepted"); err != nil {
		t.Fatal(err)
	}
	if err = j.Close(); err != nil {
		t.Fatal(err)
	}
	api := &fakeAPI{kind: "build"}
	exec := &recordingExecutor{}
	c, _ := clientFor(t, api, dir, nil)
	c.exec = exec
	defer func() { _ = c.Close() }()
	if _, err = c.Step(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(exec.payloads) != 0 {
		t.Fatal("an interrupted build was started again")
	}
	api.mu.Lock()
	defer api.mu.Unlock()
	if api.result != "unknown" {
		t.Fatal(api.result)
	}
}

func TestSpecStepReportsTheSpecTextAndIsReadAgainWhenRedelivered(t *testing.T) {
	ctx := context.Background()
	api := &fakeAPI{kind: "spec", reportFail: true}
	exec := &recordingExecutor{spec: "services:\n  web:\n    build: .\n"}
	c, _ := clientFor(t, api, privateDir(t), nil)
	c.exec = exec
	defer func() { _ = c.Close() }()
	if _, err := c.Step(ctx); err == nil {
		t.Fatal("expected the result to fail")
	}
	api.mu.Lock()
	api.reportFail = false
	api.result = ""
	api.mu.Unlock()
	if _, err := c.Step(ctx); err != nil {
		t.Fatal(err)
	}
	// Reading is free of effects, so the spec is read again rather than replayed without its text.
	if exec.specReads != 2 {
		t.Fatalf("spec reads = %d", exec.specReads)
	}
	api.mu.Lock()
	if api.result != "success" || api.spec != exec.spec {
		t.Fatalf("result = %q, spec = %q", api.result, api.spec)
	}
	api.mu.Unlock()

	failing := &fakeAPI{kind: "spec"}
	broken := &recordingExecutor{specErr: errors.New("no such branch")}
	d, _ := clientFor(t, failing, privateDir(t), nil)
	d.exec = broken
	defer func() { _ = d.Close() }()
	if _, err := d.Step(ctx); err != nil {
		t.Fatal(err)
	}
	failing.mu.Lock()
	defer failing.mu.Unlock()
	if failing.result != "failure" || failing.spec != "" {
		t.Fatalf("result = %q, spec = %q", failing.result, failing.spec)
	}
}

func TestLocalExecutorRefusesMalformedBuildPayloads(t *testing.T) {
	good := Payload{Kind: "build", App: "shop", Service: "web", Image: "127.0.0.1:5000/shop-web:abc",
		Source: agent.ConvexSource{Kind: "upload", URL: "https://deployment.convex.cloud/api/storage/abc"}}
	for name, mutate := range map[string]func(*Payload){
		"option as image": func(p *Payload) { p.Image = "--privileged" },
		"escaping dir":    func(p *Payload) { p.Dir = "../../etc" },
		"absolute dir":    func(p *Payload) { p.Dir = "/etc" },
		"bad app":         func(p *Payload) { p.App = "Shop;rm" },
		"no source":       func(p *Payload) { p.Source = agent.ConvexSource{} },
	} {
		p := good
		mutate(&p)
		if got := (LocalExecutor{}).Execute(context.Background(), p); got != "failure" {
			t.Fatalf("%s: %s", name, got)
		}
	}
	if _, err := (LocalExecutor{}).ReadSpec(context.Background(), Payload{Kind: "spec"}); err == nil ||
		!strings.Contains(err.Error(), "invalid") {
		t.Fatalf("spec without a source: %v", err)
	}
}
