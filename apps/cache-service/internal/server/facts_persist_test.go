package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

// pushRunnerFacts pushes ordinary branch-push facts for runner over the real
// endpoint and returns the runner's token.
func (h *harness) pushRunnerFacts(runner string, expires time.Time) string {
	h.t.Helper()
	body := jsonBody(map[string]any{
		"runner": runner, "repository": "Fanzzzd/erainfra",
		"event": "push", "ref": "refs/heads/main", "defaultBranch": "refs/heads/main",
		"expiresUnix": expires.Unix(),
	})
	pushed := h.pushFacts(body, adminSign(body))
	_ = pushed.Body.Close()
	if pushed.StatusCode != http.StatusNoContent {
		h.t.Fatalf("push for %s = %d, want 204", runner, pushed.StatusCode)
	}
	return h.runnerToken(runner)
}

func (h *harness) factsKey(runner string) string {
	return h.config.Store.Prefix + factsRoot + runner
}

func scrape(t *testing.T, h *harness) string {
	t.Helper()
	response := h.do(http.MethodGet, metricsPath, "", nil, nil)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("metrics = %d", response.StatusCode)
	}
	return string(readAll(t, response))
}

// The stored copy is still bound by the facts' own expiry: a restart does not
// resurrect a job whose window has closed.
func TestStoredFactsExpireAcrossARestart(t *testing.T) {
	h := newHarness(t, nil)
	token := h.pushRunnerFacts("erainfra-4vcpu-ubuntu-2404-a", h.now().Add(10*time.Minute))
	h.restart()
	h.advance(11 * time.Minute)
	if status := h.restoreStatus(token, "k", "v"); status != http.StatusUnauthorized {
		t.Fatalf("restore with expired stored facts = %d, want 401", status)
	}
}

// The bucket is not trusted to say who a runner is. A record whose body was
// changed, or that was written without the signing key, grants nothing, so
// whoever can write to the bucket still cannot widen a runner's scope.
func TestStoredFactsMustCarryTheControllersSignature(t *testing.T) {
	h := newHarness(t, nil)
	token := h.pushRunnerFacts("erainfra-4vcpu-ubuntu-2404-a", h.now().Add(time.Hour))
	key := h.factsKey("erainfra-4vcpu-ubuntu-2404-a")
	stored, ok := h.store.Object(key)
	if !ok {
		t.Fatalf("push wrote nothing at %s; keys %v", key, h.store.Keys())
	}
	var record factsRecord
	if err := json.Unmarshal(stored, &record); err != nil {
		t.Fatal(err)
	}
	record.Body = bytes.Replace(record.Body, []byte("Fanzzzd/erainfra"), []byte("Fanzzzd/elsewhere"), 1)
	forged, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	h.store.Overwrite(key, forged)

	h.restart()
	if status := h.restoreStatus(token, "k", "v"); status != http.StatusUnauthorized {
		t.Fatalf("restore with a tampered stored record = %d, want 401", status)
	}
}

// A push the store cannot make durable is answered 503 so the controller retries
// it, and the job is served from memory meanwhile rather than made to wait.
func TestFactsPushThatCannotBePersistedIsRetryable(t *testing.T) {
	h := newHarness(t, nil)
	h.store.SetFail(func(method, key string, _ map[string][]string) int {
		if method == http.MethodPut && strings.Contains(key, factsRoot) {
			return http.StatusServiceUnavailable
		}
		return 0
	})
	body := jsonBody(map[string]any{
		"runner": "erainfra-4vcpu-ubuntu-2404-a", "repository": "Fanzzzd/erainfra",
		"event": "push", "ref": "refs/heads/main", "expiresUnix": h.now().Add(time.Hour).Unix(),
	})
	pushed := h.pushFacts(body, adminSign(body))
	_ = pushed.Body.Close()
	if pushed.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("push the store refused = %d, want 503", pushed.StatusCode)
	}
	token := h.runnerToken("erainfra-4vcpu-ubuntu-2404-a")
	if status := h.restoreStatus(token, "k", "v"); status != http.StatusNoContent {
		t.Fatalf("restore while the push is unpersisted = %d, want a 204 miss", status)
	}
	if got := scrape(t, h); !strings.Contains(got, "erainfra_cache_job_facts_persist_failures_total 1\n") {
		t.Fatalf("persist failure not counted:\n%s", got)
	}

	h.store.SetFail(nil)
	retried := h.pushFacts(body, adminSign(body))
	_ = retried.Body.Close()
	if retried.StatusCode != http.StatusNoContent {
		t.Fatalf("retried push = %d, want 204", retried.StatusCode)
	}
	h.restart()
	if status := h.restoreStatus(token, "k", "v"); status != http.StatusNoContent {
		t.Fatalf("restore after the retried push and a restart = %d, want a 204 miss", status)
	}
}

// Facts a runner never had are refused, and every refusal is counted by reason,
// which is what makes facts that never arrived visible: the job itself only
// warns.
func TestUnknownFactsRefusalsAreCounted(t *testing.T) {
	h := newHarness(t, nil)
	orphan := h.runnerToken("rc-orphan")
	for range 3 {
		if status := h.restoreStatus(orphan, "k", "v"); status != http.StatusUnauthorized {
			t.Fatalf("unknown runner = %d, want 401", status)
		}
	}
	if status := h.restoreStatus("", "k", "v"); status != http.StatusUnauthorized {
		t.Fatalf("no token = %d, want 401", status)
	}
	got := scrape(t, h)
	for _, want := range []string{
		`erainfra_cache_requests_refused_total{reason="unknown_facts"} 3`,
		`erainfra_cache_requests_refused_total{reason="no_token"} 1`,
		`erainfra_cache_requests_refused_total{reason="bad_token"} 0`,
		`erainfra_cache_requests_refused_total{reason="facts_unreadable"} 0`,
		"# TYPE erainfra_cache_requests_refused_total counter",
	} {
		if !strings.Contains(got, want+"\n") {
			t.Errorf("metrics missing %q:\n%s", want, got)
		}
	}
}

// A runner the bucket has no facts for costs the store one read per memo
// window, not one per request, and a push lifts the memo at once.
func TestUnknownRunnerIsMemoizedUntilPushed(t *testing.T) {
	h := newHarness(t, nil)
	var reads int
	h.store.SetFail(func(method, key string, _ map[string][]string) int {
		if method == http.MethodGet && strings.Contains(key, factsRoot) {
			reads++
		}
		return 0
	})
	orphan := h.runnerToken("rc-late")
	for range 5 {
		if status := h.restoreStatus(orphan, "k", "v"); status != http.StatusUnauthorized {
			t.Fatalf("unknown runner = %d, want 401", status)
		}
	}
	if reads != 1 {
		t.Fatalf("store read the facts %d times for five requests, want 1", reads)
	}
	h.pushRunnerFacts("rc-late", h.now().Add(time.Hour))
	if status := h.restoreStatus(orphan, "k", "v"); status != http.StatusNoContent {
		t.Fatalf("restore just after the push = %d, want a 204 miss", status)
	}
}

// A store that cannot answer the facts read is told apart from facts that do not
// exist, because the two send an operator to different places, and it is not
// memoized: the next request reads again.
func TestUnreadableStoredFactsAreCountedApart(t *testing.T) {
	h := newHarness(t, nil)
	token := h.pushRunnerFacts("erainfra-4vcpu-ubuntu-2404-a", h.now().Add(time.Hour))
	h.restart()
	h.store.SetFail(func(method, key string, _ map[string][]string) int {
		if method == http.MethodGet && strings.Contains(key, factsRoot) {
			return http.StatusInternalServerError
		}
		return 0
	})
	if status := h.restoreStatus(token, "k", "v"); status != http.StatusUnauthorized {
		t.Fatalf("restore with the facts unreadable = %d, want 401", status)
	}
	if got := scrape(t, h); !strings.Contains(got, `erainfra_cache_requests_refused_total{reason="facts_unreadable"} 1`+"\n") {
		t.Fatalf("unreadable facts not counted:\n%s", got)
	}

	h.store.SetFail(nil)
	if status := h.restoreStatus(token, "k", "v"); status != http.StatusNoContent {
		t.Fatalf("restore once the store answers = %d, want a 204 miss", status)
	}
	if got := scrape(t, h); !strings.Contains(got, "erainfra_cache_job_facts_loaded_total 1\n") {
		t.Fatalf("facts load not counted:\n%s", got)
	}
}

// The facts sweep is what bounds facts/: records past their expiry, and records
// that could never authorize anything, are deleted; live ones stay.
func TestStoredFactsSweepDeletesOnlyClosedWindows(t *testing.T) {
	h := newHarness(t, nil)
	h.pushRunnerFacts("rc-short", h.now().Add(10*time.Minute))
	h.pushRunnerFacts("rc-long", h.now().Add(6*time.Hour))
	h.store.Overwrite(h.factsKey("rc-garbage"), []byte("not a record"))
	h.advance(11 * time.Minute)

	deleted, err := h.server.sweepStoredFacts(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if deleted != 2 {
		t.Fatalf("sweep deleted %d records, want 2", deleted)
	}
	for runner, want := range map[string]bool{"rc-short": false, "rc-garbage": false, "rc-long": true} {
		if _, ok := h.store.Object(h.factsKey(runner)); ok != want {
			t.Errorf("%s present after sweep = %v, want %v", runner, ok, want)
		}
	}
}

// Every replica reads the same bucket, so a runner whose facts were pushed to
// one replica is served by another.
func TestFactsPushedToOneReplicaAreServedByAnother(t *testing.T) {
	h := newHarness(t, nil)
	token := h.pushRunnerFacts("erainfra-4vcpu-ubuntu-2404-a", h.now().Add(time.Hour))
	first := h.http
	h.start()
	if first == h.http {
		t.Fatal("start reused the listener")
	}
	if status := h.restoreStatus(token, "k", "v"); status != http.StatusNoContent {
		t.Fatalf("restore on the second replica = %d, want a 204 miss", status)
	}
}
