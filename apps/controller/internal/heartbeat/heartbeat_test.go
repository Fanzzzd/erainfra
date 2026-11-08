package heartbeat

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/Fanzzzd/erainfra/apps/controller/internal/fleet"
	"github.com/actions/scaleset"
)

type recordingSender struct {
	mu      sync.Mutex
	reports []fleet.ControllerHeartbeat
	sent    chan fleet.ControllerHeartbeat
	fail    error
	ctxErrs []error
}

func newRecordingSender() *recordingSender {
	return &recordingSender{sent: make(chan fleet.ControllerHeartbeat, 64)}
}

func (s *recordingSender) SendHeartbeat(ctx context.Context, report fleet.ControllerHeartbeat) error {
	s.mu.Lock()
	s.reports = append(s.reports, report)
	s.ctxErrs = append(s.ctxErrs, ctx.Err())
	fail := s.fail
	s.mu.Unlock()
	s.sent <- report
	return fail
}

func (s *recordingSender) next(t *testing.T) fleet.ControllerHeartbeat {
	t.Helper()
	select {
	case report := <-s.sent:
		return report
	case <-time.After(5 * time.Second):
		t.Fatal("no heartbeat was sent")
		return fleet.ControllerHeartbeat{}
	}
}

func base() fleet.ControllerHeartbeat {
	return fleet.ControllerHeartbeat{
		Profile:   "rc-linux-js",
		Hostname:  "oracle-singapore-1",
		Version:   "0.2.0-rc.11",
		StartedAt: time.UnixMilli(1_786_300_000_000),
	}
}

func TestReportsAtOnceThenOnEveryStateChangeAndAFinalStop(t *testing.T) {
	sender := newRecordingSender()
	// An interval far longer than the test, so every report after the first is
	// one a state change caused.
	reporter := New(sender, base(), WithInterval(time.Hour))
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan struct{})
	go func() {
		defer close(done)
		reporter.Run(ctx)
	}()

	first := sender.next(t)
	if first.SessionState != fleet.SessionStarting || first.Hostname != "oracle-singapore-1" {
		t.Fatalf("first report = %+v", first)
	}

	conflict := errors.New(`status="409 Conflict"`)
	reporter.SetSession(fleet.SessionConflict, conflict)
	if report := sender.next(t); report.SessionState != fleet.SessionConflict || report.LastError != conflict.Error() {
		t.Fatalf("conflict report = %+v", report)
	}

	reporter.SetSession(fleet.SessionListening, nil)
	if report := sender.next(t); report.SessionState != fleet.SessionListening || report.LastError != "" {
		t.Fatalf("listening report = %+v, want the conflict error cleared", report)
	}

	reporter.SetSession(fleet.SessionStopped, nil)
	cancel()
	<-done
	// The stop may be reported by the wake-up, by the final flush, or both; the
	// last report must say stopped, and it must have been sent on a live context.
	sender.mu.Lock()
	defer sender.mu.Unlock()
	last := sender.reports[len(sender.reports)-1]
	if last.SessionState != fleet.SessionStopped {
		t.Fatalf("last report = %+v, want stopped", last)
	}
	if err := sender.ctxErrs[len(sender.ctxErrs)-1]; err != nil {
		t.Fatalf("the final report was sent on a dead context: %v", err)
	}
}

func TestAnUnchangedStateWaitsForTheNextTick(t *testing.T) {
	sender := newRecordingSender()
	reporter := New(sender, base(), WithInterval(20*time.Millisecond))
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	go reporter.Run(ctx)

	sender.next(t)
	reporter.SetSession(fleet.SessionStarting, nil) // no change
	reporter.RecordStatistics(&scaleset.RunnerScaleSetStatistic{TotalAssignedJobs: 4, TotalRunningJobs: 1})
	// The ticker, not the no-op SetSession, carries the new counts.
	for {
		report := sender.next(t)
		if report.AssignedJobs == 4 && report.RunningJobs == 1 {
			return
		}
	}
}

func TestAFailingReportDoesNotStopReporting(t *testing.T) {
	sender := newRecordingSender()
	sender.fail = errors.New("control plane unavailable")
	reporter := New(sender, base(), WithInterval(10*time.Millisecond))
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	go reporter.Run(ctx)
	for range 3 {
		sender.next(t)
	}
}

type fakeSessionClient struct {
	message *scaleset.RunnerScaleSetMessage
	err     error
}

func (c fakeSessionClient) GetMessage(context.Context, int, int) (*scaleset.RunnerScaleSetMessage, error) {
	return c.message, c.err
}
func (fakeSessionClient) DeleteMessage(context.Context, int) error { return nil }
func (fakeSessionClient) AcquireJobs(context.Context, []int64) ([]int64, error) {
	return nil, nil
}
func (fakeSessionClient) Session() scaleset.RunnerScaleSetSession {
	return scaleset.RunnerScaleSetSession{}
}

func TestObserveCountsEveryAnswerFromGitHubButNotAFailure(t *testing.T) {
	now := time.UnixMilli(1_786_300_000_000)
	reporter := New(newRecordingSender(), base(), WithClock(func() time.Time { return now }))

	failing := reporter.Observe(fakeSessionClient{err: errors.New("connection reset")})
	if _, err := failing.GetMessage(t.Context(), 0, 1); err == nil {
		t.Fatal("the wrapper must pass the error through")
	}
	if !reporter.Snapshot().LastMessageAt.IsZero() {
		t.Fatal("a failed poll is not contact with GitHub")
	}

	// An empty long-poll reply (202, a nil message) is GitHub answering.
	if _, err := reporter.Observe(fakeSessionClient{}).GetMessage(t.Context(), 0, 1); err != nil {
		t.Fatal(err)
	}
	if got := reporter.Snapshot().LastMessageAt; !got.Equal(now) {
		t.Fatalf("lastMessageAt = %v, want %v", got, now)
	}

	now = now.Add(time.Minute)
	message := &scaleset.RunnerScaleSetMessage{MessageID: 7}
	got, err := reporter.Observe(fakeSessionClient{message: message}).GetMessage(t.Context(), 0, 1)
	if err != nil || got != message {
		t.Fatalf("GetMessage = %v, %v", got, err)
	}
	if got := reporter.Snapshot().LastMessageAt; !got.Equal(now) {
		t.Fatalf("lastMessageAt = %v, want %v", got, now)
	}
}

func TestRecordStatisticsKeepsGitHubsCounts(t *testing.T) {
	reporter := New(newRecordingSender(), base())
	reporter.RecordStatistics(nil)
	reporter.RecordStatistics(&scaleset.RunnerScaleSetStatistic{TotalAssignedJobs: 5, TotalRunningJobs: 3})
	snapshot := reporter.Snapshot()
	if snapshot.AssignedJobs != 5 || snapshot.RunningJobs != 3 {
		t.Fatalf("snapshot = %+v", snapshot)
	}
}

// blockingSender holds its first report until released, so a test can stop the
// Reporter while that report is in flight.
type blockingSender struct {
	*recordingSender
	started  chan struct{}
	release  chan struct{}
	inFlight error
}

func (s *blockingSender) SendHeartbeat(ctx context.Context, report fleet.ControllerHeartbeat) error {
	s.mu.Lock()
	first := len(s.reports) == 0
	s.mu.Unlock()
	if first {
		close(s.started)
		<-s.release
		s.mu.Lock()
		s.inFlight = ctx.Err()
		s.mu.Unlock()
	}
	return s.recordingSender.SendHeartbeat(ctx, report)
}

// The control plane keeps the report it received last. A stop that abandoned
// the report in flight would let that older report land after "stopped", so
// the in-flight report must finish on a live context before the final one goes.
func TestAStopWaitsForTheReportInFlightBeforeTheFinalOne(t *testing.T) {
	sender := &blockingSender{
		recordingSender: newRecordingSender(),
		started:         make(chan struct{}),
		release:         make(chan struct{}),
	}
	reporter := New(sender, base(), WithInterval(time.Hour))
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan struct{})
	go func() {
		defer close(done)
		reporter.Run(ctx)
	}()

	<-sender.started
	reporter.SetSession(fleet.SessionStopped, nil)
	cancel()
	close(sender.release)
	<-done

	sender.mu.Lock()
	defer sender.mu.Unlock()
	if sender.inFlight != nil {
		t.Fatalf("stopping cancelled the report in flight: %v", sender.inFlight)
	}
	if first := sender.reports[0]; first.SessionState != fleet.SessionStarting {
		t.Fatalf("first report = %+v, want starting", first)
	}
	if last := sender.reports[len(sender.reports)-1]; last.SessionState != fleet.SessionStopped {
		t.Fatalf("last report = %+v, want stopped after the in-flight one", last)
	}
}
