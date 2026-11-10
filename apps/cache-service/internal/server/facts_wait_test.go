package server

import (
	"net/http"
	"testing"
	"time"

	"github.com/Fanzzzd/erainfra/apps/cache-service/internal/config"
)

// The controller learns a job's identity from the JobStarted message and pushes
// it from there, which on a live fleet lands some seconds after the job's first
// step. A cache step that runs in that gap carries a runner token the runtime
// signed, so its facts are on their way: the request waits for them.
func TestRequestBeforeTheFactsPushWaitsForIt(t *testing.T) {
	h := newHarness(t, func(cfg *config.Config) { cfg.FactsWait = 10 * time.Second })
	early := h.runnerToken("rc-early")
	pushed := make(chan struct{})
	time.AfterFunc(100*time.Millisecond, func() {
		defer close(pushed)
		h.pushRunnerFacts("rc-early", h.now().Add(time.Hour))
	})
	started := time.Now()
	status := h.restoreStatus(early, "k", "v")
	waited := time.Since(started)
	<-pushed
	if status != http.StatusNoContent {
		t.Fatalf("restore that raced the facts push = %d, want a 204 miss", status)
	}
	if waited > 5*time.Second {
		t.Fatalf("the request waited %s; it should resume as the push lands, not at the deadline", waited)
	}
}

// A runner whose facts never arrive is still refused, once the wait is over,
// and counted the same way.
func TestRunnerWithoutFactsIsRefusedAfterTheWait(t *testing.T) {
	h := newHarness(t, func(cfg *config.Config) { cfg.FactsWait = 150 * time.Millisecond })
	orphan := h.runnerToken("rc-orphan")
	started := time.Now()
	if status := h.restoreStatus(orphan, "k", "v"); status != http.StatusUnauthorized {
		t.Fatalf("runner without facts = %d, want 401", status)
	}
	if waited := time.Since(started); waited < 150*time.Millisecond {
		t.Fatalf("refused after %s, before the facts wait was over", waited)
	}
}

// Facts whose window has closed are not coming back. Waiting for them would
// only delay a job that outlived its window.
func TestExpiredFactsAreRefusedWithoutWaiting(t *testing.T) {
	h := newHarness(t, func(cfg *config.Config) { cfg.FactsWait = 10 * time.Second })
	token := h.runnerToken("rc-late")
	h.pushRunnerFacts("rc-late", h.now().Add(time.Minute))
	h.advance(2 * time.Minute)
	started := time.Now()
	if status := h.restoreStatus(token, "k", "v"); status != http.StatusUnauthorized {
		t.Fatalf("expired facts = %d, want 401", status)
	}
	if waited := time.Since(started); waited > 5*time.Second {
		t.Fatalf("waited %s for facts that had expired", waited)
	}
}
