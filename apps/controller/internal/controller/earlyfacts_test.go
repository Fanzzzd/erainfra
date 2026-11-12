package controller

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Fanzzzd/erainfra/apps/controller/internal/cachefacts"
	"github.com/Fanzzzd/erainfra/apps/controller/internal/githubapi"
)

// hintingCache is a cache service that also holds job hints, and drops a
// runner's hint once its facts are pushed, as the real one does.
type hintingCache struct {
	fakeCache
	mu       sync.Mutex
	hints    []cachefacts.Hint
	prefixes []string
}

func (c *hintingCache) PendingHints(_ context.Context, prefixes []string) ([]cachefacts.Hint, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.prefixes = prefixes
	pushed := map[string]bool{}
	for _, facts := range c.facts() {
		pushed[facts.Runner] = true
	}
	var out []cachefacts.Hint
	for _, hint := range c.hints {
		if !pushed[hint.Runner] {
			out = append(out, hint)
		}
	}
	return out, nil
}

// assignedRuns is GitHub's view: which runners each run's jobs are assigned to.
type assignedRuns struct {
	fakeRuns
	runners map[int64][]string
}

func (a assignedRuns) RunRunners(_ context.Context, _ string, runID int64) ([]string, error) {
	return a.runners[runID], nil
}

// RefExists answers like a repository with branches and no tags.
func (assignedRuns) RefExists(_ context.Context, _, ref string) (bool, error) {
	return strings.HasPrefix(ref, "heads/"), nil
}

func pushRun() githubapi.WorkflowRun {
	return githubapi.WorkflowRun{
		ID: 7, Event: "push", HeadBranch: "main", HeadSHA: "abc", Path: ".github/workflows/ci.yml",
		Repository: githubapi.Repository{ID: 1, FullName: "Fanzzzd/EraInfra"},
	}
}

func runPoller(t *testing.T, cache *hintingCache, runs assignedRuns) {
	t.Helper()
	scaler, err := NewScaler(validConfig("erainfra-4vcpu-ubuntu-2404", 1), &fakeStore{}, &fakeIssuer{}, names("unused"),
		WithCachePublisher(cache, nil), WithWorkflowRuns(runs))
	if err != nil {
		t.Fatal(err)
	}
	scaler.hintPoll = 5 * time.Millisecond
	ctx, cancel := context.WithTimeout(t.Context(), 200*time.Millisecond)
	defer cancel()
	scaler.RunHintPoller(ctx, "erainfra-4vcpu-ubuntu-2404-")
	scaler.publishing.Wait()
}

// A hint GitHub confirms becomes the runner's facts, without JobStarted.
func TestConfirmedJobHintPublishesTheRunnersFacts(t *testing.T) {
	cache := &hintingCache{hints: []cachefacts.Hint{{
		Runner: "erainfra-4vcpu-ubuntu-2404-a", Repository: "Fanzzzd/EraInfra", RunID: 7, RunAttempt: 1,
	}}}
	runPoller(t, cache, assignedRuns{fakeRuns: fakeRuns{run: pushRun()}, runners: map[int64][]string{7: {"erainfra-4vcpu-ubuntu-2404-a"}}})

	pushed := cache.facts()
	if len(pushed) != 1 || pushed[0].Runner != "erainfra-4vcpu-ubuntu-2404-a" || pushed[0].Repository != "Fanzzzd/EraInfra" ||
		pushed[0].Ref != "refs/heads/main" {
		t.Fatalf("pushed = %#v, want the facts of erainfra-4vcpu-ubuntu-2404-a on refs/heads/main", pushed)
	}
	if len(cache.prefixes) != 1 || cache.prefixes[0] != "erainfra-4vcpu-ubuntu-2404-" {
		t.Fatalf("listed prefixes %q, want only this controller's", cache.prefixes)
	}
}

// A guest that names a run it is not assigned to gets nothing: GitHub's record
// decides, not the hint.
func TestJobHintGitHubDoesNotConfirmIsIgnored(t *testing.T) {
	cache := &hintingCache{hints: []cachefacts.Hint{{
		Runner: "erainfra-4vcpu-ubuntu-2404-liar", Repository: "Fanzzzd/EraInfra", RunID: 7, RunAttempt: 1,
	}}}
	runPoller(t, cache, assignedRuns{fakeRuns: fakeRuns{run: pushRun()}, runners: map[int64][]string{7: {"erainfra-4vcpu-ubuntu-2404-a"}}})

	if pushed := cache.facts(); len(pushed) != 0 {
		t.Fatalf("pushed %#v for a runner GitHub does not assign to the run", pushed)
	}
}

// Without a cache that lists hints the poller does nothing and returns.
func TestHintPollerNeedsAHintSource(t *testing.T) {
	scaler, err := NewScaler(validConfig("erainfra-4vcpu-ubuntu-2404", 1), &fakeStore{}, &fakeIssuer{}, names("unused"),
		WithCachePublisher(&fakeCache{}, nil), WithWorkflowRuns(assignedRuns{}))
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { scaler.RunHintPoller(t.Context(), "erainfra-4vcpu-ubuntu-2404-"); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("the poller ran without a hint source")
	}
}
