package controller

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/Fanzzzd/erainfra/apps/controller/internal/fleet"
	"github.com/Fanzzzd/erainfra/apps/controller/internal/githubapi"
)

// The control plane keys test results by the run's branch. A job of a called
// workflow carries the called file's ref in its workflow ref, so the branch has
// to come from the run, which the controller reads from GitHub anyway for the
// cache scope. It is sent as a second JobStarted with every other field the same.

func onlyHeadBranchSend(t *testing.T, store *fakeStore) fleet.JobStarted {
	t.Helper()
	sends := store.startedEvents(false)
	if len(sends) != 1 {
		t.Fatalf("head-branch sends = %#v, want 1", sends)
	}
	first := store.startedEvents(true)
	if len(first) != 1 {
		t.Fatalf("first sends = %#v, want 1", first)
	}
	again := sends[0]
	again.HeadBranch = ""
	if again != first[0] {
		t.Fatalf("the head-branch send differs from the first in more than the branch:\n%#v\n%#v", sends[0], first[0])
	}
	return sends[0]
}

func TestJobStartedCarriesTheRunsHeadBranchNotTheCalleesRef(t *testing.T) {
	for name, workflowRef := range map[string]string{
		"its own workflow":           "Fanzzzd/erainfra/.github/workflows/ci.yml@refs/heads/feature",
		"a workflow of its own repo": "Fanzzzd/erainfra/.github/workflows/reusable.yml@refs/heads/main",
		"another repository's":       "Fanzzzd/shared/.github/workflows/test.yml@refs/heads/main",
	} {
		t.Run(name, func(t *testing.T) {
			github := &fakeGitHub{run: run("push", "feature", nil), defaultBranch: "main"}
			_, store := publishAndRecord(t, github, 0, startedJob("rc-a", workflowRef, "push"))
			if got := onlyHeadBranchSend(t, store); got.HeadBranch != "feature" || got.WorkflowRef != workflowRef {
				t.Fatalf("sent %#v, want head branch feature beside workflow ref %q", got, workflowRef)
			}
		})
	}
}

// A fork's branch is labelled owner:branch, so a fork's "main" is never this
// repository's main.
func TestJobStartedLabelsAForksBranchWithItsOwner(t *testing.T) {
	github := &fakeGitHub{
		run: run("pull_request", "main", map[string]any{
			"head_repository": map[string]any{"id": testForkID, "full_name": "mallory/erainfra"},
		}),
		defaultBranch: "main",
	}
	_, store := publishAndRecord(t, github, 0,
		startedJob("rc-a", "Fanzzzd/erainfra/.github/workflows/ci.yml@refs/pull/9/merge", "pull_request"))
	if got := onlyHeadBranchSend(t, store).HeadBranch; got != "mallory:main" {
		t.Fatalf("HeadBranch = %q, want mallory:main", got)
	}
}

// A run GitHub would not give is no head branch, and no second send: the
// control plane then joins the job's test results by its workflow run only.
func TestJobStartedSendsNoHeadBranchWhenTheRunCannotBeRead(t *testing.T) {
	for name, github := range map[string]*fakeGitHub{
		"server error":   {status: http.StatusInternalServerError},
		"no head branch": {run: run("push", "", nil)},
		"another repository": {run: run("push", "feature", map[string]any{
			"repository": map[string]any{"id": 9, "full_name": "Fanzzzd/other"},
		})},
	} {
		t.Run(name, func(t *testing.T) {
			_, store := publishAndRecord(t, github, 200*time.Millisecond,
				startedJob("rc-a", "Fanzzzd/erainfra/.github/workflows/ci.yml@refs/heads/main", "push"))
			if sends := store.startedEvents(false); len(sends) != 0 {
				t.Fatalf("head-branch sends = %#v, want none", sends)
			}
		})
	}
}

type fakeRuns struct{ run githubapi.WorkflowRun }

func (f fakeRuns) WorkflowRun(context.Context, string, int64) (githubapi.WorkflowRun, error) {
	return f.run, nil
}

func (fakeRuns) DefaultBranch(context.Context, string) (string, error) {
	return "", errors.New("unused")
}

func (fakeRuns) RefExists(context.Context, string, string) (bool, error) {
	return false, errors.New("unused")
}

// The head branch does not depend on a cache service being configured, and a
// controller with no GitHub API sends JobStarted once, as before.
func TestJobStartedHeadBranchWithoutACache(t *testing.T) {
	runs := fakeRuns{run: githubapi.WorkflowRun{
		ID: testRunID, Event: "push", HeadBranch: "feature",
		Repository: githubapi.Repository{ID: testRepoID, FullName: testRepoName},
	}}
	for name, tc := range map[string]struct {
		opts []Option
		want int
	}{
		"with a GitHub API": {opts: []Option{WithWorkflowRuns(runs)}, want: 1},
		"without one":       {want: 0},
	} {
		t.Run(name, func(t *testing.T) {
			store := &fakeStore{}
			scaler, err := NewScaler(validConfig("rc-linux-js", 1), store, &fakeIssuer{}, names("unused"), tc.opts...)
			if err != nil {
				t.Fatal(err)
			}
			if err := scaler.HandleJobStarted(t.Context(),
				startedJob("rc-a", "Fanzzzd/shared/.github/workflows/test.yml@refs/heads/main", "push")); err != nil {
				t.Fatal(err)
			}
			scaler.publishing.Wait()
			if got := store.startedEvents(false); len(got) != tc.want {
				t.Fatalf("head-branch sends = %#v, want %d", got, tc.want)
			}
			if tc.want == 1 && store.startedEvents(false)[0].HeadBranch != "feature" {
				t.Fatalf("HeadBranch = %q", store.startedEvents(false)[0].HeadBranch)
			}
		})
	}
}
