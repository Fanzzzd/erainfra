package firecracker

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"sync"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/executor"
	"github.com/Fanzzzd/erainfra/apps/runtime/internal/jobmetrics"
	"github.com/Fanzzzd/erainfra/apps/runtime/internal/netpolicy"
)

var (
	errWarmPoolMiss     = errors.New("no parked microVM is available")
	errWarmPoolShutdown = errors.New("warm pool is shutting down")
	// errParkedExitRepeated marks a pool whose replacement for an exited parked
	// guest exited too. Booting one more guest does not show the pool works, so
	// only Configure clears it.
	errParkedExitRepeated = errors.New("the replacement for an exited parked microVM exited too")
)

type warmSlot interface {
	Claim(context.Context, executor.Spec) (executor.Lease, error)
	Close(context.Context) error
	Done() <-chan error
}

type warmSlotFactory func(context.Context, executor.Profile, uint64) (warmSlot, error)

type warmPoolState struct {
	profile  executor.Profile
	idle     map[uint64]warmSlot
	claimed  map[uint64]warmSlot
	attempts map[uint64]string
	lastErr  error
	// exitsToReplace counts parked guests that exited and have no replacement
	// yet. replacesExit holds the parked replacements for those guests until one
	// is claimed. A replacement that exits before its claim means the pool keeps
	// failing, not a one-off exit.
	exitsToReplace int
	replacesExit   map[uint64]struct{}
}

func newWarmPoolState(profile executor.Profile) *warmPoolState {
	return &warmPoolState{
		profile:      profile,
		idle:         make(map[uint64]warmSlot),
		claimed:      make(map[uint64]warmSlot),
		attempts:     make(map[uint64]string),
		replacesExit: make(map[uint64]struct{}),
	}
}

// forgetExits drops the record of exited parked guests, for a pool whose parked
// guests were all destroyed on purpose.
func (s *warmPoolState) forgetExits() {
	s.exitsToReplace = 0
	s.replacesExit = make(map[uint64]struct{})
}

// booted clears a failure that a successfully booted guest repairs. A
// replacement that exited too stays recorded until Configure.
func (s *warmPoolState) booted() {
	if !errors.Is(s.lastErr, errParkedExitRepeated) {
		s.lastErr = nil
	}
}

// warmPoolManager owns resident VMs independently of the agent process. Its
// target is total pool-owned capacity (parked + claimed), which prevents a
// claim from transiently exceeding the host's configured capacity.
type warmPoolManager struct {
	mu          sync.Mutex
	reconcileMu sync.Mutex
	profiles    map[string]*warmPoolState
	factory     warmSlotFactory
	nextID      uint64
	closed      bool
	// changed is closed and replaced whenever a Profile's pool gains a parked
	// guest, records a failure or changes its target, which wakes the claims
	// waiting for a replacement.
	changed chan struct{}
	ctx     context.Context
	cancel  context.CancelFunc
}

func newWarmPoolManager(factory warmSlotFactory) *warmPoolManager {
	ctx, cancel := context.WithCancel(context.Background())
	return &warmPoolManager{
		profiles: make(map[string]*warmPoolState), factory: factory, ctx: ctx, cancel: cancel,
		changed: make(chan struct{}),
	}
}

// changedLocked wakes every waiting claim so it rereads the pool. The caller
// holds p.mu.
func (p *warmPoolManager) changedLocked() {
	close(p.changed)
	p.changed = make(chan struct{})
}

func (p *warmPoolManager) Configure(
	ctx context.Context,
	profile executor.Profile,
) (executor.WarmPoolStatus, error) {
	if err := profile.Validate(); err != nil {
		return executor.WarmPoolStatus{}, err
	}
	if profile.WarmPool == 0 {
		return executor.WarmPoolStatus{}, p.Remove(ctx, profile.Name)
	}

	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return executor.WarmPoolStatus{}, errWarmPoolShutdown
	}
	state := p.profiles[profile.Name]
	var obsolete []warmSlot
	if state == nil {
		state = newWarmPoolState(profile)
		p.profiles[profile.Name] = state
	} else if !sameWarmProfile(state.profile, profile) {
		if len(state.claimed) > 0 {
			state.lastErr = errors.New("profile changed while a warm microVM is claimed")
			p.changedLocked()
			status := statusOf(state)
			p.mu.Unlock()
			return status, state.lastErr
		}
		for _, slot := range state.idle {
			obsolete = append(obsolete, slot)
		}
		state.idle = make(map[uint64]warmSlot)
		state.forgetExits()
		state.profile = profile
	}
	state.profile.WarmPool = profile.WarmPool
	state.lastErr = nil
	p.changedLocked()
	p.mu.Unlock()
	for _, slot := range obsolete {
		if err := slot.Close(context.WithoutCancel(ctx)); err != nil {
			err = fmt.Errorf("replace stale parked microVM: %w", err)
			p.mu.Lock()
			if current := p.profiles[profile.Name]; current != nil {
				current.lastErr = err
			}
			p.changedLocked()
			p.mu.Unlock()
			return p.Status(profile.Name), err
		}
	}

	if err := p.reconcile(ctx, profile.Name); err != nil {
		return p.Status(profile.Name), err
	}
	return p.Status(profile.Name), nil
}

func sameWarmProfile(left, right executor.Profile) bool {
	return left.Name == right.Name &&
		left.ImageRelease == right.ImageRelease &&
		left.VCPUs == right.VCPUs &&
		left.MemoryMiB == right.MemoryMiB &&
		sameEgress(left.Egress, right.Egress)
}

// sameEgress compares two egress policies in canonical form. A parked guest is
// already in its Profile's per-guest sets, so one booted under another policy
// is not the same capacity.
func sameEgress(left, right netpolicy.ProfileEgress) bool {
	left, right = left.Normalized(), right.Normalized()
	return left.Mode == right.Mode &&
		slices.Equal(left.Presets, right.Presets) &&
		slices.Equal(left.Domains, right.Domains) &&
		slices.Equal(left.CIDRs, right.CIDRs)
}

func (p *warmPoolManager) reconcile(ctx context.Context, profileName string) error {
	p.reconcileMu.Lock()
	defer p.reconcileMu.Unlock()

	for {
		p.mu.Lock()
		state := p.profiles[profileName]
		if state == nil || p.closed {
			p.mu.Unlock()
			return nil
		}
		owned := len(state.idle) + len(state.claimed)
		target := state.profile.WarmPool
		if owned == target {
			state.booted()
			p.mu.Unlock()
			return nil
		}
		if owned > target {
			var id uint64
			var slot warmSlot
			for id, slot = range state.idle {
				break
			}
			// Every guest is claimed: a target lowered below the claimed count.
			// That is a planned drain. Each release reconciles again and shrinks
			// the pool toward the target, and meanwhile a claim is a miss.
			if slot == nil {
				p.mu.Unlock()
				return nil
			}
			delete(state.idle, id)
			delete(state.replacesExit, id)
			p.mu.Unlock()
			if err := slot.Close(ctx); err != nil {
				return fmt.Errorf("drain parked microVM: %w", err)
			}
			continue
		}

		profile := state.profile
		p.nextID++
		id := p.nextID
		p.mu.Unlock()

		factoryContext, cancelFactory := context.WithCancel(ctx)
		stopShutdownCancel := context.AfterFunc(p.ctx, cancelFactory)
		slot, err := p.factory(factoryContext, profile, id)
		stopShutdownCancel()
		cancelFactory()
		if err != nil {
			p.mu.Lock()
			if current := p.profiles[profileName]; current != nil {
				current.lastErr = fmt.Errorf("create parked microVM: %w", err)
			}
			p.changedLocked()
			p.mu.Unlock()
			return fmt.Errorf("create parked microVM: %w", err)
		}

		p.mu.Lock()
		state = p.profiles[profileName]
		if state == nil || p.closed || !sameWarmProfile(state.profile, profile) ||
			len(state.idle)+len(state.claimed) >= state.profile.WarmPool {
			p.mu.Unlock()
			_ = slot.Close(context.WithoutCancel(ctx))
			continue
		}
		state.idle[id] = slot
		if state.exitsToReplace > 0 {
			state.exitsToReplace--
			state.replacesExit[id] = struct{}{}
		}
		state.booted()
		p.changedLocked()
		p.mu.Unlock()
		go p.watchIdle(profileName, id, slot)
	}
}

func (p *warmPoolManager) watchIdle(profileName string, id uint64, slot warmSlot) {
	err, ok := <-slot.Done()
	if !ok {
		err = errors.New("parked microVM exited")
	}
	p.mu.Lock()
	state := p.profiles[profileName]
	if state == nil || state.idle[id] != slot {
		p.mu.Unlock()
		return
	}
	delete(state.idle, id)
	if err == nil {
		err = errors.New("parked microVM exited")
	}
	// A parked guest that exits once is replaced like a torn-down one, and
	// claims wait for the replacement. If that replacement exits too before
	// any claim, the pool keeps failing and claims fail the Attempt.
	_, repeated := state.replacesExit[id]
	delete(state.replacesExit, id)
	if len(state.idle)+len(state.claimed) < state.profile.WarmPool {
		state.exitsToReplace++
	}
	if repeated {
		state.lastErr = fmt.Errorf("%w: %w", errParkedExitRepeated, err)
	} else {
		slog.Warn("a parked microVM exited; booting its replacement",
			"profile", profileName, "error", err)
	}
	p.changedLocked()
	p.mu.Unlock()
	go func() { _ = p.reconcile(context.Background(), profileName) }()
}

// Claim hands the Attempt a parked guest of its Profile. The error tells Start
// what to do next:
//
//   - errWarmPoolMiss: the Profile has no pool, or every guest the pool owns is
//     already claimed. That is demand above the target, and Start cold-boots.
//   - any other error: the pool is broken (a guest failed to boot, or the
//     replacement for an exited parked guest exited too), the runtime is
//     shutting down, or the Attempt does not match the pool. The Attempt fails,
//     so a broken pool is not hidden behind cold boots.
//
// While the pool boots the replacement for a torn-down guest or for a parked
// guest that exited once, it owns fewer guests than its target. A claim within
// the target then waits for that replacement instead of failing or
// cold-booting: the slot is the pool's, and a cold boot beside the replacement
// would put one guest more on the host than placement reserved. ctx, the
// Attempt's boot deadline, bounds the wait.
func (p *warmPoolManager) Claim(
	ctx context.Context,
	spec executor.Spec,
) (executor.Lease, error) {
	p.mu.Lock()
	var state *warmPoolState
	var id uint64
	var slot warmSlot
	for {
		// Shutdown destroyed every pool guest; a cold boot now would start a
		// guest while the runtime stops.
		if p.closed {
			p.mu.Unlock()
			return nil, errWarmPoolShutdown
		}
		state = p.profiles[spec.Profile]
		if state == nil || state.profile.WarmPool == 0 {
			p.mu.Unlock()
			return nil, errWarmPoolMiss
		}
		if state.lastErr != nil {
			status := statusOf(state)
			p.mu.Unlock()
			return nil, fmt.Errorf("warm pool is unhealthy: %s", status.Detail)
		}
		if !sameSpecProfile(spec, state.profile) {
			p.mu.Unlock()
			return nil, errors.New("Attempt does not match its prepared warm pool contract") //nolint:staticcheck // ST1005: Attempt is a CONTEXT.md domain term
		}
		if len(state.claimed) >= state.profile.WarmPool {
			p.mu.Unlock()
			return nil, errWarmPoolMiss
		}
		for id, slot = range state.idle {
			break
		}
		if slot != nil {
			break
		}
		changed := p.changed
		p.mu.Unlock()
		select {
		case <-changed:
		case <-ctx.Done():
			return nil, fmt.Errorf("wait for the warm pool to replace a torn-down microVM: %w", ctx.Err())
		case <-p.ctx.Done():
			return nil, errWarmPoolShutdown
		}
		p.mu.Lock()
	}
	delete(state.idle, id)
	delete(state.replacesExit, id)
	state.claimed[id] = slot
	state.attempts[id] = spec.AttemptID
	p.mu.Unlock()

	lease, err := slot.Claim(ctx, spec)
	if err != nil {
		if closeErr := slot.Close(context.WithoutCancel(ctx)); closeErr != nil {
			p.mu.Lock()
			if state := p.profiles[spec.Profile]; state != nil {
				state.lastErr = errors.Join(err, closeErr)
			}
			p.changedLocked()
			p.mu.Unlock()
			return nil, fmt.Errorf(
				"inject single-use metadata and destroy failed parked microVM: %w",
				errors.Join(err, closeErr),
			)
		}
		p.release(spec.Profile, id, slot)
		return nil, fmt.Errorf("inject single-use metadata into parked microVM: %w", err)
	}
	return &warmPoolLease{
		Lease: lease,
		release: func() {
			p.release(spec.Profile, id, slot)
		},
	}, nil
}

func sameSpecProfile(spec executor.Spec, profile executor.Profile) bool {
	return spec.Profile == profile.Name && spec.ImageRelease == profile.ImageRelease &&
		spec.VCPUs == profile.VCPUs && spec.MemoryMiB == profile.MemoryMiB &&
		sameEgress(spec.Egress, profile.Egress)
}

func (p *warmPoolManager) release(profileName string, id uint64, slot warmSlot) {
	p.mu.Lock()
	state := p.profiles[profileName]
	if state != nil && state.claimed[id] == slot {
		delete(state.claimed, id)
		delete(state.attempts, id)
	}
	if state != nil && state.profile.WarmPool == 0 && len(state.idle) == 0 && len(state.claimed) == 0 {
		delete(p.profiles, profileName)
	}
	p.mu.Unlock()
	go func() { _ = p.reconcile(context.Background(), profileName) }()
}

func (p *warmPoolManager) RecoverOrphans(ctx context.Context, liveAttemptIDs []string) error {
	live := make(map[string]struct{}, len(liveAttemptIDs))
	for _, attemptID := range liveAttemptIDs {
		live[attemptID] = struct{}{}
	}
	type orphan struct {
		profile string
		id      uint64
		slot    warmSlot
	}
	var orphans []orphan
	p.mu.Lock()
	for profileName, state := range p.profiles {
		for id, attemptID := range state.attempts {
			if _, ok := live[attemptID]; ok {
				continue
			}
			orphans = append(orphans, orphan{profile: profileName, id: id, slot: state.claimed[id]})
		}
	}
	p.mu.Unlock()
	var cleanupErrors []error
	for _, orphan := range orphans {
		if err := orphan.slot.Close(ctx); err != nil {
			cleanupErrors = append(cleanupErrors, err)
			continue
		}
		p.release(orphan.profile, orphan.id, orphan.slot)
	}
	return errors.Join(cleanupErrors...)
}

func (p *warmPoolManager) Status(profileName string) executor.WarmPoolStatus {
	p.mu.Lock()
	defer p.mu.Unlock()
	state := p.profiles[profileName]
	if state == nil {
		return executor.WarmPoolStatus{Healthy: true}
	}
	return statusOf(state)
}

// imageReleases lists the Image Release of every Profile the pool manages.
func (p *warmPoolManager) imageReleases() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	releases := make([]string, 0, len(p.profiles))
	for _, state := range p.profiles {
		releases = append(releases, state.profile.ImageRelease)
	}
	return releases
}

func (p *warmPoolManager) totalTargetWith(profile executor.Profile) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	total := profile.WarmPool
	for name, state := range p.profiles {
		if name != profile.Name {
			total += state.profile.WarmPool
		}
	}
	return total
}

func statusOf(state *warmPoolState) executor.WarmPoolStatus {
	status := executor.WarmPoolStatus{
		Target:  state.profile.WarmPool,
		Parked:  len(state.idle),
		Claimed: len(state.claimed),
	}
	status.Healthy = status.Parked+status.Claimed == status.Target && state.lastErr == nil
	if state.lastErr != nil {
		status.Detail = state.lastErr.Error()
	} else if !status.Healthy {
		status.Detail = fmt.Sprintf(
			"warm pool owns %d of %d microVMs", status.Parked+status.Claimed, status.Target,
		)
	}
	return status
}

func (p *warmPoolManager) Remove(ctx context.Context, profileName string) error {
	p.mu.Lock()
	state := p.profiles[profileName]
	if state == nil {
		p.mu.Unlock()
		return nil
	}
	state.profile.WarmPool = 0
	slots := make([]warmSlot, 0, len(state.idle))
	for _, slot := range state.idle {
		slots = append(slots, slot)
	}
	state.idle = make(map[uint64]warmSlot)
	state.forgetExits()
	if len(state.claimed) == 0 {
		delete(p.profiles, profileName)
	}
	p.changedLocked()
	p.mu.Unlock()
	var cleanupErrors []error
	for _, slot := range slots {
		if err := slot.Close(ctx); err != nil {
			cleanupErrors = append(cleanupErrors, err)
		}
	}
	return errors.Join(cleanupErrors...)
}

func (p *warmPoolManager) Shutdown(ctx context.Context) error {
	p.cancel()
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return nil
	}
	p.closed = true
	var slots []warmSlot
	for _, state := range p.profiles {
		for _, slot := range state.idle {
			slots = append(slots, slot)
		}
		for _, slot := range state.claimed {
			slots = append(slots, slot)
		}
	}
	p.profiles = make(map[string]*warmPoolState)
	p.mu.Unlock()
	// A factory may have been between reserving an ID and publishing its slot.
	// Cancellation makes it unwind; waiting here prevents a late VM from
	// appearing after shutdown has already returned.
	p.reconcileMu.Lock()
	p.reconcileMu.Unlock() //nolint:staticcheck // SA2001: an empty critical section is the point; it waits out an in-flight reconcile
	var cleanupErrors []error
	for _, slot := range slots {
		if err := slot.Close(ctx); err != nil {
			cleanupErrors = append(cleanupErrors, err)
		}
	}
	return errors.Join(cleanupErrors...)
}

type warmPoolLease struct {
	executor.Lease
	releaseOnce sync.Once
	release     func()
}

func (l *warmPoolLease) Wait(ctx context.Context) (executor.Result, error) {
	result, err := l.Lease.Wait(ctx)
	if ctx.Err() == nil {
		l.releaseOnce.Do(l.release)
	}
	return result, err
}

// ResourceSource passes through to the claimed VM: a warm VM is measured the
// same way as a cold-booted one, from its claim onward.
func (l *warmPoolLease) ResourceSource() (jobmetrics.Source, error) {
	measurable, ok := l.Lease.(executor.Measurable)
	if !ok {
		return nil, errors.New("the claimed microVM cannot be measured")
	}
	return measurable.ResourceSource()
}

func (l *warmPoolLease) Cancel(ctx context.Context) error {
	err := l.Lease.Cancel(ctx)
	l.releaseOnce.Do(l.release)
	return err
}

// EgressRecord forwards to the claimed guest's lease, so a cancelled warm
// Attempt reports its record like a cold one.
func (l *warmPoolLease) EgressRecord() *executor.EgressRecord {
	if recorded, ok := l.Lease.(interface{ EgressRecord() *executor.EgressRecord }); ok {
		return recorded.EgressRecord()
	}
	return nil
}
