package jobmetrics

import (
	"bytes"
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/Fanzzzd/erainfra/internal/golden"
)

// `runner-center-runtime sample` prints these lines, and the Action Runner
// Agent forwards each one to the control plane
// (apps/action-runner-agent/tests/job-metrics.test.ts reads this file). The
// test runs WriteReports, the command's output path: one report while the
// Attempt runs, then the final one. Regenerate it with
// ERAINFRA_UPDATE_GOLDEN=1 go test ./apps/runtime/internal/jobmetrics/.
func TestSampleOutputMatchesTheGoldenFileTheAgentReads(t *testing.T) {
	series := NewSeries("firecracker", 5*time.Second)
	observeUntil := func(from, to int) {
		for step := from; step < to; step++ {
			elapsed := time.Duration(step) * 5 * time.Second
			series.Observe(steady(epoch.Add(elapsed), elapsed, 2))
		}
	}
	observeUntil(0, 3)
	running := series.Snapshot()
	observeUntil(3, 5)
	final := series.Snapshot()

	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	collect := func(collectContext context.Context) (Snapshot, bool) {
		// The final collection runs on a context that is never cancelled.
		if collectContext.Err() == nil && ctx.Err() != nil {
			return final, true
		}
		cancel()
		return running, true
	}
	var stdout bytes.Buffer
	if err := WriteReports(ctx, &stdout, time.Millisecond, collect); err != nil {
		t.Fatal(err)
	}
	golden.Check(
		t,
		filepath.Join("testdata", "sample.golden.jsonl"),
		stdout.Bytes(),
		"the Action Runner Agent's job metrics tests",
	)
}
