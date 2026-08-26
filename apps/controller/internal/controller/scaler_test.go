package controller

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/Fanzzzd/erainfra/apps/controller/internal/cachefacts"
	"github.com/Fanzzzd/erainfra/apps/controller/internal/fleet"
	"github.com/actions/scaleset"
)

type fakeCache struct {
	pushed []cachefacts.Facts
	err    error
}

func (f *fakeCache) Push(_ context.Context, facts cachefacts.Facts) error {
	f.pushed = append(f.pushed, facts)
	return f.err
}

type fakeStore struct {
	active       []fleet.Attempt
	cleanups     []fleet.RunnerCleanup
	cleaned      []fleet.RunnerCleanup
	created      []fleet.NewAttempt
	cancelled    []string
	started      []fleet.JobStarted
	completed    []fleet.JobCompleted
	createError  error
	cancelError  error
	startedError error
}

func (f *fakeStore) RegisterProfile(context.Context, fleet.ProfileSpec) error { return nil }

func (f *fakeStore) ListActiveAttempts(context.Context, string) ([]fleet.Attempt, error) {
	return append([]fleet.Attempt(nil), f.active...), nil
}

func (f *fakeStore) ListRunnerCleanups(context.Context, string) ([]fleet.RunnerCleanup, error) {
	return append([]fleet.RunnerCleanup(nil), f.cleanups...), nil
}

func (f *fakeStore) CompleteRunnerCleanup(
	_ context.Context,
	_ string,
	cleanup fleet.RunnerCleanup,
) error {
	f.cleaned = append(f.cleaned, cleanup)
	return nil
}

func (f *fakeStore) CreateAttempt(_ context.Context, attempt fleet.NewAttempt) error {
	if f.createError != nil {
		return f.createError
	}
	f.created = append(f.created, attempt)
	f.active = append(f.active, fleet.Attempt{
		RunnerName: attempt.RunnerName,
		RunnerID:   attempt.RunnerID,
		State:      fleet.AttemptPending,
		CreatedAt:  time.Now(),
	})
	return nil
}

func (f *fakeStore) CancelAttempt(_ context.Context, _, runnerName, _ string) error {
	if f.cancelError != nil {
		return f.cancelError
	}
	f.cancelled = append(f.cancelled, runnerName)
	return nil
}

func (f *fakeStore) MarkJobStarted(_ context.Context, event fleet.JobStarted) error {
	f.started = append(f.started, event)
	return f.startedError
}

func (f *fakeStore) MarkJobCompleted(_ context.Context, event fleet.JobCompleted) error {
	f.completed = append(f.completed, event)
	return nil
}

type fakeIssuer struct {
	nextID      int64
	generated   []string
	removed     []int64
	generateErr error
	removeErr   error
}

func (f *fakeIssuer) GenerateJIT(_ context.Context, runnerName string) (JITConfig, error) {
	if f.generateErr != nil {
		return JITConfig{}, f.generateErr
	}
	f.nextID++
	f.generated = append(f.generated, runnerName)
	return JITConfig{RunnerID: f.nextID, EncodedJITConfig: "secret-for-" + runnerName}, nil
}

func (f *fakeIssuer) RemoveRunner(_ context.Context, runnerID int64) error {
	f.removed = append(f.removed, runnerID)
	return f.removeErr
}

func names(values ...string) func() (string, error) {
	index := 0
	return func() (string, error) {
		value := values[index]
		index++
		return value, nil
	}
}

func validConfig(profile string, maxRunners int) Config {
	return Config{
		Profile:      profile,
		Executor:     "firecracker",
		ImageRelease: "ghcr.io/fanzzzd/runner@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		VCPUs:        2,
		MemoryMiB:    4096,
		MaxRunners:   maxRunners,
	}
}

func TestScalerReconcilesDesiredCountDurably(t *testing.T) {
	store := &fakeStore{}
	issuer := &fakeIssuer{nextID: 40}
	scaler, err := NewScaler(
		validConfig("rc-linux-js", 4),
		store,
		issuer,
		names("rc-linux-js-a", "rc-linux-js-b"),
	)
	if err != nil {
		t.Fatal(err)
	}

	actual, err := scaler.HandleDesiredRunnerCount(t.Context(), 2)
	if err != nil {
		t.Fatal(err)
	}
	if actual != 2 {
		t.Fatalf("actual runners = %d, want 2", actual)
	}
	if !reflect.DeepEqual(issuer.generated, []string{"rc-linux-js-a", "rc-linux-js-b"}) {
		t.Fatalf("generated runners = %v", issuer.generated)
	}
	if len(store.created) != 2 {
		t.Fatalf("created attempts = %d, want 2", len(store.created))
	}
	if store.created[0].EncodedJITConfig != "secret-for-rc-linux-js-a" {
		t.Fatal("JIT configuration was not handed to the durable store")
	}
}

func TestScalerDeletesAbandonedRunnersBeforeReplacingCapacity(t *testing.T) {
	cleanup := fleet.RunnerCleanup{RunnerName: "abandoned", RunnerID: 39}
	store := &fakeStore{cleanups: []fleet.RunnerCleanup{cleanup}}
	issuer := &fakeIssuer{nextID: 40}
	scaler, err := NewScaler(
		validConfig("rc-linux-js", 1),
		store,
		issuer,
		names("replacement"),
	)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := scaler.HandleDesiredRunnerCount(t.Context(), 1); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(issuer.removed, []int64{39}) {
		t.Fatalf("removed = %v, want abandoned runner", issuer.removed)
	}
	if !reflect.DeepEqual(store.cleaned, []fleet.RunnerCleanup{cleanup}) {
		t.Fatalf("completed cleanups = %#v", store.cleaned)
	}
	if len(store.created) != 1 || store.created[0].RunnerName != "replacement" {
		t.Fatalf("created replacement = %#v", store.created)
	}
}

func TestScalerCapsDemandAndKeepsRunningAttempts(t *testing.T) {
	base := time.Date(2026, 8, 10, 12, 0, 0, 0, time.UTC)
	store := &fakeStore{active: []fleet.Attempt{
		{RunnerName: "running", RunnerID: 1, State: fleet.AttemptRunning, CreatedAt: base},
		{RunnerName: "old-idle", RunnerID: 2, State: fleet.AttemptReady, CreatedAt: base.Add(time.Minute)},
		{RunnerName: "new-idle", RunnerID: 3, State: fleet.AttemptPending, CreatedAt: base.Add(2 * time.Minute)},
	}}
	issuer := &fakeIssuer{}
	scaler, err := NewScaler(
		func() Config {
			config := validConfig("rc-macos-15", 2)
			config.Executor = "tart"
			return config
		}(),
		store,
		issuer,
		names("unused"),
	)
	if err != nil {
		t.Fatal(err)
	}

	actual, err := scaler.HandleDesiredRunnerCount(t.Context(), 1)
	if err != nil {
		t.Fatal(err)
	}
	if actual != 1 {
		t.Fatalf("actual runners = %d, want 1", actual)
	}
	if !reflect.DeepEqual(store.cancelled, []string{"new-idle", "old-idle"}) {
		t.Fatalf("cancelled = %v, want newest idle attempts first", store.cancelled)
	}
	if !reflect.DeepEqual(issuer.removed, []int64{3, 2}) {
		t.Fatalf("removed runner ids = %v", issuer.removed)
	}
}

func TestScalerCompensatesFailedAttemptCreation(t *testing.T) {
	store := &fakeStore{createError: errors.New("control plane unavailable")}
	issuer := &fakeIssuer{nextID: 80}
	scaler, err := NewScaler(
		validConfig("rc-linux-js", 1),
		store,
		issuer,
		names("rc-linux-js-orphan"),
	)
	if err != nil {
		t.Fatal(err)
	}

	_, err = scaler.HandleDesiredRunnerCount(t.Context(), 1)
	if err == nil || !strings.Contains(err.Error(), "create attempt") {
		t.Fatalf("error = %v, want create attempt failure", err)
	}
	if !reflect.DeepEqual(issuer.removed, []int64{81}) {
		t.Fatalf("removed runner ids = %v, want orphan cleanup", issuer.removed)
	}
	if strings.Contains(err.Error(), "secret-for") {
		t.Fatal("error leaked the JIT configuration")
	}
}

func TestScalerMapsLifecycleMessages(t *testing.T) {
	store := &fakeStore{}
	scaler, err := NewScaler(
		validConfig("rc-linux-js", 1),
		store,
		&fakeIssuer{},
		names("unused"),
	)
	if err != nil {
		t.Fatal(err)
	}
	queueTime := time.Date(2026, 8, 10, 12, 1, 0, 0, time.UTC)
	finishedAt := queueTime.Add(3 * time.Minute)

	err = scaler.HandleJobStarted(t.Context(), &scaleset.JobStarted{
		RunnerName: "rc-linux-js-a",
		JobMessageBase: scaleset.JobMessageBase{
			RunnerRequestID: 7,
			RepositoryName:  "EraInfra",
			OwnerName:       "Fanzzzd",
			JobID:           "job-1",
			JobWorkflowRef:  "Fanzzzd/erainfra/.github/workflows/ci.yml@refs/heads/main",
			JobDisplayName:  "check",
			WorkflowRunID:   99,
			EventName:       "pull_request",
			QueueTime:       queueTime,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	err = scaler.HandleJobCompleted(t.Context(), &scaleset.JobCompleted{
		RunnerName: "rc-linux-js-a",
		Result:     "succeeded",
		JobMessageBase: scaleset.JobMessageBase{
			RunnerRequestID: 7,
			JobID:           "job-1",
			FinishTime:      finishedAt,
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	if len(store.started) != 1 || store.started[0].Repository != "EraInfra" {
		t.Fatalf("started events = %#v", store.started)
	}
	if len(store.completed) != 1 || store.completed[0].FinishedAt != finishedAt {
		t.Fatalf("completed events = %#v", store.completed)
	}
}

// A branch push is the common case: the controller learns the repository from the
// owner and repository halves, the ref from the workflow ref, and publishes them
// so the runner's cache scopes to its own repository with read-write.
func TestScalerPublishesCacheFactsAtJobStart(t *testing.T) {
	cache := &fakeCache{}
	scaler, err := NewScaler(
		validConfig("rc-linux-js", 1),
		&fakeStore{},
		&fakeIssuer{},
		names("unused"),
		WithCachePublisher(cache, nil),
	)
	if err != nil {
		t.Fatal(err)
	}

	err = scaler.HandleJobStarted(t.Context(), &scaleset.JobStarted{
		RunnerName: "rc-linux-js-a",
		JobMessageBase: scaleset.JobMessageBase{
			RepositoryName: "EraInfra",
			OwnerName:      "Fanzzzd",
			JobWorkflowRef: "Fanzzzd/erainfra/.github/workflows/ci.yml@refs/heads/main",
			EventName:      "push",
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	want := cachefacts.Facts{
		Runner:     "rc-linux-js-a",
		Repository: "Fanzzzd/EraInfra",
		Event:      "push",
		Ref:        "refs/heads/main",
	}
	if len(cache.pushed) != 1 || cache.pushed[0] != want {
		t.Fatalf("pushed facts = %#v, want one %#v", cache.pushed, want)
	}
}

// The cache is an optimization: a publish that fails is logged, but the job start
// is still recorded, because the fleet accounting must not depend on the cache.
func TestScalerToleratesCacheFactsFailure(t *testing.T) {
	cache := &fakeCache{err: errors.New("cache down")}
	store := &fakeStore{}
	scaler, err := NewScaler(
		validConfig("rc-linux-js", 1),
		store,
		&fakeIssuer{},
		names("unused"),
		WithCachePublisher(cache, nil),
	)
	if err != nil {
		t.Fatal(err)
	}

	err = scaler.HandleJobStarted(t.Context(), &scaleset.JobStarted{
		RunnerName: "rc-linux-js-a",
		JobMessageBase: scaleset.JobMessageBase{
			RepositoryName: "EraInfra",
			OwnerName:      "Fanzzzd",
			JobWorkflowRef: "Fanzzzd/erainfra/.github/workflows/ci.yml@refs/heads/main",
			EventName:      "push",
		},
	})
	if err != nil {
		t.Fatalf("a cache publish failure failed the job: %v", err)
	}
	if len(store.started) != 1 {
		t.Fatalf("job start was not recorded despite cache failure: %#v", store.started)
	}
}

func TestScalerRejectsUnsafeConfiguration(t *testing.T) {
	missingProfile := validConfig("rc-linux", 1)
	missingProfile.Profile = ""
	negativeMinimum := validConfig("rc-linux", 1)
	negativeMinimum.MinRunners = -1
	badBounds := validConfig("rc-linux", 1)
	badBounds.MinRunners = 2
	zeroMaximum := validConfig("rc-linux", 0)
	tests := []Config{missingProfile, negativeMinimum, badBounds, zeroMaximum}
	for _, config := range tests {
		if _, err := NewScaler(config, &fakeStore{}, &fakeIssuer{}, names("unused")); err == nil {
			t.Fatalf("NewScaler(%+v) succeeded", config)
		}
	}
}
