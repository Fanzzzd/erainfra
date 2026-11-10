package controller

import (
	"context"
	"strconv"
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

// The watch finds the lister by a type assertion on the WorkflowRuns option, so
// this keeps the controller's real client from silently losing it.
var _ RunRunners = (*githubapi.Client)(nil)

// Early facts. The scale set's JobStarted message reaches the controller late:
// on 2026-11-10 it arrived 7 to 38 seconds after the job had started on its
// runner, with the listener's long poll open the whole time. A job's first cache
// request waited that long for its facts.
//
// GitHub names a job's runner in the run's job list the moment it assigns the
// job. A job's facts depend only on its workflow run and its runner's name, so
// once one of this fleet's runners appears in the list of a run the controller
// acquired a job from, its facts are known. The runner is bound to the run by
// GitHub's own record, so nothing the guest says is trusted. JobStarted still
// publishes the same facts afterwards, as the fallback.
const (
	defaultEarlyFactsPoll   = 2 * time.Second
	defaultEarlyFactsWindow = 3 * time.Minute
	// fleetRunnerPrefix starts every runner name githubscale.RunnerName makes.
	// It keeps GitHub-hosted runners in the same run out of the cache service.
	fleetRunnerPrefix = "rc-"
)

// runWatch is one run being watched: how many acquired jobs still wait for a
// runner, and which runners were already published.
type runWatch struct {
	pending   int
	published map[string]bool
}

// WatchAcquiredJobs starts publishing early facts for jobs the session just
// acquired. It returns at once; the watches run in the background and are
// counted in s.publishing.
func (s *Scaler) WatchAcquiredJobs(ctx context.Context, jobs []*scaleset.JobAvailable) {
	if s.cache == nil {
		return
	}
	lister, ok := s.runs.(RunRunners)
	if !ok {
		return
	}
	base := context.WithoutCancel(ctx)
	for _, job := range jobs {
		if job == nil || job.WorkflowRunID <= 0 {
			continue
		}
		repository := repositorySlug(job.OwnerName, job.RepositoryName)
		if repository == "" {
			continue
		}
		key := strings.ToLower(repository) + "#" + strconv.FormatInt(job.WorkflowRunID, 10)
		s.mu.Lock()
		if s.watches == nil {
			s.watches = map[string]*runWatch{}
		}
		watch, running := s.watches[key]
		if !running {
			watch = &runWatch{published: map[string]bool{}}
			s.watches[key] = watch
		}
		watch.pending++
		s.mu.Unlock()
		if running {
			continue
		}
		message := job.JobMessageBase
		s.publishing.Add(1)
		go func() {
			defer s.publishing.Done()
			s.watchRun(base, lister, key, repository, message)
		}()
	}
}

func (s *Scaler) watchRun(ctx context.Context, lister RunRunners, key, repository string, message scaleset.JobMessageBase) {
	defer func() {
		s.mu.Lock()
		delete(s.watches, key)
		s.mu.Unlock()
	}()
	poll, window := s.earlyFactsPoll, s.earlyFactsWindow
	if poll <= 0 {
		poll = defaultEarlyFactsPoll
	}
	if window <= 0 {
		window = defaultEarlyFactsWindow
	}
	deadline := time.Now().Add(window)
	for {
		runners, err := lister.RunRunners(ctx, repository, message.WorkflowRunID)
		if err != nil {
			s.logger.Debug("could not list the run's runners; JobStarted will publish its facts",
				"workflowRunID", message.WorkflowRunID, "error", err)
		}
		for _, runner := range runners {
			if !strings.HasPrefix(runner, fleetRunnerPrefix) {
				continue
			}
			s.mu.Lock()
			watch := s.watches[key]
			fresh := !watch.published[runner]
			if fresh {
				watch.published[runner] = true
				watch.pending--
			}
			s.mu.Unlock()
			if fresh {
				s.publishEarlyFacts(ctx, message, runner)
			}
		}
		s.mu.Lock()
		done := s.watches[key].pending <= 0
		s.mu.Unlock()
		if done || time.Now().Add(poll).After(deadline) {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(poll):
		}
	}
}

// publishEarlyFacts publishes one runner's facts from its run. Facts it cannot
// establish are left to JobStarted, which publishes cold facts in that case:
// publishing them early would only add a second, identical push.
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
