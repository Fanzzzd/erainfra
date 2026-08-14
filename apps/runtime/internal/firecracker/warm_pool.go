package firecracker

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/executor"
)

var errWarmPoolMiss = errors.New("no parked microVM is available")

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
	ctx         context.Context
	cancel      context.CancelFunc
}

func newWarmPoolManager(factory warmSlotFactory) *warmPoolManager {
	ctx, cancel := context.WithCancel(context.Background())
	return &warmPoolManager{
		profiles: make(map[string]*warmPoolState), factory: factory, ctx: ctx, cancel: cancel,
	}
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
		return executor.WarmPoolStatus{}, errors.New("warm pool is shutting down")
	}
	state := p.profiles[profile.Name]
	var obsolete []warmSlot
	if state == nil {
		state = &warmPoolState{
			profile:  profile,
			idle:     make(map[uint64]warmSlot),
			claimed:  make(map[uint64]warmSlot),
			attempts: make(map[uint64]string),
		}
		p.profiles[profile.Name] = state
	} else if !sameWarmProfile(state.profile, profile) {
		if len(state.claimed) > 0 {
			state.lastErr = errors.New("profile changed while a warm microVM is claimed")
			status := statusOf(state)
			p.mu.Unlock()
			return status, state.lastErr
		}
		for _, slot := range state.idle {
			obsolete = append(obsolete, slot)
		}
		state.idle = make(map[uint64]warmSlot)
		state.profile = profile
	}
	state.profile.WarmPool = profile.WarmPool
	state.lastErr = nil
	p.mu.Unlock()
	for _, slot := range obsolete {
		if err := slot.Close(context.WithoutCancel(ctx)); err != nil {
			return p.Status(profile.Name), fmt.Errorf("replace stale parked microVM: %w", err)
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
		left.MemoryMiB == right.MemoryMiB
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
			state.lastErr = nil
			p.mu.Unlock()
			return nil
		}
		if owned > target {
			var id uint64
			var slot warmSlot
			for id, slot = range state.idle {
				break
			}
			if slot == nil {
				state.lastErr = fmt.Errorf(
					"%d claimed microVMs exceed the reduced warm pool target %d",
					len(state.claimed), target,
				)
				err := state.lastErr
				p.mu.Unlock()
				return err
			}
			delete(state.idle, id)
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
		state.lastErr = nil
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
	state.lastErr = err
	p.mu.Unlock()
	go func() { _ = p.reconcile(context.Background(), profileName) }()
}

func (p *warmPoolManager) Claim(
	ctx context.Context,
	spec executor.Spec,
) (executor.Lease, error) {
	p.mu.Lock()
	state := p.profiles[spec.Profile]
	if state == nil || state.profile.WarmPool == 0 {
		p.mu.Unlock()
		return nil, errWarmPoolMiss
	}
	if state.lastErr != nil || len(state.idle)+len(state.claimed) != state.profile.WarmPool {
		status := statusOf(state)
		p.mu.Unlock()
		return nil, fmt.Errorf("warm pool is unhealthy: %s", status.Detail)
	}
	if !sameSpecProfile(spec, state.profile) {
		p.mu.Unlock()
		return nil, errors.New("Attempt does not match its prepared warm pool contract")
	}
	var id uint64
	var slot warmSlot
	for id, slot = range state.idle {
		break
	}
	if slot == nil {
		p.mu.Unlock()
		return nil, errWarmPoolMiss
	}
	delete(state.idle, id)
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
		spec.VCPUs == profile.VCPUs && spec.MemoryMiB == profile.MemoryMiB
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
	if len(state.claimed) == 0 {
		delete(p.profiles, profileName)
	}
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
	p.reconcileMu.Unlock()
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

func (l *warmPoolLease) Cancel(ctx context.Context) error {
	err := l.Lease.Cancel(ctx)
	l.releaseOnce.Do(l.release)
	return err
}
