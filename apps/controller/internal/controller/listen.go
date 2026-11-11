package controller

import (
	"context"
	"fmt"
	"io"
	"log/slog"

	"github.com/actions/scaleset"
	"github.com/actions/scaleset/listener"

	"github.com/Fanzzzd/erainfra/apps/controller/internal/fleet"
)

// JobAcquirer is the part of a message session that claims jobs for the scale
// set. *scaleset.MessageSessionClient implements it.
type JobAcquirer interface {
	AcquireJobs(ctx context.Context, requestIDs []int64) ([]int64, error)
}

// ForSession returns the listener.Scaler for one message session. The listener
// acks a message only after Scale returns nil, so a failed message comes back
// on the next poll: acquiring a job twice is a no-op at GitHub, MarkJobStarted
// is sent twice by design, and a repeated MarkJobCompleted finds the Attempt
// already finished. The logger records each acquisition; nil discards it.
func (s *Scaler) ForSession(session JobAcquirer, logger *slog.Logger) listener.Scaler {
	if logger == nil {
		logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	return &sessionScaler{scaler: s, session: session, logger: logger}
}

// sessionScaler routes one session's messages to the Scaler in the order the
// scale-set listener used before it handed the whole message over: acquire the
// jobs on offer, record each JobStarted, then each JobCompleted, then converge
// on the assigned-job count. Scale is never called concurrently, so the cached
// statistics need no lock.
type sessionScaler struct {
	scaler     *Scaler
	session    JobAcquirer
	logger     *slog.Logger
	statistics *scaleset.RunnerScaleSetStatistic
}

var _ listener.Scaler = (*sessionScaler)(nil)

func (s *sessionScaler) Scale(ctx context.Context, message *scaleset.RunnerScaleSetMessage) error {
	if message == nil {
		// The long poll ended with nothing new. Converging again on the last
		// statistics is what retires idle Attempts and replaces lost ones
		// while no message arrives.
		return s.converge(ctx)
	}
	if message.Statistics != nil {
		s.statistics = message.Statistics
	}
	if message.MessageID == listener.InitialMessageID {
		return s.converge(ctx)
	}

	// A message is handled to the end once it is taken, even if the
	// controller is stopping: its jobs were already offered to this scale set.
	ctx = context.WithoutCancel(ctx)
	if len(message.JobAvailableMessages) > 0 {
		ids := make([]int64, 0, len(message.JobAvailableMessages))
		for _, job := range message.JobAvailableMessages {
			ids = append(ids, job.RunnerRequestID)
		}
		s.logger.Info("acquiring jobs", "count", len(ids))
		acquired, err := s.session.AcquireJobs(ctx, ids)
		if err != nil {
			return fmt.Errorf("acquire jobs: %w", err)
		}
		s.logger.Info("jobs acquired", "count", len(acquired))
		s.scaler.recordAcquired(ctx, message.JobAvailableMessages, acquired, s.logger)
	}
	for _, job := range message.JobStartedMessages {
		if err := s.scaler.HandleJobStarted(ctx, job); err != nil {
			return fmt.Errorf("handle job started: %w", err)
		}
	}
	for _, job := range message.JobCompletedMessages {
		if err := s.scaler.HandleJobCompleted(ctx, job); err != nil {
			return fmt.Errorf("handle job completed: %w", err)
		}
	}
	return s.converge(ctx)
}

func (s *sessionScaler) converge(ctx context.Context) error {
	if s.statistics == nil {
		return nil
	}
	if _, err := s.scaler.HandleDesiredRunnerCount(ctx, s.statistics.TotalAssignedJobs); err != nil {
		return fmt.Errorf("handle desired runner count: %w", err)
	}
	return nil
}

// recordAcquired tells the control plane which jobs the scale set acquired, so
// it can find a job's workflow run if every Worker for the Profile drops before
// a Runner takes it. Best effort: a failure is logged and the message goes on.
func (s *Scaler) recordAcquired(
	ctx context.Context,
	offered []*scaleset.JobAvailable,
	acquired []int64,
	logger *slog.Logger,
) {
	recorder, ok := s.store.(fleet.JobAcquisitionRecorder)
	if !ok || len(acquired) == 0 {
		return
	}
	jobs := acquiredJobs(offered, acquired)
	if len(jobs) == 0 {
		return
	}
	if err := recorder.RecordJobsAcquired(ctx, s.config.Profile, jobs); err != nil {
		logger.Warn("record acquired jobs", "count", len(jobs), "error", err)
	}
}

// acquiredJobs returns the offered jobs GitHub confirmed as acquired.
func acquiredJobs(offered []*scaleset.JobAvailable, acquired []int64) []fleet.AcquiredJob {
	confirmed := make(map[int64]bool, len(acquired))
	for _, id := range acquired {
		confirmed[id] = true
	}
	jobs := make([]fleet.AcquiredJob, 0, len(acquired))
	for _, job := range offered {
		if job == nil || !confirmed[job.RunnerRequestID] {
			continue
		}
		jobs = append(jobs, fleet.AcquiredJob{
			RunnerRequestID: job.RunnerRequestID,
			Repository:      job.RepositoryName,
			Owner:           job.OwnerName,
			JobID:           job.JobID,
			DisplayName:     job.JobDisplayName,
			WorkflowRunID:   job.WorkflowRunID,
			QueueTime:       job.QueueTime,
		})
	}
	return jobs
}
