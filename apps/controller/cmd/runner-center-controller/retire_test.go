package main

import (
	"context"
	"testing"

	"github.com/Fanzzzd/erainfra/apps/controller/internal/config"
	"github.com/actions/scaleset"
)

// retireRecorder is both the GitHub scale-set API and the control plane, so the
// test sees the order of the two writes retirement makes.
type retireRecorder struct {
	stats *scaleset.RunnerScaleSetStatistic
	calls []string
}

func (r *retireRecorder) GetRunnerGroupByName(context.Context, string) (*scaleset.RunnerGroup, error) {
	return &scaleset.RunnerGroup{ID: 1}, nil
}

func (r *retireRecorder) GetRunnerScaleSet(context.Context, int, string) (*scaleset.RunnerScaleSet, error) {
	return &scaleset.RunnerScaleSet{ID: 9, Name: "rc-linux-js", Statistics: r.stats}, nil
}

func (r *retireRecorder) DeleteRunnerScaleSet(context.Context, int) error {
	r.calls = append(r.calls, "delete")
	return nil
}

func (r *retireRecorder) PauseProfile(context.Context, string) (bool, error) {
	r.calls = append(r.calls, "pause")
	return true, nil
}

func TestRetireUnderLeaseRefusesBeforePausingAndPausesBeforeDeleting(t *testing.T) {
	cfg := config.Config{Profile: "rc-linux-js", ScaleSetName: "rc-linux-js", RunnerGroup: scaleset.DefaultRunnerGroup}
	idle := &scaleset.RunnerScaleSetStatistic{}
	busy := &scaleset.RunnerScaleSetStatistic{TotalRunningJobs: 1}
	for _, tc := range []struct {
		name  string
		stats *scaleset.RunnerScaleSetStatistic
		force bool
		calls []string
	}{
		// #182: missing statistics never authorize deletion without --force,
		// and the refusal happens before the Profile is paused.
		{"unknown statistics", nil, false, nil},
		{"busy", busy, false, nil},
		{"unknown statistics, forced", nil, true, []string{"pause", "delete"}},
		{"busy, forced", busy, true, []string{"pause", "delete"}},
		{"idle", idle, false, []string{"pause", "delete"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			recorder := &retireRecorder{stats: tc.stats}
			err := retireUnderLease(t.Context(), recorder, recorder, cfg, tc.force)
			if (err == nil) != (tc.calls != nil) {
				t.Fatalf("err = %v", err)
			}
			if len(recorder.calls) != len(tc.calls) {
				t.Fatalf("calls = %v, want %v", recorder.calls, tc.calls)
			}
			for i := range tc.calls {
				if recorder.calls[i] != tc.calls[i] {
					t.Fatalf("calls = %v, want %v", recorder.calls, tc.calls)
				}
			}
		})
	}
}
