// Package admission holds an Attempt's start while its Worker's disk is congested.
//
// A Worker's disk is shared by every guest on it. When several Attempts start at once, their
// boots, checkouts and installs land on the disk together and every job on the Worker slows,
// including the ones already running. The Gate admits Attempts in arrival order and holds the
// head of the line while either limit is reached:
//
//   - the start window: how many Attempts may be inside their first StartWindow at once. The
//     window is learned, the way TCP learns its congestion window. It opens at MaxStarting, is
//     halved when the host's I/O stall share reaches IOPressureLimit (at most once per
//     StartWindow), and grows by one each time an Attempt finishes its start window with no
//     congestion seen since it was admitted. On a disk with headroom the window stays at
//     MaxStarting and a burst starts at once; on a congested one it shrinks until starts stop
//     adding to the stall.
//   - I/O pressure: the host's io "some" stall share, measured from the kernel's cumulative stall
//     counter between two reads at least a second apart. The kernel's own avg10 trails a burst by
//     about ten seconds; it is used only when no recent reading exists to measure against.
//
// The wait is bounded, because a job routed to this Worker has nowhere else to go; past MaxHold
// the start goes ahead anyway. The control plane reads State to route new jobs elsewhere while
// the Worker is over budget.
package admission

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sync"
	"time"
)

// Budget is how much starting a Worker allows at once.
type Budget struct {
	// MaxStarting is the largest the start window may grow to: how many Attempts may be inside
	// their first StartWindow at once when the disk shows no congestion. 0 means no limit.
	MaxStarting int
	// StartWindow is how long an admitted Attempt counts as starting: the stretch in which its
	// boot, checkout and dependency install load the disk.
	StartWindow time.Duration
	// IOPressureLimit is the host's io "some" stall percentage at or above which starts wait and
	// the start window is halved. 0 means pressure does not hold starts.
	IOPressureLimit float64
	// MaxHold is the longest an Attempt waits before it starts anyway.
	MaxHold time.Duration
}

// DefaultBudget fits a Worker whose guests share one SATA SSD RAID1 with write-through cache, as on
// ubuntu0. Since guests keep job writes in memory (lazy writeback, 2026-11-12) its io "some"
// averaged 3.7% on busy minutes; before that, six guests starting together held it at 40 to 60%
// for minutes. Eight covers the largest burst its Profiles send; congestion shrinks the window.
func DefaultBudget() Budget {
	return Budget{MaxStarting: 8, StartWindow: 60 * time.Second, IOPressureLimit: 30, MaxHold: 120 * time.Second}
}

// Validate rejects a budget the Gate cannot keep.
func (b Budget) Validate() error {
	switch {
	case b.MaxStarting < 0:
		return fmt.Errorf("start budget: MaxStarting %d is negative", b.MaxStarting)
	case b.MaxStarting > 0 && b.StartWindow <= 0:
		return errors.New("start budget: StartWindow must be positive when MaxStarting limits starts")
	case b.IOPressureLimit < 0 || b.IOPressureLimit > 100:
		return fmt.Errorf("start budget: IOPressureLimit %g is not a percentage", b.IOPressureLimit)
	case b.MaxHold < 0:
		return errors.New("start budget: MaxHold is negative")
	}
	return nil
}

// Reasons a start waits. They name the first limit the waiting Attempt hit.
const (
	ReasonQueued     = "queued"      // an earlier Attempt is still waiting
	ReasonStarting   = "starting"    // the start window is full
	ReasonIOPressure = "io-pressure" // the host's I/O stall share is at or above the limit
)

// Decision is how one Attempt was admitted.
type Decision struct {
	Held time.Duration
	// Reason is the last limit the Attempt waited on, or empty when it started at once.
	Reason string
	// Forced is true when MaxHold ran out and the Attempt started over budget.
	Forced bool
}

// State is the Gate's view right now. Its JSON is the shape the Action Runner Agent forwards in
// its heartbeat; testdata/admission-state.golden.json pins it for the agent and the control plane.
type State struct {
	// MaxStarting is the start window now: how many Attempts may be starting at once.
	MaxStarting        int     `json:"maxStarting"`
	StartWindowSeconds int     `json:"startWindowSeconds"`
	IOPressureLimit    float64 `json:"ioPressureLimit"`
	MaxHoldSeconds     int     `json:"maxHoldSeconds"`
	// Starting is how many admitted Attempts are still inside their start window.
	Starting int `json:"starting"`
	// Held is how many Attempts are waiting to start.
	Held int `json:"held"`
	// IOSomeAvg10 is the host's io "some" stall percentage as the Gate last measured it: over
	// the last second or more, or the kernel's avg10 when there was no recent reading. The name
	// is the wire name the agent and the control plane already read. PressureKnown is false when
	// the kernel does not expose pressure, and then pressure holds nothing.
	IOSomeAvg10   float64 `json:"ioSomeAvg10"`
	PressureKnown bool    `json:"pressureKnown"`
	// OverBudget is true when a new Attempt arriving now would wait.
	OverBudget bool `json:"overBudget"`
}

// PSI is one reading of the host's io "some" pressure.
type PSI struct {
	// Avg10 is the kernel's 10 s moving average, a percentage.
	Avg10 float64
	// Total is the cumulative time at least one task stalled on I/O since boot.
	Total time.Duration
}

// Pressure reads the host's io "some" pressure.
type Pressure func() (PSI, error)

// Options lets tests replace the clock and the wait between checks.
type Options struct {
	Now   func() time.Time
	Sleep func(ctx context.Context, d time.Duration) error
	// Poll is how often a waiting Attempt checks again.
	Poll time.Duration
}

const (
	// minRateSpan is the shortest stretch a stall share is measured over: shorter ones swing
	// with single requests.
	minRateSpan = time.Second
	// maxRateSpan is the oldest reading a share is measured against. Past it the share would
	// average over an idle stretch, so the Gate takes avg10 instead.
	maxRateSpan = 10 * time.Second
)

// Gate admits Attempts in arrival order within a Budget.
type Gate struct {
	budget   Budget
	pressure Pressure
	now      func() time.Time
	sleep    func(context.Context, time.Duration) error
	poll     time.Duration

	mu       sync.Mutex
	nextID   uint64
	waiting  []uint64    // arrival order; only the first may start
	starting []time.Time // when each Attempt still inside its start window was admitted
	window   int         // how many may be starting at once; between 1 and MaxStarting
	cut      time.Time   // when congestion last halved the window; zero before the first time
	seen     time.Time   // when congestion was last observed; zero before the first time
	reading  PSI         // the reading the next share is measured against
	readAt   time.Time   // zero before the first reading
	share    float64     // the last measured stall percentage
	known    bool        // whether the last read succeeded
}

// New returns a Gate for budget. pressure may be nil, which means pressure is unknown.
func New(budget Budget, pressure Pressure, options Options) (*Gate, error) {
	if err := budget.Validate(); err != nil {
		return nil, err
	}
	gate := &Gate{
		budget: budget, pressure: pressure, now: options.Now, sleep: options.Sleep, poll: options.Poll,
		window: budget.MaxStarting,
	}
	if gate.now == nil {
		gate.now = time.Now
	}
	if gate.sleep == nil {
		gate.sleep = sleepContext
	}
	if gate.poll <= 0 {
		gate.poll = time.Second
	}
	return gate, nil
}

// Admit blocks until the Attempt may start, MaxHold runs out, or ctx ends. Attempts start in
// the order they called Admit.
func (g *Gate) Admit(ctx context.Context) (Decision, error) {
	g.mu.Lock()
	g.nextID++
	id := g.nextID
	g.waiting = append(g.waiting, id)
	arrived := g.now()
	g.mu.Unlock()
	defer g.leave(id)

	reason := ""
	for {
		g.mu.Lock()
		now := g.now()
		blocked := g.blockedLocked(id, now)
		held := now.Sub(arrived)
		if blocked == "" || (blocked != ReasonQueued && held >= g.budget.MaxHold) {
			g.admitLocked(id, now)
			g.mu.Unlock()
			if blocked != "" {
				return Decision{Held: held, Reason: blocked, Forced: true}, nil
			}
			return Decision{Held: held, Reason: reason}, nil
		}
		reason = blocked
		g.mu.Unlock()
		if err := g.sleep(ctx, g.poll); err != nil {
			return Decision{}, err
		}
	}
}

// State reports the Gate's view now.
func (g *Gate) State() State {
	g.mu.Lock()
	defer g.mu.Unlock()
	now := g.now()
	g.observeLocked(now)
	return State{
		MaxStarting:        g.window,
		StartWindowSeconds: int(g.budget.StartWindow / time.Second),
		IOPressureLimit:    g.budget.IOPressureLimit,
		MaxHoldSeconds:     int(g.budget.MaxHold / time.Second),
		Starting:           len(g.starting),
		Held:               len(g.waiting),
		IOSomeAvg10:        g.share,
		PressureKnown:      g.known,
		OverBudget:         len(g.waiting) > 0 || g.windowFullLocked() || g.congestedLocked(),
	}
}

// blockedLocked names what keeps Attempt id from starting at now, or "" when nothing does.
// The head of the line is the only Attempt that may start, so a held Attempt that times out
// cannot be overtaken by one that arrived later.
func (g *Gate) blockedLocked(id uint64, now time.Time) string {
	if g.waiting[0] != id {
		return ReasonQueued
	}
	g.observeLocked(now)
	switch {
	case g.windowFullLocked():
		return ReasonStarting
	case g.congestedLocked():
		return ReasonIOPressure
	}
	return ""
}

// observeLocked brings the Gate up to now: it measures pressure, halves the window on
// congestion, and retires the start windows that have ended, growing the window for each one
// that saw no congestion.
func (g *Gate) observeLocked(now time.Time) {
	g.measureLocked(now)
	if g.budget.MaxStarting == 0 {
		return
	}
	if g.congestedLocked() {
		g.seen = now
		if g.cut.IsZero() || now.Sub(g.cut) >= g.budget.StartWindow {
			g.window = max(1, g.window/2)
			g.cut = now
		}
	}
	g.starting = slices.DeleteFunc(g.starting, func(admitted time.Time) bool {
		if now.Before(admitted.Add(g.budget.StartWindow)) {
			return false
		}
		if g.seen.IsZero() || g.seen.Before(admitted) {
			g.window = min(g.budget.MaxStarting, g.window+1)
		}
		return true
	})
}

// measureLocked updates the stall share from a fresh reading. The share is the growth of the
// cumulative stall time over the wall time since the reading it is measured against, kept at
// least minRateSpan apart; with no reading in the last maxRateSpan it is the kernel's avg10.
func (g *Gate) measureLocked(now time.Time) {
	if g.pressure == nil {
		g.known = false
		return
	}
	reading, err := g.pressure()
	if err != nil {
		g.known = false
		return
	}
	g.known = true
	span := now.Sub(g.readAt)
	switch {
	case g.readAt.IsZero() || span > maxRateSpan || reading.Total < g.reading.Total:
		g.share = reading.Avg10
	case span < minRateSpan:
		return // too soon to measure; keep the last share and the older reading
	default:
		g.share = min(100, float64(reading.Total-g.reading.Total)/float64(span)*100)
	}
	g.reading, g.readAt = reading, now
}

func (g *Gate) windowFullLocked() bool {
	return g.budget.MaxStarting > 0 && len(g.starting) >= g.window
}

func (g *Gate) congestedLocked() bool {
	return g.known && g.budget.IOPressureLimit > 0 && g.share >= g.budget.IOPressureLimit
}

func (g *Gate) admitLocked(id uint64, now time.Time) {
	g.waiting = slices.DeleteFunc(g.waiting, func(waiting uint64) bool { return waiting == id })
	if g.budget.MaxStarting > 0 {
		g.starting = append(g.starting, now)
	}
}

func (g *Gate) leave(id uint64) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.waiting = slices.DeleteFunc(g.waiting, func(waiting uint64) bool { return waiting == id })
}

func sleepContext(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
