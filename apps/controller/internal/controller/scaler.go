// Package controller adapts GitHub's official runner scale-set listener to the
// EraInfra Fleet. GitHub protocol concerns stop at this package.
package controller

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/Fanzzzd/erainfra/apps/controller/internal/fleet"
	"github.com/actions/scaleset"
	"github.com/actions/scaleset/listener"
)

// JITIssuer is the narrow part of the GitHub scale-set client the reconciler
// needs. RemoveRunner compensates a registration that never became an Attempt.
type JITIssuer interface {
	GenerateJIT(ctx context.Context, runnerName string) (JITConfig, error)
	RemoveRunner(ctx context.Context, runnerID int64) error
}

type JITConfig struct {
	RunnerID         int64
	EncodedJITConfig string
}

type Config struct {
	Profile      string
	Executor     string
	ImageRelease string
	VCPUs        int64
	MemoryMiB    int64
	MinRunners   int
	MaxRunners   int
}

func (c Config) validate() error {
	if strings.TrimSpace(c.Profile) == "" {
		return errors.New("profile is required")
	}
	if c.Executor != "docker" && c.Executor != "firecracker" && c.Executor != "tart" && c.Executor != "hyperv" {
		return errors.New("executor must be docker, firecracker, tart, or hyperv")
	}
	if strings.TrimSpace(c.ImageRelease) == "" {
		return errors.New("image release is required")
	}
	if c.VCPUs < 1 || c.MemoryMiB < 512 {
		return errors.New("profile resources require at least 1 vCPU and 512 MiB")
	}
	if c.MinRunners < 0 {
		return errors.New("min runners cannot be negative")
	}
	if c.MaxRunners < 1 {
		return errors.New("max runners must be positive")
	}
	if c.MinRunners > c.MaxRunners {
		return errors.New("min runners cannot exceed max runners")
	}
	return nil
}

// Scaler reconciles desired GitHub capacity against durable Attempts. The
// mutex is not a state store; it only prevents overlapping reconciliations in
// case the listener implementation becomes concurrent in a future release.
type Scaler struct {
	config  Config
	store   fleet.Store
	issuer  JITIssuer
	newName func() (string, error)
	mu      sync.Mutex
}

func NewScaler(
	config Config,
	store fleet.Store,
	issuer JITIssuer,
	newName func() (string, error),
) (*Scaler, error) {
	if err := config.validate(); err != nil {
		return nil, fmt.Errorf("invalid scaler config: %w", err)
	}
	if store == nil {
		return nil, errors.New("fleet store is required")
	}
	if issuer == nil {
		return nil, errors.New("JIT issuer is required")
	}
	if newName == nil {
		return nil, errors.New("runner name generator is required")
	}
	return &Scaler{config: config, store: store, issuer: issuer, newName: newName}, nil
}

func (s *Scaler) HandleDesiredRunnerCount(ctx context.Context, assignedJobs int) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if assignedJobs < 0 {
		return 0, fmt.Errorf("assigned job count cannot be negative: %d", assignedJobs)
	}
	target := min(s.config.MaxRunners, s.config.MinRunners+assignedJobs)
	cleanups, err := s.store.ListRunnerCleanups(ctx, s.config.Profile)
	if err != nil {
		return 0, fmt.Errorf("list runner cleanups: %w", err)
	}
	for _, cleanup := range cleanups {
		if err := s.issuer.RemoveRunner(ctx, cleanup.RunnerID); err != nil {
			return 0, fmt.Errorf("remove abandoned runner %q: %w", cleanup.RunnerName, err)
		}
		if err := s.store.CompleteRunnerCleanup(ctx, s.config.Profile, cleanup); err != nil {
			return 0, fmt.Errorf("complete runner cleanup %q: %w", cleanup.RunnerName, err)
		}
	}
	active, err := s.store.ListActiveAttempts(ctx, s.config.Profile)
	if err != nil {
		return 0, fmt.Errorf("list active attempts: %w", err)
	}

	if len(active) < target {
		for range target - len(active) {
			if err := s.createAttempt(ctx); err != nil {
				return len(active), err
			}
			active = append(active, fleet.Attempt{})
		}
		return len(active), nil
	}

	if len(active) > target {
		cancelable := slices.DeleteFunc(slices.Clone(active), func(attempt fleet.Attempt) bool {
			return attempt.State == fleet.AttemptRunning
		})
		slices.SortFunc(cancelable, func(a, b fleet.Attempt) int {
			return b.CreatedAt.Compare(a.CreatedAt)
		})
		toCancel := min(len(active)-target, len(cancelable))
		for _, attempt := range cancelable[:toCancel] {
			if err := s.store.CancelAttempt(
				ctx,
				s.config.Profile,
				attempt.RunnerName,
				"GitHub reduced the desired runner count",
			); err != nil {
				return len(active), fmt.Errorf("cancel attempt %q: %w", attempt.RunnerName, err)
			}
			if err := s.issuer.RemoveRunner(ctx, attempt.RunnerID); err != nil {
				return len(active) - 1, fmt.Errorf("remove cancelled runner %q: %w", attempt.RunnerName, err)
			}
			if err := s.store.CompleteRunnerCleanup(ctx, s.config.Profile, fleet.RunnerCleanup{
				RunnerName: attempt.RunnerName,
				RunnerID:   attempt.RunnerID,
			}); err != nil {
				return len(active) - 1, fmt.Errorf("complete cancelled runner cleanup %q: %w", attempt.RunnerName, err)
			}
			active = active[:len(active)-1]
		}
	}

	return len(active), nil
}

func (s *Scaler) createAttempt(ctx context.Context) error {
	runnerName, err := s.newName()
	if err != nil {
		return fmt.Errorf("generate runner name: %w", err)
	}
	if strings.TrimSpace(runnerName) == "" {
		return errors.New("runner name generator returned an empty name")
	}

	jit, err := s.issuer.GenerateJIT(ctx, runnerName)
	if err != nil {
		return fmt.Errorf("generate JIT for %q: %w", runnerName, err)
	}
	if jit.RunnerID <= 0 || jit.EncodedJITConfig == "" {
		if jit.RunnerID > 0 {
			_ = s.issuer.RemoveRunner(context.WithoutCancel(ctx), jit.RunnerID)
		}
		return fmt.Errorf("GitHub returned an invalid JIT response for %q", runnerName)
	}

	err = s.store.CreateAttempt(ctx, fleet.NewAttempt{
		Profile:          s.config.Profile,
		Executor:         s.config.Executor,
		ImageRelease:     s.config.ImageRelease,
		VCPUs:            s.config.VCPUs,
		MemoryMiB:        s.config.MemoryMiB,
		RunnerName:       runnerName,
		RunnerID:         jit.RunnerID,
		EncodedJITConfig: jit.EncodedJITConfig,
	})
	if err == nil {
		return nil
	}

	cleanupErr := s.issuer.RemoveRunner(context.WithoutCancel(ctx), jit.RunnerID)
	if cleanupErr != nil {
		return errors.Join(
			fmt.Errorf("create attempt %q: %w", runnerName, err),
			fmt.Errorf("remove orphaned runner %q: %w", runnerName, cleanupErr),
		)
	}
	return fmt.Errorf("create attempt %q: %w", runnerName, err)
}

func (s *Scaler) HandleJobStarted(ctx context.Context, job *scaleset.JobStarted) error {
	if job == nil {
		return errors.New("job started message is nil")
	}
	return s.store.MarkJobStarted(ctx, fleet.JobStarted{
		Profile:          s.config.Profile,
		RunnerName:       job.RunnerName,
		RunnerRequestID:  job.RunnerRequestID,
		Repository:       job.RepositoryName,
		Owner:            job.OwnerName,
		JobID:            job.JobID,
		WorkflowRef:      job.JobWorkflowRef,
		DisplayName:      job.JobDisplayName,
		WorkflowRunID:    job.WorkflowRunID,
		EventName:        job.EventName,
		QueueTime:        job.QueueTime,
		AssignedAt:       job.ScaleSetAssignTime,
		RunnerAssignedAt: job.RunnerAssignTime,
	})
}

func (s *Scaler) HandleJobCompleted(ctx context.Context, job *scaleset.JobCompleted) error {
	if job == nil {
		return errors.New("job completed message is nil")
	}
	finishedAt := job.FinishTime
	if finishedAt.IsZero() {
		finishedAt = time.Now()
	}
	return s.store.MarkJobCompleted(ctx, fleet.JobCompleted{
		Profile:         s.config.Profile,
		RunnerName:      job.RunnerName,
		RunnerRequestID: job.RunnerRequestID,
		JobID:           job.JobID,
		Result:          job.Result,
		FinishedAt:      finishedAt,
	})
}

var _ listener.Scaler = (*Scaler)(nil)
