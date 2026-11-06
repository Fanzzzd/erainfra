// Package controller adapts GitHub's official runner scale-set listener to the
// EraInfra Fleet. GitHub protocol concerns stop at this package.
package controller

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/Fanzzzd/erainfra/apps/controller/internal/cachefacts"
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

// CachePublisher registers a runner's job facts with the cache service so the
// service can scope that runner's cache to the job's repository. It is optional:
// a controller with no cache configured leaves it nil and simply does not publish.
type CachePublisher interface {
	Push(ctx context.Context, facts cachefacts.Facts) error
}

// Scaler reconciles desired GitHub capacity against durable Attempts. The
// mutex is not a state store; it only prevents overlapping reconciliations in
// case the listener implementation becomes concurrent in a future release.
type Scaler struct {
	config  Config
	store   fleet.Store
	issuer  JITIssuer
	newName func() (string, error)
	cache   CachePublisher
	runs    WorkflowRuns
	logger  *slog.Logger
	mu      sync.Mutex

	// cacheScopeBudget bounds the GitHub lookups behind one job's cache facts,
	// cacheRetry paces a push the cache service could not take, and publishing
	// tracks the pushes still in flight.
	cacheScopeBudget time.Duration
	cacheRetry       retryPolicy
	publishing       sync.WaitGroup
}

// Option configures optional Scaler behaviour without widening the constructor
// for every caller that does not use it.
type Option func(*Scaler)

// WithCachePublisher makes the Scaler publish each job's facts to the cache
// service at JobStarted. The logger records a failed publish; a nil logger keeps
// the Scaler's default.
func WithCachePublisher(cache CachePublisher, logger *slog.Logger) Option {
	return func(s *Scaler) {
		s.cache = cache
		if logger != nil {
			s.logger = logger
		}
	}
}

// WithWorkflowRuns gives the Scaler the GitHub API it derives each job's cache
// scope from. Without it, every job's cache facts are cold: read-only with
// nothing to read.
func WithWorkflowRuns(runs WorkflowRuns) Option {
	return func(s *Scaler) { s.runs = runs }
}

func NewScaler(
	config Config,
	store fleet.Store,
	issuer JITIssuer,
	newName func() (string, error),
	opts ...Option,
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
	scaler := &Scaler{
		config:  config,
		store:   store,
		issuer:  issuer,
		newName: newName,
		logger:  slog.New(slog.NewTextHandler(io.Discard, nil)),

		cacheScopeBudget: defaultCacheScopeBudget,
		cacheRetry:       defaultCachePushRetry,
	}
	for _, opt := range opts {
		opt(scaler)
	}
	return scaler, nil
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
	event := fleet.JobStarted{
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
	}
	// What the workflow run tells (the cache facts, the head branch) is learned
	// off this path: it needs GitHub lookups, and neither MarkJobStarted nor the
	// listener's next message should wait on them. This is best effort: the
	// cache is an optimization and the head branch a label, so a failure there
	// must not fail the job.
	s.learnFromWorkflowRun(ctx, job, event)
	return s.store.MarkJobStarted(ctx, event)
}

// headBranchBudget bounds the second MarkJobStarted, the one that carries the
// run's head branch.
const headBranchBudget = 30 * time.Second

// learnFromWorkflowRun reads the job's workflow run from GitHub in the
// background, once, and from it
//
//   - publishes the job's cache facts: which repository and refs this runner's
//     job may use. The GitHub lookups are bounded by cacheScopeBudget; if they
//     fail or run out of time the job gets cold facts, read-only with nothing to
//     read, which is never broader than the real scope. A push failure is logged,
//     not returned: the worst case is a cold cache.
//   - sends JobStarted again with the run's head branch, which the control plane
//     keys test results by. The job's workflow ref cannot stand in for it: for a
//     job of a called workflow it names the called file's ref. The control plane
//     keeps every field it already has, so this send and the first may land in
//     either order.
//
// This is the only time the controller sends a job's facts, so a push the
// service could not take (it was restarting, or could not write them to its
// store) is retried with backoff for cacheRetry.window rather than dropped: a
// dropped push leaves that job's every cache request refused until it ends.
func (s *Scaler) learnFromWorkflowRun(ctx context.Context, job *scaleset.JobStarted, event fleet.JobStarted) {
	if s.cache == nil && s.runs == nil {
		return
	}
	started := *job
	base := context.WithoutCancel(ctx)
	s.publishing.Add(1)
	go func() {
		defer s.publishing.Done()
		lookupCtx, cancelLookup := context.WithTimeout(base, s.cacheScopeBudget)
		run, runErr := workflowRunOf(lookupCtx, s.runs, &started)
		var facts cachefacts.Facts
		var factsErr error
		if s.cache != nil {
			factsErr = runErr
			if runErr == nil {
				facts, factsErr = cacheFactsFromRun(lookupCtx, s.runs, &started, run)
			}
		}
		cancelLookup()

		if runErr == nil {
			if branch := runHeadBranch(run); branch != "" {
				s.publishing.Add(1)
				go func() {
					defer s.publishing.Done()
					s.recordHeadBranch(base, event, branch)
				}()
			}
		} else if s.cache == nil {
			s.logger.Warn("could not read the job's workflow run; its test results are joined by workflow run only",
				"runner", started.RunnerName, "workflowRunID", started.WorkflowRunID, "error", runErr)
		}

		if s.cache == nil {
			return
		}
		if factsErr != nil {
			s.logger.Warn("could not establish the job's cache scope; publishing read-only facts",
				"runner", started.RunnerName, "workflowRunID", started.WorkflowRunID, "error", factsErr)
			facts = coldCacheFacts(&started)
		}
		attempts, err := s.pushCacheFacts(base, facts)
		if err != nil {
			s.logger.Error("could not publish cache facts; the job's cache requests will be refused",
				"runner", started.RunnerName, "attempts", attempts, "error", err)
			return
		}
		s.logger.Info("published cache facts",
			"runner", facts.Runner, "repository", facts.Repository, "event", facts.Event,
			"ref", facts.Ref, "baseRef", facts.BaseRef, "defaultBranch", facts.DefaultBranch,
			"headRepository", facts.HeadRepository, "attempts", attempts)
	}()
}

// recordHeadBranch sends JobStarted again with the run's head branch. A failure
// costs only the branch: the Attempt's test results are then joined by their
// workflow run alone, so it is logged and not retried.
func (s *Scaler) recordHeadBranch(ctx context.Context, event fleet.JobStarted, branch string) {
	ctx, cancel := context.WithTimeout(ctx, headBranchBudget)
	defer cancel()
	event.HeadBranch = branch
	if err := s.store.MarkJobStarted(ctx, event); err != nil {
		s.logger.Warn("could not record the job's head branch; its test results are joined by workflow run only",
			"runner", event.RunnerName, "workflowRunID", event.WorkflowRunID, "error", err)
	}
}

// retryPolicy is how a failed facts push is paced: the first retry after first,
// doubling to at most ceiling, until window has passed since the first attempt.
type retryPolicy struct {
	first   time.Duration
	ceiling time.Duration
	window  time.Duration
}

// defaultCachePushRetry outlasts a cache-service deploy or a host reboot, which
// is what a retryable failure almost always is, and gives up well inside the
// facts' own six-hour lifetime. A job's first cache step is usually a minute or
// more in, so facts that land within the window are rarely late at all.
var defaultCachePushRetry = retryPolicy{first: time.Second, ceiling: 30 * time.Second, window: 15 * time.Minute}

// pushCacheFacts sends facts until the service takes them, the failure is one
// sending again cannot fix, or the retry window closes. It returns how many
// attempts it made.
func (s *Scaler) pushCacheFacts(ctx context.Context, facts cachefacts.Facts) (int, error) {
	deadline := time.Now().Add(s.cacheRetry.window)
	delay := s.cacheRetry.first
	for attempt := 1; ; attempt++ {
		pushCtx, cancel := context.WithTimeout(ctx, cachePushBudget)
		err := s.cache.Push(pushCtx, facts)
		cancel()
		if err == nil {
			return attempt, nil
		}
		if !cachefacts.Retryable(err) || !time.Now().Add(delay).Before(deadline) {
			return attempt, err
		}
		if attempt == 1 {
			s.logger.Warn("cache facts push failed; retrying",
				"runner", facts.Runner, "error", err, "retryFor", s.cacheRetry.window)
		}
		select {
		case <-ctx.Done():
			return attempt, ctx.Err()
		case <-time.After(delay):
		}
		delay = min(delay*2, s.cacheRetry.ceiling)
	}
}

// repositorySlug joins an owner and repository into the "owner/repo" the cache
// service scopes against; the scale-set message carries the two halves apart.
func repositorySlug(owner, repository string) string {
	owner = strings.TrimSpace(owner)
	repository = strings.TrimSpace(repository)
	if owner == "" || repository == "" {
		return ""
	}
	return owner + "/" + repository
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
