// Package admission holds an Attempt's start while its Worker is over the start budget.
//
// A Worker's disk is shared by every guest on it. When several Attempts start at once, their
// boots, checkouts and installs land on the disk together and every job on the Worker slows,
// including the ones already running. The Gate spaces starts out: an Attempt waits while too
// many others are still in their start window, or while the host's I/O pressure is at or above
// the limit. The wait is bounded, because a job routed to this Worker has nowhere else to go;
// past MaxHold the start goes ahead anyway. The control plane reads State to route new jobs
// elsewhere while the Worker is over budget.
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
	// MaxStarting is how many Attempts may be inside their start window at once. 0 means no
	// limit.
	MaxStarting int
	// StartWindow is how long an admitted Attempt counts as starting: the stretch in which its
	// boot, checkout and dependency install load the disk.
	StartWindow time.Duration
	// IOPressureLimit is the host's io "some" avg10 percentage at or above which starts wait.
	// 0 means pressure does not hold starts.
	IOPressureLimit float64
	// MaxHold is the longest an Attempt waits before it starts anyway.
	MaxHold time.Duration
}

// DefaultBudget fits a Worker whose guests share one spinning-disk array. On ubuntu0 one or two
// starting guests keep io "some" under 25%; six starting together hold it at 40 to 60% for
// minutes.
func DefaultBudget() Budget {
	return Budget{MaxStarting: 2, StartWindow: 60 * time.Second, IOPressureLimit: 30, MaxHold: 120 * time.Second}
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
	ReasonStarting   = "starting"    // MaxStarting Attempts are inside their start window
	ReasonIOPressure = "io-pressure" // the host's I/O pressure is at or above the limit
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
	MaxStarting        int     `json:"maxStarting"`
	StartWindowSeconds int     `json:"startWindowSeconds"`
	IOPressureLimit    float64 `json:"ioPressureLimit"`
	MaxHoldSeconds     int     `json:"maxHoldSeconds"`
	// Starting is how many admitted Attempts are still inside their start window.
	Starting int `json:"starting"`
	// Held is how many Attempts are waiting to start.
	Held int `json:"held"`
	// IOSomeAvg10 is the host's io "some" avg10 percentage. PressureKnown is false when the
	// kernel does not expose it, and then pressure holds nothing.
	IOSomeAvg10   float64 `json:"ioSomeAvg10"`
	PressureKnown bool    `json:"pressureKnown"`
	// OverBudget is true when a new Attempt arriving now would wait.
	OverBudget bool `json:"overBudget"`
}

// Pressure returns the host's io "some" avg10 percentage.
type Pressure func() (float64, error)

// Options lets tests replace the clock and the wait between checks.
type Options struct {
	Now   func() time.Time
	Sleep func(ctx context.Context, d time.Duration) error
	// Poll is how often a waiting Attempt checks again. The kernel updates avg10 every 2 s.
	Poll time.Duration
}

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
	starting []time.Time // when each admitted Attempt leaves its start window
}

// New returns a Gate for budget. pressure may be nil, which means pressure is unknown.
func New(budget Budget, pressure Pressure, options Options) (*Gate, error) {
	if err := budget.Validate(); err != nil {
		return nil, err
	}
	gate := &Gate{budget: budget, pressure: pressure, now: options.Now, sleep: options.Sleep, poll: options.Poll}
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
	ioSome, known := g.readPressure()
	g.mu.Lock()
	defer g.mu.Unlock()
	starting := g.startingLocked(g.now())
	return State{
		MaxStarting:        g.budget.MaxStarting,
		StartWindowSeconds: int(g.budget.StartWindow / time.Second),
		IOPressureLimit:    g.budget.IOPressureLimit,
		MaxHoldSeconds:     int(g.budget.MaxHold / time.Second),
		Starting:           starting,
		Held:               len(g.waiting),
		IOSomeAvg10:        ioSome,
		PressureKnown:      known,
		OverBudget: len(g.waiting) > 0 ||
			(g.budget.MaxStarting > 0 && starting >= g.budget.MaxStarting) ||
			g.overPressure(ioSome, known),
	}
}

// blockedLocked names what keeps Attempt id from starting at now, or "" when nothing does.
// The head of the line is the only Attempt that may start, so a held Attempt that times out
// cannot be overtaken by one that arrived later.
func (g *Gate) blockedLocked(id uint64, now time.Time) string {
	if g.waiting[0] != id {
		return ReasonQueued
	}
	if g.budget.MaxStarting > 0 && g.startingLocked(now) >= g.budget.MaxStarting {
		return ReasonStarting
	}
	if ioSome, known := g.readPressure(); g.overPressure(ioSome, known) {
		return ReasonIOPressure
	}
	return ""
}

func (g *Gate) overPressure(ioSome float64, known bool) bool {
	return known && g.budget.IOPressureLimit > 0 && ioSome >= g.budget.IOPressureLimit
}

func (g *Gate) admitLocked(id uint64, now time.Time) {
	g.waiting = slices.DeleteFunc(g.waiting, func(waiting uint64) bool { return waiting == id })
	if g.budget.MaxStarting > 0 {
		g.starting = append(g.starting, now.Add(g.budget.StartWindow))
	}
}

// startingLocked drops start windows that have ended and counts the rest.
func (g *Gate) startingLocked(now time.Time) int {
	g.starting = slices.DeleteFunc(g.starting, func(ends time.Time) bool { return !now.Before(ends) })
	return len(g.starting)
}

func (g *Gate) leave(id uint64) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.waiting = slices.DeleteFunc(g.waiting, func(waiting uint64) bool { return waiting == id })
}

func (g *Gate) readPressure() (float64, bool) {
	if g.pressure == nil {
		return 0, false
	}
	value, err := g.pressure()
	if err != nil {
		return 0, false
	}
	return value, true
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
