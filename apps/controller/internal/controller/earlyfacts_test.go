package controller

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/actions/scaleset"

	"github.com/Fanzzzd/erainfra/apps/controller/internal/githubapi"
)

// scriptedRunners answers RunRunners from a script, one entry per call, and
// keeps answering the last entry once the script runs out.
type scriptedRunners struct {
	fakeRuns
	mu     sync.Mutex
	script [][]string
	calls  int
}

func (s *scriptedRunners) RunRunners(context.Context, string, int64) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	answer := s.script[min(s.calls, len(s.script)-1)]
	s.calls++
	return answer, nil
}

func pushRun() githubapi.WorkflowRun {
	return githubapi.WorkflowRun{
		ID: 7, Event: "push", HeadBranch: "main", HeadSHA: "abc", Path: ".github/workflows/ci.yml",
		Repository: githubapi.Repository{ID: 1, FullName: "Fanzzzd/EraInfra"},
	}
}

func availableJob(runID int64) *scaleset.JobAvailable {
	return &scaleset.JobAvailable{JobMessageBase: scaleset.JobMessageBase{
		RunnerRequestID: 11, RepositoryName: "EraInfra", OwnerName: "Fanzzzd",
		WorkflowRunID: runID, EventName: "push",
		JobWorkflowRef: "Fanzzzd/erainfra/.github/workflows/ci.yml@refs/heads/main",
	}}
}

// GitHub names a job's runner as soon as it assigns the job, and the scale
// set's JobStarted message can follow tens of seconds later. The controller
// publishes the facts from the first moment GitHub names one of its runners.
func TestAcquiredJobFactsArePublishedOnceGitHubNamesTheRunner(t *testing.T) {
	cache := &fakeCache{}
	runs := &scriptedRunners{
		fakeRuns: fakeRuns{run: pushRun()},
		script:   [][]string{{}, {"GitHub Actions 3"}, {"GitHub Actions 3", "rc-linux-js-a"}},
	}
	scaler, err := NewScaler(validConfig("rc-linux-js", 1), &fakeStore{}, &fakeIssuer{}, names("unused"),
		WithCachePublisher(cache, nil), WithWorkflowRuns(runs))
	if err != nil {
		t.Fatal(err)
	}
	scaler.earlyFactsPoll = time.Millisecond

	scaler.WatchAcquiredJobs(t.Context(), []*scaleset.JobAvailable{availableJob(7)})
	scaler.publishing.Wait()

	pushed := cache.facts()
	if len(pushed) != 1 || pushed[0].Runner != "rc-linux-js-a" || pushed[0].Repository != "Fanzzzd/EraInfra" ||
		pushed[0].Ref != "refs/heads/main" {
		t.Fatalf("pushed = %#v, want the facts of rc-linux-js-a for refs/heads/main", pushed)
	}
}

// A runner GitHub never names is left to the JobStarted path: the watch ends
// at its window and publishes nothing.
func TestAcquiredJobWatchEndsAtItsWindow(t *testing.T) {
	cache := &fakeCache{}
	runs := &scriptedRunners{fakeRuns: fakeRuns{run: pushRun()}, script: [][]string{{}}}
	scaler, err := NewScaler(validConfig("rc-linux-js", 1), &fakeStore{}, &fakeIssuer{}, names("unused"),
		WithCachePublisher(cache, nil), WithWorkflowRuns(runs))
	if err != nil {
		t.Fatal(err)
	}
	scaler.earlyFactsPoll = time.Millisecond
	scaler.earlyFactsWindow = 20 * time.Millisecond

	scaler.WatchAcquiredJobs(t.Context(), []*scaleset.JobAvailable{availableJob(7)})
	scaler.publishing.Wait()

	if pushed := cache.facts(); len(pushed) != 0 {
		t.Fatalf("pushed = %#v, want nothing", pushed)
	}
}

// Two jobs of one run share one watch, and each runner is published once.
func TestOneWatchPerRunPublishesEachRunnerOnce(t *testing.T) {
	cache := &fakeCache{}
	runs := &scriptedRunners{
		fakeRuns: fakeRuns{run: pushRun()},
		script:   [][]string{{"rc-linux-js-a"}, {"rc-linux-js-a", "rc-linux-js-b"}},
	}
	scaler, err := NewScaler(validConfig("rc-linux-js", 1), &fakeStore{}, &fakeIssuer{}, names("unused"),
		WithCachePublisher(cache, nil), WithWorkflowRuns(runs))
	if err != nil {
		t.Fatal(err)
	}
	scaler.earlyFactsPoll = time.Millisecond

	scaler.WatchAcquiredJobs(t.Context(), []*scaleset.JobAvailable{availableJob(7), availableJob(7)})
	scaler.publishing.Wait()

	pushed := cache.facts()
	if len(pushed) != 2 || pushed[0].Runner != "rc-linux-js-a" || pushed[1].Runner != "rc-linux-js-b" {
		t.Fatalf("pushed = %#v, want rc-linux-js-a then rc-linux-js-b once each", pushed)
	}
}
