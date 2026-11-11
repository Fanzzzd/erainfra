//go:build linux

package firecracker

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/executor"
)

type firecrackerWarmSlot struct {
	lease   *machineLease
	done    chan error
	mu      sync.Mutex
	claimed bool
	exited  bool
}

const warmBootTimeout = 15 * time.Minute

func (r *Runtime) newWarmSlot(
	ctx context.Context,
	profile executor.Profile,
	id uint64,
) (warmSlot, error) {
	if _, hasDeadline := ctx.Deadline(); !hasDeadline {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, warmBootTimeout)
		defer cancel()
	}
	vmID := fmt.Sprintf("warm-%d", id)
	effective, err := r.effectiveEgress(profile.Egress)
	if err != nil {
		return nil, fmt.Errorf("egress: %w", err)
	}
	lease, err := r.bootVM(ctx, vmDefinition{
		id:      vmID,
		leaseID: "runner-center/warm/" + vmID,
		profile: profile,
		egress:  effective,
	})
	if err != nil {
		return nil, err
	}
	if err := waitForConsoleMarker(ctx, lease.consolePath, warmReadyMarker); err != nil {
		_ = lease.Cancel(context.WithoutCancel(ctx))
		return nil, err
	}
	slot := &firecrackerWarmSlot{lease: lease, done: make(chan error, 1)}
	go func() {
		err := lease.machine.Wait(context.Background())
		claimed := slot.markExited()
		// An idle VM has no foreground waiter to release its root, network,
		// lease, and work directory. A claimed VM does: leave its console in
		// place so machineLease.Wait can parse an Experiment result before the
		// normal single-use teardown removes it.
		if !claimed {
			err = errors.Join(err, lease.cleanup(context.Background(), false))
		}
		slot.done <- err
		close(slot.done)
	}()
	return slot, nil
}

func (s *firecrackerWarmSlot) Claim(
	ctx context.Context,
	spec executor.Spec,
) (executor.Lease, error) {
	if err := s.reserveClaim(); err != nil {
		return nil, err
	}
	// Before the metadata write, which is what lets the guest start the job.
	if err := s.lease.claimEgress(ctx, spec.AttemptID); err != nil {
		return nil, err
	}
	metadata := metadataFor(spec)
	if err := s.lease.machine.SetMetadata(ctx, metadata); err != nil {
		return nil, err
	}
	// Drop the host-side reference immediately after the one MMDS write.
	metadata["latest"].(map[string]any)["meta-data"].(map[string]any)["runner-center"].(map[string]any)["runner_jit_config"] = ""
	s.lease.resultToken = spec.ResultToken
	return s.lease, nil
}

func (s *firecrackerWarmSlot) reserveClaim() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.exited {
		return errors.New("parked microVM exited before metadata injection")
	}
	if s.claimed {
		return errors.New("parked microVM was already claimed")
	}
	s.claimed = true
	return nil
}

func (s *firecrackerWarmSlot) markExited() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.exited = true
	return s.claimed
}

func (s *firecrackerWarmSlot) Close(ctx context.Context) error { return s.lease.Cancel(ctx) }
func (s *firecrackerWarmSlot) Done() <-chan error              { return s.done }
