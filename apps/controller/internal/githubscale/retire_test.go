package githubscale

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/actions/scaleset"
)

type retireFake struct {
	scaleSet *scaleset.RunnerScaleSet
	getErr   error
	deleted  []int
	groupID  int
	asked    string
}

func (f *retireFake) GetRunnerGroupByName(_ context.Context, name string) (*scaleset.RunnerGroup, error) {
	return &scaleset.RunnerGroup{ID: f.groupID, Name: name}, nil
}

func (f *retireFake) GetRunnerScaleSet(_ context.Context, groupID int, name string) (*scaleset.RunnerScaleSet, error) {
	f.asked = name
	if f.getErr != nil {
		return nil, f.getErr
	}
	if f.scaleSet == nil || groupID != f.scaleSet.RunnerGroupID {
		return nil, nil
	}
	return f.scaleSet, nil
}

func (f *retireFake) DeleteRunnerScaleSet(_ context.Context, id int) error {
	f.deleted = append(f.deleted, id)
	return nil
}

func idle(id int) *scaleset.RunnerScaleSet {
	return &scaleset.RunnerScaleSet{ID: id, Name: "rc-linux-js", RunnerGroupID: 1, Statistics: &scaleset.RunnerScaleSetStatistic{}}
}

func TestRetireWithoutApplyOnlyReports(t *testing.T) {
	fake := &retireFake{scaleSet: idle(7)}
	plan, err := Retire(t.Context(), fake, "rc-linux-js", "", false, false)
	if err != nil {
		t.Fatal(err)
	}
	if !plan.Found || plan.ID != 7 || plan.Deleted || len(fake.deleted) != 0 {
		t.Fatalf("dry run changed something: %+v, deleted %v", plan, fake.deleted)
	}
}

func TestRetireDeletesAnIdleScaleSet(t *testing.T) {
	fake := &retireFake{scaleSet: idle(7)}
	plan, err := Retire(t.Context(), fake, " rc-linux-js ", scaleset.DefaultRunnerGroup, true, false)
	if err != nil {
		t.Fatal(err)
	}
	if !plan.Deleted || len(fake.deleted) != 1 || fake.deleted[0] != 7 || fake.asked != "rc-linux-js" {
		t.Fatalf("plan %+v, deleted %v, asked %q", plan, fake.deleted, fake.asked)
	}
}

func TestRetireRefusesWhileGitHubCountsWork(t *testing.T) {
	for name, stats := range map[string]scaleset.RunnerScaleSetStatistic{
		"busy runner":  {TotalBusyRunners: 1},
		"assigned job": {TotalAssignedJobs: 2},
		"running job":  {TotalRunningJobs: 1},
	} {
		t.Run(name, func(t *testing.T) {
			set := idle(9)
			set.Statistics = &stats
			fake := &retireFake{scaleSet: set}
			_, err := Retire(t.Context(), fake, "rc-linux-js", "", true, false)
			if err == nil || !strings.Contains(err.Error(), "--force") || len(fake.deleted) != 0 {
				t.Fatalf("err %v, deleted %v", err, fake.deleted)
			}
			plan, err := Retire(t.Context(), fake, "rc-linux-js", "", true, true)
			if err != nil || !plan.Deleted {
				t.Fatalf("force did not delete: %+v %v", plan, err)
			}
		})
	}
}

func TestRetireOfAMissingScaleSetIsNotAnError(t *testing.T) {
	fake := &retireFake{}
	plan, err := Retire(t.Context(), fake, "rc-e2e", "", true, false)
	if err != nil || plan.Found || plan.Deleted || len(fake.deleted) != 0 {
		t.Fatalf("plan %+v err %v deleted %v", plan, err, fake.deleted)
	}
}

func TestRetireResolvesANamedRunnerGroup(t *testing.T) {
	set := idle(3)
	set.RunnerGroupID = 42
	fake := &retireFake{scaleSet: set, groupID: 42}
	plan, err := Retire(t.Context(), fake, "rc-linux-js", "ci", true, false)
	if err != nil || !plan.Deleted {
		t.Fatalf("plan %+v err %v", plan, err)
	}
}

func TestRetireSurfacesLookupFailures(t *testing.T) {
	fake := &retireFake{getErr: errors.New("boom")}
	if _, err := Retire(t.Context(), fake, "rc-linux-js", "", true, false); err == nil {
		t.Fatal("want an error")
	}
}
