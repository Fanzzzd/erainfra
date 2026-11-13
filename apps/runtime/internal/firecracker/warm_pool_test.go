package firecracker

import (
	"context"
	"encoding/json"
	"errors"
	"os"
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

// The thin-pool headroom check sizes against every Profile's warm pool at once,
// with the Profile being configured counted at its new target rather than its
// current one.
func TestWarmPoolTotalTargetCountsTheReconfiguredProfileOnce(t *testing.T) {
	pool := newWarmPoolManager(func(context.Context, executor.Profile, uint64) (warmSlot, error) {
		return newFakeWarmSlot(), nil
	})
	large := testProfile(3)
	large.Name = "large"
	for _, profile := range []executor.Profile{testProfile(2), large} {
		if _, err := pool.Configure(t.Context(), profile); err != nil {
			t.Fatal(err)
		}
	}
	if got := pool.totalTargetWith(testProfile(5)); got != 8 {
		t.Fatalf("reconfigured total = %d, want 5 (linux, new target) + 3 (large)", got)
	}
	added := testProfile(1)
	added.Name = "added"
	if got := pool.totalTargetWith(added); got != 6 {
		t.Fatalf("added total = %d, want 1 (added) + 2 (linux) + 3 (large)", got)
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

// gatedWarmFactory parks the first `ready` slots at once and holds every later
// boot until the test releases it, so a test can act inside the window in which
// the pool boots a replacement.
type gatedWarmFactory struct {
	mu      sync.Mutex
	ready   int
	created []*fakeWarmSlot
	booting chan struct{}
	release chan error
}

func newGatedWarmFactory(ready int) *gatedWarmFactory {
	return &gatedWarmFactory{ready: ready, booting: make(chan struct{}, 8), release: make(chan error)}
}

func (f *gatedWarmFactory) boot(ctx context.Context, _ executor.Profile, _ uint64) (warmSlot, error) {
	f.mu.Lock()
	gated := len(f.created) >= f.ready
	f.mu.Unlock()
	if gated {
		f.booting <- struct{}{}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case err := <-f.release:
			if err != nil {
				return nil, err
			}
		}
	}
	slot := newFakeWarmSlot()
	f.mu.Lock()
	f.created = append(f.created, slot)
	f.mu.Unlock()
	return slot, nil
}

// replacementWindow configures a pool of target, claims one guest and tears it
// down, and returns once the pool is booting that guest's replacement.
func replacementWindow(t *testing.T, ready, target int) (*warmPoolManager, *gatedWarmFactory) {
	t.Helper()
	factory := newGatedWarmFactory(ready)
	pool := newWarmPoolManager(factory.boot)
	t.Cleanup(func() { _ = pool.Shutdown(context.Background()) })
	if _, err := pool.Configure(t.Context(), testProfile(target)); err != nil {
		t.Fatal(err)
	}
	first, err := pool.Claim(t.Context(), testAttempt())
	if err != nil {
		t.Fatal(err)
	}
	if err := first.Cancel(t.Context()); err != nil {
		t.Fatal(err)
	}
	<-factory.booting
	return pool, factory
}

type claimOutcome struct {
	lease executor.Lease
	err   error
}

func claimAsync(ctx context.Context, pool *warmPoolManager, attemptID string) <-chan claimOutcome {
	outcome := make(chan claimOutcome, 1)
	go func() {
		spec := testAttempt()
		spec.AttemptID = attemptID
		lease, err := pool.Claim(ctx, spec)
		outcome <- claimOutcome{lease: lease, err: err}
	}()
	return outcome
}

func assertClaimPending(t *testing.T, outcome <-chan claimOutcome) {
	t.Helper()
	select {
	case got := <-outcome:
		t.Fatalf("claim returned during the replacement boot: lease=%v err=%v", got.lease, got.err)
	case <-time.After(50 * time.Millisecond):
	}
}

func awaitClaim(t *testing.T, outcome <-chan claimOutcome) claimOutcome {
	t.Helper()
	select {
	case got := <-outcome:
		return got
	case <-time.After(2 * time.Second):
		t.Fatal("claim did not return")
		return claimOutcome{}
	}
}

// A claim within the pool's target, made while the pool boots the replacement
// for a torn-down guest, is demand the pool owns. It gets the replacement. It
// neither fails the Attempt nor cold-boots a guest the host has no slot for.
func TestWarmPoolClaimDuringReplacementWaitsForTheReplacement(t *testing.T) {
	pool, factory := replacementWindow(t, 1, 1)
	assertWarmStatus(t, pool.Status("linux"), 1, 0, 0, false)

	outcome := claimAsync(t.Context(), pool, "attempt-2")
	assertClaimPending(t, outcome)
	factory.release <- nil
	if got := awaitClaim(t, outcome); got.err != nil {
		t.Fatalf("claim during the replacement boot failed: %v", got.err)
	}
	factory.mu.Lock()
	replacement := factory.created[1]
	factory.mu.Unlock()
	if replacement.claims != 1 {
		t.Fatalf("claim did not take the replacement: claims=%d", replacement.claims)
	}
	assertWarmStatus(t, pool.Status("linux"), 1, 0, 1, true)
}

// A parked guest that is already waiting serves a claim at once, even while the
// pool boots a replacement for another slot.
func TestWarmPoolClaimDuringReplacementTakesAParkedGuestAtOnce(t *testing.T) {
	pool, _ := replacementWindow(t, 2, 2)
	if _, err := pool.Claim(t.Context(), testAttempt()); err != nil {
		t.Fatalf("claim with a parked guest during the replacement boot failed: %v", err)
	}
	assertWarmStatus(t, pool.Status("linux"), 2, 0, 1, false)
}

// Demand above the target is a miss even inside the replacement window: once
// the replacement is claimed, the other waiting claim cold-boots.
func TestWarmPoolClaimAboveTargetDuringReplacementMisses(t *testing.T) {
	pool, factory := replacementWindow(t, 1, 1)
	left := claimAsync(t.Context(), pool, "attempt-2")
	right := claimAsync(t.Context(), pool, "attempt-3")
	assertClaimPending(t, left)
	factory.release <- nil
	var warm, missed int
	for _, outcome := range []claimOutcome{awaitClaim(t, left), awaitClaim(t, right)} {
		switch {
		case outcome.err == nil:
			warm++
		case errors.Is(outcome.err, errWarmPoolMiss):
			missed++
		default:
			t.Fatalf("claim failed: %v", outcome.err)
		}
	}
	if warm != 1 || missed != 1 {
		t.Fatalf("warm=%d missed=%d, want one warm claim and one miss", warm, missed)
	}
}

// A replacement that fails to boot leaves a broken pool. The waiting claim
// fails the Attempt rather than hiding the failure behind a cold boot.
func TestWarmPoolClaimDuringFailedReplacementFailsClosed(t *testing.T) {
	pool, factory := replacementWindow(t, 1, 1)
	outcome := claimAsync(t.Context(), pool, "attempt-2")
	assertClaimPending(t, outcome)
	factory.release <- errors.New("thin pool is full")
	got := awaitClaim(t, outcome)
	if got.err == nil || errors.Is(got.err, errWarmPoolMiss) {
		t.Fatalf("claim on a failed replacement = %v, want a warm pool failure", got.err)
	}
}

// The Attempt's boot deadline bounds the wait.
func TestWarmPoolClaimDuringReplacementHonorsTheBootDeadline(t *testing.T) {
	pool, _ := replacementWindow(t, 1, 1)
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Millisecond)
	defer cancel()
	if _, err := pool.Claim(ctx, testAttempt()); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("claim past the boot deadline = %v, want deadline exceeded", err)
	}
}

// Lowering the target below the claimed count is a planned drain, not a broken
// pool. Every guest the pool may own is claimed, so a claim is demand above the
// target and cold-boots. The pool stays healthy, so its Profile stays ready,
// and each release shrinks it toward the target.
func TestWarmPoolTargetBelowClaimedDrainsAndMisses(t *testing.T) {
	pool := newWarmPoolManager(func(context.Context, executor.Profile, uint64) (warmSlot, error) {
		return newFakeWarmSlot(), nil
	})
	t.Cleanup(func() { _ = pool.Shutdown(context.Background()) })
	if _, err := pool.Configure(t.Context(), testProfile(2)); err != nil {
		t.Fatal(err)
	}
	first, err := pool.Claim(t.Context(), testAttempt())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Claim(t.Context(), testAttempt()); err != nil {
		t.Fatal(err)
	}
	status, err := pool.Configure(t.Context(), testProfile(1))
	if err != nil {
		t.Fatalf("lowering the target below the claimed count failed: %v", err)
	}
	assertWarmStatus(t, status, 1, 0, 2, true)
	if _, err := pool.Claim(t.Context(), testAttempt()); !errors.Is(err, errWarmPoolMiss) {
		t.Fatalf("claim during the drain = %v, want a miss", err)
	}
	if err := first.Cancel(t.Context()); err != nil {
		t.Fatal(err)
	}
	eventually(t, func() bool {
		status := pool.Status("linux")
		return status.Parked == 0 && status.Claimed == 1 && status.Healthy
	})
}

// testdata/warm-pool-ready-cases.json owns which pool accounting is ready. The
// Action Runner Agent and the control plane run the same cases, so a change to
// the rule on one side alone turns one suite red.
func TestWarmPoolOwnsTargetMatchesTheSharedCases(t *testing.T) {
	contents, err := os.ReadFile("../../../../testdata/warm-pool-ready-cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var shared struct {
		Cases []struct {
			Name                    string
			Target, Parked, Claimed int
			Ready                   bool
		}
	}
	if err := json.Unmarshal(contents, &shared); err != nil {
		t.Fatal(err)
	}
	if len(shared.Cases) == 0 {
		t.Fatal("no shared warm pool cases")
	}
	for _, c := range shared.Cases {
		t.Run(c.Name, func(t *testing.T) {
			if got := warmPoolOwnsTarget(c.Target, c.Parked, c.Claimed); got != c.Ready {
				t.Fatalf("warmPoolOwnsTarget(%d, %d, %d) = %t, want %t", c.Target, c.Parked, c.Claimed, got, c.Ready)
			}
			state := newWarmPoolState(testProfile(c.Target))
			for id := range c.Parked {
				state.idle[uint64(id)] = newFakeWarmSlot()
			}
			for id := range c.Claimed {
				state.claimed[uint64(c.Parked+id)] = newFakeWarmSlot()
			}
			if status := statusOf(state); status.Healthy != c.Ready {
				t.Fatalf("status = %+v, want healthy=%t", status, c.Ready)
			}
			state.lastErr = errors.New("boot failed")
			if status := statusOf(state); status.Healthy {
				t.Fatalf("status with a recorded error = %+v, want unhealthy", status)
			}
		})
	}
}

// parkedExitWindow configures a pool of one, makes its parked guest exit and
// returns once the pool is booting the replacement.
func parkedExitWindow(t *testing.T) (*warmPoolManager, *gatedWarmFactory) {
	t.Helper()
	factory := newGatedWarmFactory(1)
	pool := newWarmPoolManager(factory.boot)
	t.Cleanup(func() { _ = pool.Shutdown(context.Background()) })
	if _, err := pool.Configure(t.Context(), testProfile(1)); err != nil {
		t.Fatal(err)
	}
	factory.slot(0).done <- errors.New("VMM exited")
	<-factory.booting
	return pool, factory
}

func (f *gatedWarmFactory) slot(index int) *fakeWarmSlot {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.created[index]
}

// A parked guest that exits once is replaced like a torn-down one. A claim in
// that window waits for the replacement instead of failing the Attempt. Once a
// replacement is claimed, the pool has shown it works, so the next exit is a
// one-off again.
func TestWarmPoolClaimAfterAParkedGuestExitsWaitsForTheReplacement(t *testing.T) {
	pool, factory := parkedExitWindow(t)
	assertWarmStatus(t, pool.Status("linux"), 1, 0, 0, false)

	outcome := claimAsync(t.Context(), pool, "attempt-2")
	assertClaimPending(t, outcome)
	factory.release <- nil
	got := awaitClaim(t, outcome)
	if got.err != nil {
		t.Fatalf("claim after a parked guest exited failed: %v", got.err)
	}
	assertWarmStatus(t, pool.Status("linux"), 1, 0, 1, true)

	if err := got.lease.Cancel(t.Context()); err != nil {
		t.Fatal(err)
	}
	<-factory.booting
	factory.release <- nil
	eventually(t, func() bool { return pool.Status("linux").Parked == 1 })
	factory.slot(2).done <- errors.New("VMM exited")
	<-factory.booting
	outcome = claimAsync(t.Context(), pool, "attempt-3")
	assertClaimPending(t, outcome)
	factory.release <- nil
	if got := awaitClaim(t, outcome); got.err != nil {
		t.Fatalf("claim after a later one-off exit failed: %v", got.err)
	}
}

// A replacement that also exits while parked means the pool keeps failing. A
// claim fails the Attempt, also after the next replacement parks, until
// Configure retries the pool.
func TestWarmPoolClaimAfterAReplacementExitsTooFailsClosed(t *testing.T) {
	pool, factory := parkedExitWindow(t)
	factory.release <- nil
	eventually(t, func() bool { return pool.Status("linux").Parked == 1 })

	factory.slot(1).done <- errors.New("VMM exited again")
	<-factory.booting
	if _, err := pool.Claim(t.Context(), testAttempt()); err == nil || errors.Is(err, errWarmPoolMiss) {
		t.Fatalf("claim after a replacement exited = %v, want a warm pool failure", err)
	}
	factory.release <- nil
	eventually(t, func() bool { return pool.Status("linux").Parked == 1 })
	if _, err := pool.Claim(t.Context(), testAttempt()); err == nil || errors.Is(err, errWarmPoolMiss) {
		t.Fatalf("claim after the next replacement parked = %v, want a warm pool failure", err)
	}
	if status := pool.Status("linux"); status.Healthy {
		t.Fatalf("status = %+v, want an unhealthy pool", status)
	}

	if _, err := pool.Configure(t.Context(), testProfile(1)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Claim(t.Context(), testAttempt()); err != nil {
		t.Fatalf("claim after Configure retried the pool failed: %v", err)
	}
}

// After Shutdown the runtime is stopping and has destroyed every guest it owns.
// A claim fails the Attempt; a miss would make Start cold-boot a guest while
// the runtime stops.
func TestWarmPoolClaimAfterShutdownFails(t *testing.T) {
	pool := newWarmPoolManager(func(context.Context, executor.Profile, uint64) (warmSlot, error) {
		return newFakeWarmSlot(), nil
	})
	if _, err := pool.Configure(t.Context(), testProfile(1)); err != nil {
		t.Fatal(err)
	}
	if err := pool.Shutdown(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Claim(t.Context(), testAttempt()); err == nil || errors.Is(err, errWarmPoolMiss) {
		t.Fatalf("claim after shutdown = %v, want a failure", err)
	}
}
