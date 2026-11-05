package jobmetrics

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"time"
)

const (
	// DefaultReportInterval is how often the Worker forwards a Snapshot to the
	// control plane while an Attempt runs.
	DefaultReportInterval = 30 * time.Second
	// finalCollectTimeout bounds the closing collection. The Attempt is
	// already over by then; nothing waits on this but the Worker's upload.
	finalCollectTimeout = 10 * time.Second
)

// Report is one line of `runner-center-runtime sample` output.
type Report struct {
	Final    bool     `json:"final"`
	Snapshot Snapshot `json:"snapshot"`
}

// Collect returns the current Snapshot, or false when there is none yet.
type Collect func(context.Context) (Snapshot, bool)

// WriteReports writes a Report line to out every interval in which the
// Snapshot gained a sample, and one Final line when ctx ends. Writing nothing
// for an unchanged Snapshot keeps an idle or unmeasurable Attempt from
// costing the control plane a write every interval.
func WriteReports(ctx context.Context, out io.Writer, every time.Duration, collect Collect) error {
	if every <= 0 {
		every = DefaultReportInterval
	}
	encoder := json.NewEncoder(out)
	var reported uint64
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			finalContext, cancel := context.WithTimeout(context.WithoutCancel(ctx), finalCollectTimeout)
			snapshot, ok := collect(finalContext)
			cancel()
			if !ok {
				return nil
			}
			if err := encoder.Encode(Report{Final: true, Snapshot: snapshot}); err != nil {
				return fmt.Errorf("write final metrics report: %w", err)
			}
			return nil
		case <-ticker.C:
			snapshot, ok := collect(ctx)
			if !ok || snapshot.Samples <= reported {
				continue
			}
			if err := encoder.Encode(Report{Snapshot: snapshot}); err != nil {
				return fmt.Errorf("write metrics report: %w", err)
			}
			reported = snapshot.Samples
		}
	}
}
