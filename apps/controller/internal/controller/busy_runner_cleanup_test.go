package controller

import (
	"errors"
	"fmt"
	"reflect"
	"testing"
	"time"

	"github.com/actions/scaleset"

	"github.com/Fanzzzd/erainfra/apps/controller/internal/fleet"
)

// GitHub refuses to delete a Runner it has handed a job (JobStillRunningException)
// until that job ends. A Runner the control plane is retiring, or whose Attempt
// ended while its Worker was unreachable, can be in that state. That one cleanup
// must not stop the Profile from creating the Runners its queued jobs need.
func TestBusyRunnerCleanupDoesNotBlockScaleUp(t *testing.T) {
	cleanup := fleet.RunnerCleanup{RunnerName: "raced", RunnerID: 39}
	store := &fakeStore{cleanups: []fleet.RunnerCleanup{cleanup}}
	issuer := &fakeIssuer{
		nextID:    40,
		removeErr: fmt.Errorf("DELETE runner 39: %w: still running", scaleset.JobStillRunningError),
	}
	scaler, err := NewScaler(validConfig("rc-linux-js", 4), store, issuer, names("a", "b", "c"))
	if err != nil {
		t.Fatal(err)
	}
	actual, err := scaler.HandleDesiredRunnerCount(t.Context(), 3)
	if err != nil {
		t.Errorf("HandleDesiredRunnerCount failed on a busy Runner's cleanup: %v (the scale-set listener exits on this error)", err)
	}
	if len(store.created) != 3 || actual != 3 {
		t.Errorf("created %d Attempts (actual %d), want 3: queued jobs wait until GitHub ends the raced job", len(store.created), actual)
	}
	if len(store.cleaned) != 0 {
		t.Errorf("acknowledged %v: the busy Runner was not deleted, so the control plane must keep it", store.cleaned)
	}
}

// Any other GitHub failure to delete a Runner is retried on the next pass the
// same way, rather than holding back the scale-up.
func TestFailedRunnerDeletionIsRetriedLater(t *testing.T) {
	store := &fakeStore{cleanups: []fleet.RunnerCleanup{{RunnerName: "orphan", RunnerID: 7}}}
	issuer := &fakeIssuer{nextID: 10, removeErr: errors.New("502 Bad Gateway")}
	scaler, err := NewScaler(validConfig("rc-linux-js", 2), store, issuer, names("a"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := scaler.HandleDesiredRunnerCount(t.Context(), 1); err != nil {
		t.Fatal(err)
	}
	if len(store.created) != 1 || len(store.cleaned) != 0 {
		t.Fatalf("created %d, acknowledged %v; want 1 created and the cleanup kept", len(store.created), store.cleaned)
	}
}

// A scale-down records the intent, deletes the Runner, and only then tells the
// control plane, which ends the Attempt and its executor at that point. A Runner
// GitHub reports busy took a job: it is not acknowledged, so its Attempt stays,
// and the pass carries on.
func TestScaleDownLeavesABusyRunnerToItsJob(t *testing.T) {
	base := time.Date(2026, 11, 6, 9, 0, 0, 0, time.UTC)
	store := &fakeStore{active: []fleet.Attempt{
		{RunnerName: "old-idle", RunnerID: 2, State: fleet.AttemptReady, CreatedAt: base},
		{RunnerName: "new-idle", RunnerID: 3, State: fleet.AttemptReady, CreatedAt: base.Add(time.Minute)},
	}}
	issuer := &fakeIssuer{removeErr: fmt.Errorf("DELETE: %w", scaleset.JobStillRunningError)}
	scaler, err := NewScaler(validConfig("rc-linux-js", 4), store, issuer, names("unused"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := scaler.HandleDesiredRunnerCount(t.Context(), 0); err != nil {
		t.Fatalf("scale-down failed on a busy Runner: %v", err)
	}
	if !reflect.DeepEqual(store.cancelled, []string{"new-idle", "old-idle"}) {
		t.Fatalf("cancelled = %v", store.cancelled)
	}
	if !reflect.DeepEqual(issuer.removed, []int64{3, 2}) {
		t.Fatalf("removed = %v", issuer.removed)
	}
	if len(store.cleaned) != 0 {
		t.Fatalf("acknowledged %v while GitHub still ran their jobs", store.cleaned)
	}
}

// The control plane answers that an Attempt is already running when its
// JobStarted landed first. The scale-down skips it without touching GitHub.
func TestScaleDownSkipsAnAttemptThatStartedAJob(t *testing.T) {
	store := &fakeStore{
		active: []fleet.Attempt{
			{RunnerName: "started", RunnerID: 5, State: fleet.AttemptReady, CreatedAt: time.Now()},
		},
		cancelError: fmt.Errorf("%w: controller API returned 409 Conflict", fleet.ErrAttemptRunning),
	}
	issuer := &fakeIssuer{}
	scaler, err := NewScaler(validConfig("rc-linux-js", 4), store, issuer, names("unused"))
	if err != nil {
		t.Fatal(err)
	}
	actual, err := scaler.HandleDesiredRunnerCount(t.Context(), 0)
	if err != nil {
		t.Fatalf("scale-down failed on a running Attempt: %v", err)
	}
	if actual != 1 || len(issuer.removed) != 0 {
		t.Fatalf("actual = %d, removed = %v; want the running Runner kept", actual, issuer.removed)
	}
}
