package firecracker

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/executor"
)

const testImage = "ghcr.io/example/image@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

type fakeWarmSlot struct {
	mu       sync.Mutex
	done     chan error
	lease    *fakeWarmLease
	claims   int
	closed   int
	claimErr error
}

func newFakeWarmSlot() *fakeWarmSlot {
	return &fakeWarmSlot{done: make(chan error, 1), lease: &fakeWarmLease{done: make(chan struct{})}}
}

func (s *fakeWarmSlot) Claim(context.Context, executor.Spec) (executor.Lease, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.claims++
	if s.claimErr != nil {
		return nil, s.claimErr
	}
	return s.lease, nil
}

func (s *fakeWarmSlot) Close(context.Context) error {
	s.mu.Lock()
	s.closed++
	s.mu.Unlock()
	s.lease.finish()
	return nil
}

func (s *fakeWarmSlot) Done() <-chan error { return s.done }

type fakeWarmLease struct {
	once sync.Once
	done chan struct{}
}

func (l *fakeWarmLease) finish() { l.once.Do(func() { close(l.done) }) }

func (l *fakeWarmLease) Wait(ctx context.Context) (executor.Result, error) {
	select {
	case <-ctx.Done():
		return executor.Result{}, ctx.Err()
	case <-l.done:
		return executor.Result{}, nil
	}
}

func (l *fakeWarmLease) Cancel(context.Context) error {
	l.finish()
	return nil
}

func testProfile(target int) executor.Profile {
	return executor.Profile{
		Name: "linux", ImageRelease: testImage, VCPUs: 2, MemoryMiB: 4096, WarmPool: target,
	}
}

func testAttempt() executor.Spec {
	return executor.Spec{
		Kind: "ci", AttemptID: "attempt-1", RunnerName: "runner-1", Profile: "linux",
		ImageRelease: testImage, VCPUs: 2, MemoryMiB: 4096, JITConfig: "secret",
	}
}

func TestWarmPoolLifecycleAndCapacityTransfer(t *testing.T) {
	var mu sync.Mutex
	var created []*fakeWarmSlot
	pool := newWarmPoolManager(func(context.Context, executor.Profile, uint64) (warmSlot, error) {
		slot := newFakeWarmSlot()
		mu.Lock()
		created = append(created, slot)
		mu.Unlock()
		return slot, nil
	})

	status, err := pool.Configure(t.Context(), testProfile(2))
	if err != nil {
		t.Fatal(err)
	}
	assertWarmStatus(t, status, 2, 2, 0, true)

	lease, err := pool.Claim(t.Context(), testAttempt())
	if err != nil {
		t.Fatal(err)
	}
	assertWarmStatus(t, pool.Status("linux"), 2, 1, 1, true)
	mu.Lock()
	if len(created) != 2 {
		t.Fatalf("claim booted replacement early: created=%d", len(created))
	}
	mu.Unlock()

	if _, err := pool.Claim(t.Context(), testAttempt()); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Claim(t.Context(), testAttempt()); !errors.Is(err, errWarmPoolMiss) {
		t.Fatalf("third claim error = %v, want clean pool miss", err)
	}
	assertWarmStatus(t, pool.Status("linux"), 2, 0, 2, true)

	if err := lease.Cancel(t.Context()); err != nil {
		t.Fatal(err)
	}
	eventually(t, func() bool {
		status := pool.Status("linux")
		return status.Parked == 1 && status.Claimed == 1 && status.Healthy
	})
	mu.Lock()
	if len(created) != 3 {
		t.Fatalf("teardown created %d total slots, want 3", len(created))
	}
	mu.Unlock()
}

func TestWarmPoolFailureIsUnhealthyAndRecoversDeadParkedSlot(t *testing.T) {
	fail := true
	var last *fakeWarmSlot
	pool := newWarmPoolManager(func(context.Context, executor.Profile, uint64) (warmSlot, error) {
		if fail {
			return nil, errors.New("boot failed")
		}
		last = newFakeWarmSlot()
		return last, nil
	})
	status, err := pool.Configure(t.Context(), testProfile(1))
	if err == nil || status.Healthy || status.Detail == "" {
		t.Fatalf("status=%+v err=%v, want explicit failure", status, err)
	}
	if _, err := pool.Claim(t.Context(), testAttempt()); err == nil || errors.Is(err, errWarmPoolMiss) {
		t.Fatalf("unhealthy pool claim did not fail closed: %v", err)
	}

	fail = false
	if _, err := pool.Configure(t.Context(), testProfile(1)); err != nil {
		t.Fatal(err)
	}
	last.done <- errors.New("VMM exited")
	eventually(t, func() bool {
		return pool.Status("linux").Healthy && pool.Status("linux").Parked == 1
	})
}

func TestWarmPoolMetadataFailureDestroysSlotAndNeverReturnsIt(t *testing.T) {
	var created []*fakeWarmSlot
	pool := newWarmPoolManager(func(context.Context, executor.Profile, uint64) (warmSlot, error) {
		slot := newFakeWarmSlot()
		if len(created) == 0 {
			slot.claimErr = errors.New("ambiguous MMDS write")
		}
		created = append(created, slot)
		return slot, nil
	})
	if _, err := pool.Configure(t.Context(), testProfile(1)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Claim(t.Context(), testAttempt()); err == nil {
		t.Fatal("ambiguous metadata injection succeeded")
	}
	eventually(t, func() bool { return pool.Status("linux").Healthy })
	if created[0].claims != 1 || created[0].closed != 1 || len(created) != 2 {
		t.Fatalf("failed slot was reused: claims=%d closed=%d created=%d", created[0].claims, created[0].closed, len(created))
	}
}

func TestWarmPoolReduceRemoveAndShutdown(t *testing.T) {
	var created []*fakeWarmSlot
	pool := newWarmPoolManager(func(context.Context, executor.Profile, uint64) (warmSlot, error) {
		slot := newFakeWarmSlot()
		created = append(created, slot)
		return slot, nil
	})
	if _, err := pool.Configure(t.Context(), testProfile(3)); err != nil {
		t.Fatal(err)
	}
	if status, err := pool.Configure(t.Context(), testProfile(1)); err != nil {
		t.Fatal(err)
	} else {
		assertWarmStatus(t, status, 1, 1, 0, true)
	}
	if err := pool.Remove(t.Context(), "linux"); err != nil {
		t.Fatal(err)
	}
	assertWarmStatus(t, pool.Status("linux"), 0, 0, 0, true)
	if _, err := pool.Configure(t.Context(), testProfile(1)); err != nil {
		t.Fatal(err)
	}
	if err := pool.Shutdown(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Configure(t.Context(), testProfile(1)); err == nil {
		t.Fatal("configure after shutdown succeeded")
	}
}

func TestWarmPoolRemovalDrainsIdleWithoutInterruptingClaim(t *testing.T) {
	pool := newWarmPoolManager(func(context.Context, executor.Profile, uint64) (warmSlot, error) {
		return newFakeWarmSlot(), nil
	})
	if _, err := pool.Configure(t.Context(), testProfile(2)); err != nil {
		t.Fatal(err)
	}
	lease, err := pool.Claim(t.Context(), testAttempt())
	if err != nil {
		t.Fatal(err)
	}
	if err := pool.Remove(t.Context(), "linux"); err != nil {
		t.Fatal(err)
	}
	status := pool.Status("linux")
	if status.Target != 0 || status.Parked != 0 || status.Claimed != 1 {
		t.Fatalf("claimed VM was not allowed to drain: %+v", status)
	}
	if err := lease.Cancel(t.Context()); err != nil {
		t.Fatal(err)
	}
	eventually(t, func() bool { return pool.Status("linux").Healthy })
}

func TestWarmPoolOrphanRecoveryPreservesOnlyServerLiveClaims(t *testing.T) {
	pool := newWarmPoolManager(func(context.Context, executor.Profile, uint64) (warmSlot, error) {
		return newFakeWarmSlot(), nil
	})
	if _, err := pool.Configure(t.Context(), testProfile(2)); err != nil {
		t.Fatal(err)
	}
	liveSpec := testAttempt()
	liveSpec.AttemptID = "attempt-live"
	liveLease, err := pool.Claim(t.Context(), liveSpec)
	if err != nil {
		t.Fatal(err)
	}
	orphanSpec := testAttempt()
	orphanSpec.AttemptID = "attempt-orphan"
	if _, err := pool.Claim(t.Context(), orphanSpec); err != nil {
		t.Fatal(err)
	}
	if err := pool.RecoverOrphans(t.Context(), []string{"attempt-live"}); err != nil {
		t.Fatal(err)
	}
	eventually(t, func() bool {
		status := pool.Status("linux")
		return status.Claimed == 1 && status.Parked == 1
	})
	if err := liveLease.Cancel(t.Context()); err != nil {
		t.Fatal(err)
	}
}

func assertWarmStatus(
	t *testing.T,
	status executor.WarmPoolStatus,
	target, parked, claimed int,
	healthy bool,
) {
	t.Helper()
	if status.Target != target || status.Parked != parked || status.Claimed != claimed || status.Healthy != healthy {
		t.Fatalf("status = %+v, want target=%d parked=%d claimed=%d healthy=%t", status, target, parked, claimed, healthy)
	}
}

func eventually(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("condition did not become true")
}
