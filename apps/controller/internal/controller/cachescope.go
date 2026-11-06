package controller

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/Fanzzzd/erainfra/apps/controller/internal/cachefacts"
	"github.com/Fanzzzd/erainfra/apps/controller/internal/githubapi"
	"github.com/actions/scaleset"
)

// The cache scope follows GitHub's own rule for its hosted cache
// (docs.github.com, "Restrictions for accessing a cache"): a run reads its own
// ref, then a pull request's base branch, then the default branch, and never a
// sibling; a pull request writes only to its merge ref, refs/pull/<n>/merge. The
// scale-set message cannot supply those facts. Its JobWorkflowRef names the ref
// of the workflow FILE the job came from, which for a reusable workflow called
// as owner/repo/.github/workflows/x.yml@main is "main" whatever branch was
// pushed, so trusting it hands a feature branch read-write on main's cache. The
// controller therefore reads the workflow run from GitHub at JobStarted and
// derives every fact from it.

const (
	// defaultCacheScopeBudget bounds the GitHub lookups for one job. They run off
	// the listener's path (see publishCacheFacts), so the budget does not delay
	// the job or MarkJobStarted; it bounds how long a job may run before its facts
	// land. Three seconds is several GitHub round-trips and well under the time a
	// job takes to reach its first cache step.
	defaultCacheScopeBudget = 3 * time.Second
	// cachePushBudget bounds the push to the cache service, which is on the
	// operator's own network.
	cachePushBudget = 5 * time.Second
)

// Cold facts. When the scope cannot be established, the controller still pushes
// facts, so the job's cache requests are answered as misses instead of 401s, but
// facts that grant nothing: a head repository that is not the job's repository
// makes cachetoken.Scope treat the job as running foreign code (read-only, own ref
// discarded), and with no base ref and no default branch nothing is left to read.
// unverifiedHeadRepository has no "/" so it can never equal an owner/name.
const (
	unverifiedHeadRepository = "(unverified)"
	unresolvedRef            = "(unresolved)"
)

// WorkflowRuns is the narrow part of GitHub's REST API the cache scope needs.
type WorkflowRuns interface {
	WorkflowRun(ctx context.Context, repository string, runID int64) (githubapi.WorkflowRun, error)
	DefaultBranch(ctx context.Context, repository string) (string, error)
	RefExists(ctx context.Context, repository, ref string) (bool, error)
}

// pullRequestRefEvents run on refs/pull/<n>/merge, which is where their caches
// are written.
var pullRequestRefEvents = map[string]bool{
	"pull_request":                true,
	"pull_request_review":         true,
	"pull_request_review_comment": true,
}

// resolveCacheFacts derives a job's cache facts from its workflow run. Any fact it
// cannot establish is an error, and the caller publishes cold facts instead:
// unknown never widens a scope.
func resolveCacheFacts(ctx context.Context, runs WorkflowRuns, job *scaleset.JobStarted) (cachefacts.Facts, error) {
	repository := repositorySlug(job.OwnerName, job.RepositoryName)
	if repository == "" {
		return cachefacts.Facts{}, errors.New("job names no repository")
	}
	if runs == nil {
		return cachefacts.Facts{}, errors.New("no GitHub API is configured")
	}
	if job.WorkflowRunID <= 0 {
		return cachefacts.Facts{}, errors.New("job names no workflow run")
	}
	run, err := runs.WorkflowRun(ctx, repository, job.WorkflowRunID)
	if err != nil {
		return cachefacts.Facts{}, err
	}
	if !strings.EqualFold(run.Repository.FullName, repository) || run.Repository.ID == 0 {
		return cachefacts.Facts{}, fmt.Errorf("workflow run belongs to %q, not %q", run.Repository.FullName, repository)
	}
	event := strings.ToLower(strings.TrimSpace(run.Event))
	if event == "" {
		return cachefacts.Facts{}, errors.New("workflow run names no event")
	}

	facts := cachefacts.Facts{
		Runner:       job.RunnerName,
		Repository:   repository,
		RepositoryID: run.Repository.ID,
		Event:        event,
	}
	if run.HeadRepository != nil {
		facts.HeadRepository = run.HeadRepository.FullName
	}
	// The default branch is the third read scope, never a write scope, so failing
	// to learn it costs warm caches on new branches and nothing else.
	if branch, err := runs.DefaultBranch(ctx, repository); err == nil {
		facts.DefaultBranch = "refs/heads/" + branch
	}

	isPullRequest := pullRequestRefEvents[event] || event == "pull_request_target"
	var pr githubapi.PullRequest
	var havePR bool
	if isPullRequest {
		pr, havePR = matchPullRequest(run)
		if havePR {
			facts.BaseRef = "refs/heads/" + pr.BaseRef
		}
	}

	foreign := facts.HeadRepository != "" && !strings.EqualFold(facts.HeadRepository, repository)
	switch {
	case foreign:
		// Code from another repository never gets a scope of its own, and its
		// ref (a fork's branch name) means nothing here: cachetoken.Scope
		// replaces Ref with the base branch, or else the default branch, and
		// makes the job read-only. Ref is set to that same scope because the
		// service refuses facts with no ref, and a fork pull request's merge ref
		// is not in the run when GitHub lists no pull request for it.
		facts.Ref = facts.BaseRef
		if facts.Ref == "" {
			facts.Ref = facts.DefaultBranch
		}
	case pullRequestRefEvents[event]:
		if havePR {
			facts.Ref = fmt.Sprintf("refs/pull/%d/merge", pr.Number)
		}
	case event == "pull_request_target":
		// pull_request_target runs on the base branch, and GitHub scopes its
		// cache there.
		facts.Ref = facts.BaseRef
	default:
		facts.Ref, err = branchOrTagRef(ctx, runs, job, run, repository)
		if err != nil {
			return cachefacts.Facts{}, err
		}
	}
	if facts.Ref == "" {
		return cachefacts.Facts{}, fmt.Errorf("could not establish the ref of a %s run", event)
	}
	return facts, nil
}

// matchPullRequest finds the one pull request this run is for. GitHub's list can
// include pull requests into other repositories, so the base must be this
// repository and the head must be the run's head repository and branch or
// commit. Two candidates is ambiguous, and ambiguous is unknown.
func matchPullRequest(run githubapi.WorkflowRun) (githubapi.PullRequest, bool) {
	if run.HeadRepository == nil || run.HeadRepository.ID == 0 {
		return githubapi.PullRequest{}, false
	}
	var found githubapi.PullRequest
	matches := 0
	for _, pr := range run.PullRequests {
		if pr.Number <= 0 || pr.BaseRef == "" ||
			pr.BaseRepoID != run.Repository.ID || pr.HeadRepoID != run.HeadRepository.ID {
			continue
		}
		if pr.HeadSHA != run.HeadSHA && pr.HeadRef != run.HeadBranch {
			continue
		}
		if matches == 0 || pr.Number != found.Number {
			matches++
			found = pr
		}
	}
	return found, matches == 1
}

// branchOrTagRef turns a non-pull-request run's head_branch, which GitHub sets to
// the bare branch or tag name, into a full ref. When the job belongs to the run's
// own top-level workflow, its JobWorkflowRef carries the full ref and is used,
// but only if it agrees with head_branch: a top-level workflow may call itself at
// another ref as a reusable workflow, and that call's jobs carry the callee's ref.
// Otherwise git is asked whether the name is a tag.
func branchOrTagRef(
	ctx context.Context,
	runs WorkflowRuns,
	job *scaleset.JobStarted,
	run githubapi.WorkflowRun,
	repository string,
) (string, error) {
	name := strings.TrimSpace(run.HeadBranch)
	if name == "" {
		return "", errors.New("workflow run names no head branch")
	}
	if ref, ok := topLevelWorkflowRef(job.JobWorkflowRef, run); ok && shortRefName(ref) == name {
		return ref, nil
	}
	isTag, err := runs.RefExists(ctx, repository, "tags/"+name)
	if err != nil {
		return "", err
	}
	if !isTag {
		return "refs/heads/" + name, nil
	}
	isBranch, err := runs.RefExists(ctx, repository, "heads/"+name)
	if err != nil {
		return "", err
	}
	if isBranch {
		return "", fmt.Errorf("%q names both a branch and a tag", name)
	}
	return "refs/tags/" + name, nil
}

// topLevelWorkflowRef returns the ref in a job's workflow ref,
// "{owner}/{repo}/{path}@{ref}", when that workflow is the run's own top-level
// workflow file in the run's own repository.
func topLevelWorkflowRef(workflowRef string, run githubapi.WorkflowRun) (string, bool) {
	workflowRef = strings.TrimSpace(workflowRef)
	at := strings.LastIndex(workflowRef, "@")
	if at < 0 || run.Path == "" || run.Repository.FullName == "" {
		return "", false
	}
	file, ref := workflowRef[:at], workflowRef[at+1:]
	prefix := run.Repository.FullName + "/"
	if len(file) <= len(prefix) || !strings.EqualFold(file[:len(prefix)], prefix) {
		return "", false
	}
	if file[len(prefix):] != run.Path {
		return "", false
	}
	return ref, ref != ""
}

func shortRefName(ref string) string {
	for _, prefix := range []string{"refs/heads/", "refs/tags/"} {
		if name, ok := strings.CutPrefix(ref, prefix); ok {
			return name
		}
	}
	return ""
}

// coldCacheFacts is what the controller publishes when it cannot establish a
// job's scope: read-only, with nothing to read. See unverifiedHeadRepository.
func coldCacheFacts(job *scaleset.JobStarted) cachefacts.Facts {
	return cachefacts.Facts{
		Runner:         job.RunnerName,
		Repository:     repositorySlug(job.OwnerName, job.RepositoryName),
		HeadRepository: unverifiedHeadRepository,
		Event:          strings.ToLower(strings.TrimSpace(job.EventName)),
		Ref:            unresolvedRef,
	}
}
