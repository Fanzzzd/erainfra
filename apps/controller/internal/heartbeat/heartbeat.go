// Package heartbeat reports a controller's liveness to the control plane.
//
// A dead controller creates no Attempts, so from the control plane's side it is
// indistinguishable from an idle fleet. The heartbeat is what tells them apart:
// every interval, and at once whenever the session state changes, the Reporter
// sends what the controller is doing, when GitHub last answered it, and GitHub's
// own job counts for the scale set.
package heartbeat

import (
	"context"
	"io"
	"log/slog"
	"sync"
	"time"

	"github.com/Fanzzzd/erainfra/apps/controller/internal/fleet"
	"github.com/actions/scaleset"
	"github.com/actions/scaleset/listener"
)

// DefaultInterval is how often a controller reports. The control plane treats
// a controller as offline after three missed reports (90 s), which tolerates
// one slow request and one dropped one without flapping.
const DefaultInterval = 30 * time.Second

// finalReportBudget bounds the last report a stopping controller sends. systemd
// gives the unit 30 s to stop (TimeoutStopSec), and closing the GitHub session
// needs some of that.
const finalReportBudget = 5 * time.Second

// reportBudget bounds every other report. A stop does not cancel a report in
// flight: the control plane keeps whichever report it received last, and a
// request the controller abandoned can still be processed after the final one,
// so abandoning it could overwrite "stopped" with an older state. Waiting out a
// slow report at shutdown costs at most this long, which with the session close
// and the final report stays inside systemd's 30 s.
const reportBudget = 10 * time.Second

// Sender delivers one report. convexstore.Store implements it.
type Sender interface {
	SendHeartbeat(ctx context.Context, report fleet.ControllerHeartbeat) error
}

// Reporter holds the controller's current report and sends it. GitHub's
// statistics reach it through the session client Observe wraps, so the Scaler
// knows nothing about heartbeats.
type Reporter struct {
	sender   Sender
	interval time.Duration
	logger   *slog.Logger
	now      func() time.Time

	mu      sync.Mutex
	current fleet.ControllerHeartbeat
	wake    chan struct{}
}

// Option configures a Reporter.
type Option func(*Reporter)

// WithInterval overrides DefaultInterval.
func WithInterval(interval time.Duration) Option {
	return func(r *Reporter) {
		if interval > 0 {
			r.interval = interval
		}
	}
}

// WithLogger records failed reports. Without it they are discarded.
func WithLogger(logger *slog.Logger) Option {
	return func(r *Reporter) {
		if logger != nil {
			r.logger = logger
		}
	}
}

// WithClock replaces time.Now, for tests.
func WithClock(now func() time.Time) Option {
	return func(r *Reporter) {
		if now != nil {
			r.now = now
		}
	}
}

// New returns a Reporter whose first report carries base, in the starting
// state. Profile, Hostname, Version and StartedAt come from base.
func New(sender Sender, base fleet.ControllerHeartbeat, opts ...Option) *Reporter {
	reporter := &Reporter{
		sender:   sender,
		interval: DefaultInterval,
		logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		now:      time.Now,
		current:  base,
		wake:     make(chan struct{}, 1),
	}
	for _, opt := range opts {
		opt(reporter)
	}
	if reporter.current.SessionState == "" {
		reporter.current.SessionState = fleet.SessionStarting
	}
	if reporter.current.StartedAt.IsZero() {
		reporter.current.StartedAt = reporter.now()
	}
	return reporter
}

// Snapshot returns the report the next send would carry.
func (r *Reporter) Snapshot() fleet.ControllerHeartbeat {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.current
}

// SetScaleSetID records the GitHub scale set once it is known.
func (r *Reporter) SetScaleSetID(id int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.current.ScaleSetID = id
}

// SetSession records a session state and the error behind it, if any. A
// change of state is reported at once rather than at the next tick, so the
// dashboard sees a conflict or a stop within seconds.
func (r *Reporter) SetSession(state fleet.SessionState, cause error) {
	r.mu.Lock()
	changed := r.current.SessionState != state
	r.current.SessionState = state
	r.current.LastError = ""
	if cause != nil {
		r.current.LastError = cause.Error()
	}
	r.mu.Unlock()
	if changed {
		select {
		case r.wake <- struct{}{}:
		default:
		}
	}
}

// RecordPoll marks that GitHub answered the message long poll just now.
func (r *Reporter) RecordPoll() {
	now := r.now()
	r.mu.Lock()
	defer r.mu.Unlock()
	r.current.LastMessageAt = now
}

// RecordStatistics keeps GitHub's newest job counts for the scale set.
func (r *Reporter) RecordStatistics(statistics *scaleset.RunnerScaleSetStatistic) {
	if statistics == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.current.AssignedJobs = statistics.TotalAssignedJobs
	r.current.RunningJobs = statistics.TotalRunningJobs
}

// Run reports at once, then every interval and on every state change, until
// ctx ends. It then sends one last report with a fresh deadline, so a stopping
// controller's final state reaches the control plane even though ctx is gone.
// Set the final state with SetSession before cancelling ctx.
func (r *Reporter) Run(ctx context.Context) {
	ticker := time.NewTicker(r.interval)
	defer ticker.Stop()
	r.send(ctx, reportBudget)
	for {
		select {
		case <-ctx.Done():
			r.send(ctx, finalReportBudget)
			return
		case <-ticker.C:
			r.send(ctx, reportBudget)
		case <-r.wake:
			r.send(ctx, reportBudget)
		}
	}
}

// send delivers the current report on a context that ctx's cancellation does
// not reach, bounded by budget. Reports go out one at a time, so the control
// plane has answered each one before the next is sent, and they land in order.
func (r *Reporter) send(ctx context.Context, budget time.Duration) {
	report := r.Snapshot()
	sendCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), budget)
	defer cancel()
	if err := r.sender.SendHeartbeat(sendCtx, report); err != nil {
		// A failed report is not fatal: the controller keeps serving jobs, and
		// the control plane notices the silence on its own.
		r.logger.Warn("could not report controller heartbeat", "state", report.SessionState, "error", err)
	}
}

// Observe wraps the listener's session client so every answer GitHub gives to
// the long poll, a message or an empty reply, counts as contact, and the job
// counts it carries become the report's. A failed poll does not count. The
// session's own statistics are recorded when the listener reads them at start.
func (r *Reporter) Observe(client listener.Client) listener.Client {
	return observedClient{Client: client, reporter: r}
}

type observedClient struct {
	listener.Client
	reporter *Reporter
}

func (c observedClient) GetMessage(ctx context.Context, lastMessageID, maxCapacity int) (*scaleset.RunnerScaleSetMessage, error) {
	message, err := c.Client.GetMessage(ctx, lastMessageID, maxCapacity)
	if err == nil {
		c.reporter.RecordPoll()
		if message != nil {
			c.reporter.RecordStatistics(message.Statistics)
		}
	}
	return message, err
}

func (c observedClient) Session() scaleset.RunnerScaleSetSession {
	session := c.Client.Session()
	c.reporter.RecordStatistics(session.Statistics)
	return session
}
