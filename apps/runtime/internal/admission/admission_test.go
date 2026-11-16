package admission

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/Fanzzzd/erainfra/internal/golden"
)

// clock is a fake time source. Sleep advances it, so a waiting Attempt moves time forward the
// way a real one would.
type clock struct {
	mu  sync.Mutex
	now time.Time
}

func newClock() *clock { return &clock{now: time.Date(2026, 11, 12, 6, 0, 0, 0, time.UTC)} }

func (c *clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *clock) Sleep(ctx context.Context, d time.Duration) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	c.mu.Lock()
	c.now = c.now.Add(d)
	c.mu.Unlock()
	return nil
}

func (c *clock) since(start time.Time) time.Duration { return c.Now().Sub(start) }

func gate(t *testing.T, budget Budget, pressure Pressure, c *clock) *Gate {
	t.Helper()
	g, err := New(budget, pressure, Options{Now: c.Now, Sleep: c.Sleep, Poll: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	return g
}

// disk is a host whose io "some" stall share at each moment is rate(elapsed). It integrates the
// rate into the kernel's cumulative counter in 100 ms steps and reports the rate as avg10, so a
// reading looks like /proc/pressure/io at that moment.
type disk struct {
	c     *clock
	start time.Time
	rate  func(elapsed time.Duration) float64
}

func newDisk(c *clock, rate func(time.Duration) float64) *disk {
	return &disk{c: c, start: c.Now(), rate: rate}
}

func (d *disk) read() (PSI, error) {
	elapsed := d.c.since(d.start)
	var total time.Duration
	for at := time.Duration(0); at < elapsed; at += 100 * time.Millisecond {
		step := min(100*time.Millisecond, elapsed-at)
		total += time.Duration(float64(step) * d.rate(at) / 100)
	}
	return PSI{Avg10: d.rate(elapsed), Total: total}, nil
}

func constant(c *clock, percent float64) Pressure {
	return newDisk(c, func(time.Duration) float64 { return percent }).read
}

func admitAtOnce(t *testing.T, g *Gate, n int) {
	t.Helper()
	for i := range n {
		decision, err := g.Admit(context.Background())
		if err != nil || decision != (Decision{}) {
			t.Fatalf("Attempt %d: decision = %+v, %v; want an immediate start", i+1, decision, err)
		}
	}
}

func TestABurstOnAQuietDiskStartsAtOnce(t *testing.T) {
	c := newClock()
	g := gate(t, DefaultBudget(), constant(c, 4), c)
	// payable's usual push is six jobs at once; the largest burst on 2026-11-13 to 16 was eight.
	admitAtOnce(t, g, 8)
	if state := g.State(); state.Starting != 8 || state.MaxStarting != 8 || !state.OverBudget {
		t.Fatalf("state after eight starts = %+v, want 8 starting in a window of 8", state)
	}
}

func TestAnAttemptPastTheWindowWaitsForAStartWindowToEnd(t *testing.T) {
	c := newClock()
	g := gate(t, DefaultBudget(), constant(c, 4), c)
	admitAtOnce(t, g, 8)
	decision, err := g.Admit(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if want := (Decision{Held: 60 * time.Second, Reason: ReasonStarting}); decision != want {
		t.Fatalf("decision = %+v, want %+v", decision, want)
	}
}

// 55% for the first 40 s, the burst ubuntu0 saw at 06:08 on 2026-11-12, then 12%.
func burstThenQuiet(c *clock) Pressure {
	return newDisk(c, func(elapsed time.Duration) float64 {
		if elapsed < 40*time.Second {
			return 55
		}
		return 12
	}).read
}

func TestCongestionHoldsAStartUntilTheMeasuredStallDrops(t *testing.T) {
	c := newClock()
	g := gate(t, DefaultBudget(), burstThenQuiet(c), c)
	decision, err := g.Admit(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	// The share over the second after the burst ends is 12%, so the start goes at 41 s; avg10
	// would have stayed over 30% for several more seconds.
	if want := (Decision{Held: 41 * time.Second, Reason: ReasonIOPressure}); decision != want {
		t.Fatalf("decision = %+v, want %+v", decision, want)
	}
}

func TestCongestionHalvesTheWindowOncePerStartWindow(t *testing.T) {
	c := newClock()
	g := gate(t, DefaultBudget(), burstThenQuiet(c), c)
	for range 30 { // 30 s of readings, all congested
		g.State()
		_ = c.Sleep(context.Background(), time.Second)
	}
	if state := g.State(); state.MaxStarting != 4 {
		t.Fatalf("window after 30 s of congestion = %d, want 8 halved once to 4", state.MaxStarting)
	}
}

func TestQuietStartWindowsGrowTheWindowBack(t *testing.T) {
	c := newClock()
	g := gate(t, DefaultBudget(), burstThenQuiet(c), c)
	if _, err := g.Admit(context.Background()); err != nil { // waits out the burst; window 4
		t.Fatal(err)
	}
	admitAtOnce(t, g, 3) // the window is full again with these
	if _, err := g.Admit(context.Background()); err != nil {
		t.Fatal(err)
	}
	// The first four started after the burst, so each finished start window grows the window.
	_ = c.Sleep(context.Background(), 60*time.Second)
	if state := g.State(); state.MaxStarting != 8 {
		t.Fatalf("window after quiet start windows = %d, want it grown back to 8", state.MaxStarting)
	}
}

func TestAStartAdmittedDuringCongestionDoesNotGrowTheWindow(t *testing.T) {
	c := newClock()
	budget := DefaultBudget()
	budget.MaxHold = 0 // start at once, over budget
	g := gate(t, budget, constant(c, 80), c)
	decision, err := g.Admit(context.Background())
	if err != nil || !decision.Forced {
		t.Fatalf("decision = %+v, %v; want a forced start", decision, err)
	}
	_ = c.Sleep(context.Background(), 61*time.Second)
	if state := g.State(); state.MaxStarting != 2 {
		t.Fatalf("window = %d, want 8 halved twice to 2 and never grown", state.MaxStarting)
	}
}

func TestTheShareIsMeasuredFromTheCounterAndAvg10OnlyWithoutARecentReading(t *testing.T) {
	c := newClock()
	readings := []PSI{
		{Avg10: 20, Total: 100 * time.Second},                      // first: avg10
		{Avg10: 20, Total: 100*time.Second + 500*time.Millisecond}, // 2 s later: 25%
		{Avg10: 20, Total: 100*time.Second + 600*time.Millisecond}, // 0.5 s later: too soon, still 25%
		{Avg10: 7, Total: 200 * time.Second},                       // 20 s later: stale, avg10
	}
	waits := []time.Duration{0, 2 * time.Second, 500 * time.Millisecond, 20 * time.Second}
	want := []float64{20, 25, 25, 7}
	next := 0
	g := gate(t, DefaultBudget(), func() (PSI, error) { return readings[next], nil }, c)
	for i := range readings {
		next = i
		_ = c.Sleep(context.Background(), waits[i])
		if got := g.State().IOSomeAvg10; got != want[i] {
			t.Errorf("reading %d: share = %g, want %g", i+1, got, want[i])
		}
	}
}

func TestMaxHoldStartsTheAttemptOverBudget(t *testing.T) {
	c := newClock()
	g := gate(t, DefaultBudget(), constant(c, 80), c)
	decision, err := g.Admit(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if want := (Decision{Held: 120 * time.Second, Reason: ReasonIOPressure, Forced: true}); decision != want {
		t.Fatalf("decision = %+v, want %+v", decision, want)
	}
	if state := g.State(); state.Held != 0 || state.Starting != 1 {
		t.Fatalf("state = %+v, want the forced Attempt counted as starting", state)
	}
}

func TestACanceledAttemptLeavesTheLine(t *testing.T) {
	c := newClock()
	g := gate(t, DefaultBudget(), constant(c, 80), c)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := g.Admit(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("Admit error = %v, want context.Canceled", err)
	}
	if state := g.State(); state.Held != 0 || state.Starting != 0 {
		t.Fatalf("state = %+v, want nothing held or starting", state)
	}
}

func TestOnlyTheFirstWaitingAttemptMayStart(t *testing.T) {
	c := newClock()
	g := gate(t, DefaultBudget(), constant(c, 5), c)
	g.waiting = []uint64{7, 8}
	if got := g.blockedLocked(8, c.Now()); got != ReasonQueued {
		t.Fatalf("second in line blocked by %q, want %q", got, ReasonQueued)
	}
	if got := g.blockedLocked(7, c.Now()); got != "" {
		t.Fatalf("first in line blocked by %q, want nothing", got)
	}
}

func TestUnknownPressureHoldsNothing(t *testing.T) {
	c := newClock()
	g := gate(t, DefaultBudget(), func() (PSI, error) { return PSI{}, os.ErrNotExist }, c)
	decision, err := g.Admit(context.Background())
	if err != nil || decision != (Decision{}) {
		t.Fatalf("decision = %+v, %v; want an immediate start", decision, err)
	}
	if state := g.State(); state.PressureKnown {
		t.Fatalf("state = %+v, want pressure unknown", state)
	}
}

func TestZeroLimitsHoldNothing(t *testing.T) {
	c := newClock()
	g := gate(t, Budget{}, constant(c, 99), c)
	admitAtOnce(t, g, 5)
	if state := g.State(); state.OverBudget {
		t.Fatalf("state = %+v, want an unlimited budget never over", state)
	}
}

func TestBudgetValidation(t *testing.T) {
	for _, budget := range []Budget{
		{MaxStarting: -1},
		{MaxStarting: 2},
		{IOPressureLimit: 101},
		{IOPressureLimit: -1},
		{MaxHold: -time.Second},
	} {
		if err := budget.Validate(); err == nil {
			t.Errorf("Validate(%+v) = nil, want an error", budget)
		}
	}
	if err := DefaultBudget().Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestParseSome(t *testing.T) {
	for _, row := range []struct {
		content string
		want    PSI
		fails   bool
	}{
		{content: "some avg10=4.03 avg60=6.77 avg300=10.64 total=5945908642\nfull avg10=4.02 avg60=6.71 avg300=10.18 total=5720730406\n", want: PSI{Avg10: 4.03, Total: 5945908642 * time.Microsecond}},
		{content: "full avg10=1.00 avg60=0 avg300=0 total=1\nsome avg10=58.10 avg60=40 avg300=20 total=2\n", want: PSI{Avg10: 58.1, Total: 2 * time.Microsecond}},
		{content: "some avg60=6.77 total=1\n", fails: true},
		{content: "some avg10=1.00 avg60=6.77\n", fails: true},
		{content: "some avg10=abc total=1\n", fails: true},
		{content: "some avg10=1.00 total=-5\n", fails: true},
		{content: "", fails: true},
	} {
		got, err := ParseSome(row.content)
		if row.fails {
			if err == nil {
				t.Errorf("ParseSome(%q) = %+v, want an error", row.content, got)
			}
			continue
		}
		if err != nil || got != row.want {
			t.Errorf("ParseSome(%q) = %+v, %v; want %+v", row.content, got, err, row.want)
		}
	}
}

// The Action Runner Agent forwards State in its heartbeat and the control plane validates it.
// Both read this file in their tests, so a renamed field fails there. Regenerate it with
// ERAINFRA_UPDATE_GOLDEN=1 go test ./apps/runtime/internal/admission/.
func TestStateJSONMatchesTheGoldenFileTheAgentAndControlPlaneRead(t *testing.T) {
	c := newClock()
	g := gate(t, DefaultBudget(), constant(c, 41.5), c)
	g.waiting = []uint64{9}
	g.starting = []time.Time{c.Now().Add(-30 * time.Second), c.Now().Add(-10 * time.Second)}
	encoded, err := json.MarshalIndent(g.State(), "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	encoded = append(encoded, '\n')
	golden.Check(
		t,
		filepath.Join("..", "..", "..", "..", "testdata", "admission-state.golden.json"),
		encoded,
		"the Action Runner Agent's and the control plane's tests",
	)
}
