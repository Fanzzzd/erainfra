package githubscale

import (
	"context"
	"fmt"
	"strings"

	"github.com/actions/scaleset"
)

// RetireClient is the part of the scale-set API that retiring a Profile needs.
type RetireClient interface {
	GetRunnerGroupByName(ctx context.Context, runnerGroup string) (*scaleset.RunnerGroup, error)
	GetRunnerScaleSet(ctx context.Context, runnerGroupID int, name string) (*scaleset.RunnerScaleSet, error)
	DeleteRunnerScaleSet(ctx context.Context, runnerScaleSetID int) error
}

// RetirePlan is what Retire found, and what it did when asked to act.
type RetirePlan struct {
	Name         string
	Found        bool
	ID           int
	BusyRunners  int
	AssignedJobs int
	RunningJobs  int
	Deleted      bool
}

// Busy reports whether GitHub still counts work on the scale set.
func (p RetirePlan) Busy() bool {
	return p.BusyRunners > 0 || p.AssignedJobs > 0 || p.RunningJobs > 0
}

// Retire looks up a scale set and, when apply is true, deletes it.
//
// Stopping a controller leaves its scale set registered: GitHub keeps routing
// `runs-on: <name>` jobs to it, and with no listener they sit queued until
// GitHub cancels them after 24 hours. Retiring is the explicit inverse of
// EnsureScaleSet. It refuses while GitHub reports busy runners or assigned or
// running jobs, because deleting the scale set under a running job orphans
// that job's runner; force overrides that for a scale set whose controller is
// already gone and whose counters will never drain.
func Retire(ctx context.Context, client RetireClient, name, runnerGroup string, apply, force bool) (RetirePlan, error) {
	plan := RetirePlan{Name: strings.TrimSpace(name)}
	if client == nil {
		return plan, fmt.Errorf("GitHub scale-set client is required")
	}
	if plan.Name == "" {
		return plan, fmt.Errorf("scale-set name is required")
	}
	runnerGroupID := 1
	if runnerGroup != "" && runnerGroup != scaleset.DefaultRunnerGroup {
		group, err := client.GetRunnerGroupByName(ctx, runnerGroup)
		if err != nil {
			return plan, fmt.Errorf("resolve runner group %q: %w", runnerGroup, err)
		}
		runnerGroupID = group.ID
	}
	existing, err := client.GetRunnerScaleSet(ctx, runnerGroupID, plan.Name)
	if err != nil {
		return plan, fmt.Errorf("get scale set %q: %w", plan.Name, err)
	}
	if existing == nil {
		return plan, nil
	}
	plan.Found = true
	plan.ID = existing.ID
	if stats := existing.Statistics; stats != nil {
		plan.BusyRunners = stats.TotalBusyRunners
		plan.AssignedJobs = stats.TotalAssignedJobs
		plan.RunningJobs = stats.TotalRunningJobs
	}
	if !apply {
		return plan, nil
	}
	if plan.Busy() && !force {
		return plan, fmt.Errorf(
			"scale set %q still has %d busy runner(s), %d assigned and %d running job(s); stop sending it work and retry, or pass --force if its controller is gone for good",
			plan.Name, plan.BusyRunners, plan.AssignedJobs, plan.RunningJobs,
		)
	}
	if err := client.DeleteRunnerScaleSet(ctx, existing.ID); err != nil {
		return plan, fmt.Errorf("delete scale set %q: %w", plan.Name, err)
	}
	plan.Deleted = true
	return plan, nil
}
