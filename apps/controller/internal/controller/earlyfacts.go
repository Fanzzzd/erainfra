package controller

import (
	"context"
	"slices"
	"strings"
	"time"

	"github.com/actions/scaleset"

	"github.com/Fanzzzd/erainfra/apps/controller/internal/cachefacts"
	"github.com/Fanzzzd/erainfra/apps/controller/internal/githubapi"
)

// RunRunners lists the runners GitHub has assigned to a workflow run's
// unfinished jobs. *githubapi.Client implements it.
type RunRunners interface {
	RunRunners(ctx context.Context, repository string, runID int64) ([]string, error)
}

// HintSource lists the job hints the cache service holds for runners whose
// names start with one of prefixes. *cachefacts.Client implements it.
type HintSource interface {
	PendingHints(ctx context.Context, prefixes []string) ([]cachefacts.Hint, error)
}

// The poller finds both by type assertion on the Scaler's options, so these
// keep the controller's real clients from silently losing them.
var (
	_ RunRunners = (*githubapi.Client)(nil)
	_ HintSource = (*cachefacts.Client)(nil)
)

// Early facts. GitHub's JobStarted message reaches the controller 7 to 38
// seconds after the job starts on its runner (measured 2026-11-10, with the
// listener's long poll open the whole time), and the scale set gets no
// JobAvailable for a job GitHub hands to an idle runner. So a job's first cache
// request used to wait that long for its facts.
//
// The guest reads its run from the runner's job message the moment the job
// starts and sends it to the cache service as a hint. The controller lists the
// hints of its own runners, asks GitHub whether that runner is assigned to a job
// of that run, and only then publishes the facts. The hint picks which GitHub
// record to read; GitHub's record is what binds the runner to the run.
// JobStarted still publishes the same facts afterwards, as the fallback.
const (
	defaultHintPoll = time.Second
	// hintRetry is how soon a hint GitHub did not confirm is checked again.
	// GitHub can list the job a moment after the runner starts it.
	hintRetry = 5 * time.Second
)

// RunHintPoller polls the cache service for the hints of runners named with
// runnerPrefix until ctx ends. It returns at once when the Scaler has no cache
// publisher that lists hints or no GitHub client that lists a run's runners.
func (s *Scaler) RunHintPoller(ctx context.Context, runnerPrefix string) {
	source, ok := s.cache.(HintSource)
	if !ok || runnerPrefix == "" {
		return
	}
	lister, ok := s.runs.(RunRunners)
	if !ok {
		return
	}
	poll := s.hintPoll
	if poll <= 0 {
		poll = defaultHintPoll
	}
	tried := map[string]time.Time{}
	ticker := time.NewTicker(poll)
	defer ticker.Stop()
	for {
		hints, err := source.PendingHints(ctx, []string{runnerPrefix})
		if err != nil && ctx.Err() == nil {
			s.logger.Debug("could not list job hints", "error", err)
		}
		now := time.Now()
		for _, hint := range hints {
			if last, seen := tried[hint.Runner]; seen && now.Sub(last) < hintRetry {
				continue
			}
			tried[hint.Runner] = now
			s.publishing.Add(1)
			go func() {
				defer s.publishing.Done()
				s.resolveHint(ctx, lister, hint)
			}()
		}
		for runner, last := range tried {
			if now.Sub(last) > 15*time.Minute {
				delete(tried, runner)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (s *Scaler) resolveHint(ctx context.Context, lister RunRunners, hint cachefacts.Hint) {
	owner, name, found := strings.Cut(hint.Repository, "/")
	if !found || owner == "" || name == "" || hint.RunID <= 0 {
		return
	}
	lookup, cancel := context.WithTimeout(ctx, s.cacheScopeBudget)
	runners, err := lister.RunRunners(lookup, hint.Repository, hint.RunID)
	cancel()
	if err != nil {
		s.logger.Debug("could not check a job hint with GitHub; JobStarted will publish the facts",
			"runner", hint.Runner, "repository", hint.Repository, "runID", hint.RunID, "error", err)
		return
	}
	if !slices.Contains(runners, hint.Runner) {
		s.logger.Info("GitHub does not list this runner in the hinted run yet",
			"runner", hint.Runner, "repository", hint.Repository, "runID", hint.RunID)
		return
	}
	s.publishEarlyFacts(ctx, scaleset.JobMessageBase{
		OwnerName: owner, RepositoryName: name, WorkflowRunID: hint.RunID,
	}, hint.Runner)
}

// publishEarlyFacts publishes one runner's facts from its run. Facts it cannot
// establish are left to JobStarted, which publishes cold facts in that case.
func (s *Scaler) publishEarlyFacts(ctx context.Context, message scaleset.JobMessageBase, runner string) {
	started := scaleset.JobStarted{RunnerName: runner, JobMessageBase: message}
	lookup, cancel := context.WithTimeout(ctx, s.cacheScopeBudget)
	run, err := workflowRunOf(lookup, s.runs, &started)
	var facts cachefacts.Facts
	if err == nil {
		facts, err = cacheFactsFromRun(lookup, s.runs, &started, run)
	}
	cancel()
	if err != nil {
		s.logger.Debug("could not establish early cache facts; JobStarted will publish them",
			"runner", runner, "workflowRunID", message.WorkflowRunID, "error", err)
		return
	}
	attempts, err := s.pushCacheFacts(ctx, facts)
	if err != nil {
		s.logger.Warn("could not publish early cache facts; JobStarted will publish them",
			"runner", runner, "attempts", attempts, "error", err)
		return
	}
	s.logger.Info("published cache facts early",
		"runner", facts.Runner, "repository", facts.Repository, "event", facts.Event,
		"ref", facts.Ref, "defaultBranch", facts.DefaultBranch, "attempts", attempts)
}
