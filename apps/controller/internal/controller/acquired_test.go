package controller

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/actions/scaleset"

	"github.com/Fanzzzd/erainfra/apps/controller/internal/fleet"
)

// acquisitionStore is a fakeStore that also learns acquired jobs.
type acquisitionStore struct {
	*fakeStore
	profile  string
	recorded []fleet.AcquiredJob
	err      error
}

func (s *acquisitionStore) RecordJobsAcquired(_ context.Context, profile string, jobs []fleet.AcquiredJob) error {
	s.profile = profile
	s.recorded = append(s.recorded, jobs...)
	return s.err
}

// The Scaler reports each acquired job with the run it belongs to, so the
// control plane can name the workflow run when no Worker can take the job.
// A failed report is logged and the message still gets acked.
func TestScalerRecordsAcquiredJobsWithTheirWorkflowRun(t *testing.T) {
	queued := time.Date(2026, 11, 12, 9, 0, 0, 0, time.UTC)
	for _, recordErr := range []error{nil, errors.New("control plane is older")} {
		store := &acquisitionStore{fakeStore: &fakeStore{}, err: recordErr}
		scaler, err := NewScaler(validConfig("rc-linux-js", 4), store, &fakeIssuer{}, names("rc-linux-js-a"))
		if err != nil {
			t.Fatal(err)
		}
		stop := errors.New("end of script")
		queue := &scriptedQueue{statistics: &scaleset.RunnerScaleSetStatistic{}}
		queue.polls = []func() (*scaleset.RunnerScaleSetMessage, error){
			func() (*scaleset.RunnerScaleSetMessage, error) {
				return &scaleset.RunnerScaleSetMessage{
					MessageID:  7,
					Statistics: &scaleset.RunnerScaleSetStatistic{TotalAssignedJobs: 1},
					JobAvailableMessages: []*scaleset.JobAvailable{{JobMessageBase: scaleset.JobMessageBase{
						RunnerRequestID: 31,
						RepositoryName:  "payable",
						OwnerName:       "example-org",
						JobID:           "job-31",
						JobDisplayName:  "e2e",
						WorkflowRunID:   4242,
						QueueTime:       queued,
					}}},
				}, nil
			},
			func() (*scaleset.RunnerScaleSetMessage, error) { return nil, stop },
		}
		if err := runScripted(t, scaler, queue); !errors.Is(err, stop) {
			t.Fatalf("Run = %v, want the scripted stop", err)
		}
		want := []fleet.AcquiredJob{{
			RunnerRequestID: 31, Repository: "payable", Owner: "example-org", JobID: "job-31",
			DisplayName: "e2e", WorkflowRunID: 4242, QueueTime: queued,
		}}
		if store.profile != "rc-linux-js" || !reflect.DeepEqual(store.recorded, want) {
			t.Fatalf("recorded %q %+v, want %+v", store.profile, store.recorded, want)
		}
		if !reflect.DeepEqual(queue.deleted, []int{7}) {
			t.Fatalf("acked = %v, want [7] even when the report fails", queue.deleted)
		}
	}
}

// Only jobs GitHub confirmed are reported.
func TestAcquiredJobsKeepsOnlyConfirmedRequests(t *testing.T) {
	offered := []*scaleset.JobAvailable{
		{JobMessageBase: scaleset.JobMessageBase{RunnerRequestID: 1, WorkflowRunID: 10}},
		nil,
		{JobMessageBase: scaleset.JobMessageBase{RunnerRequestID: 2, WorkflowRunID: 20}},
	}
	got := acquiredJobs(offered, []int64{2})
	if len(got) != 1 || got[0].RunnerRequestID != 2 || got[0].WorkflowRunID != 20 {
		t.Fatalf("acquiredJobs = %+v", got)
	}
}
