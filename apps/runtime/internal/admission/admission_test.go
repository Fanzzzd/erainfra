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

func constant(value float64) Pressure { return func() (float64, error) { return value, nil } }

func TestAnAttemptUnderBudgetStartsAtOnce(t *testing.T) {
	c := newClock()
	g := gate(t, DefaultBudget(), constant(5), c)
	decision, err := g.Admit(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if decision != (Decision{}) {
		t.Fatalf("decision = %+v, want an immediate start", decision)
	}
}

func TestTheThirdAttemptWaitsForAStartWindowToEnd(t *testing.T) {
	c := newClock()
	g := gate(t, DefaultBudget(), constant(5), c)
	for range 2 {
		if _, err := g.Admit(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if state := g.State(); state.Starting != 2 || !state.OverBudget {
		t.Fatalf("state after two starts = %+v, want 2 starting and over budget", state)
	}
	decision, err := g.Admit(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	want := Decision{Held: 60 * time.Second, Reason: ReasonStarting}
	if decision != want {
		t.Fatalf("decision = %+v, want %+v", decision, want)
	}
}

func TestIOPressureHoldsAStartUntilItDrops(t *testing.T) {
	c := newClock()
	start := c.Now()
	// 55% for the first 40 s, the burst ubuntu0 saw at 06:08 on 2026-11-12, then 12%.
	pressure := func() (float64, error) {
		if c.since(start) < 40*time.Second {
			return 55, nil
		}
		return 12, nil
	}
	g := gate(t, DefaultBudget(), pressure, c)
	decision, err := g.Admit(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	want := Decision{Held: 40 * time.Second, Reason: ReasonIOPressure}
	if decision != want {
		t.Fatalf("decision = %+v, want %+v", decision, want)
	}
}

func TestMaxHoldStartsTheAttemptOverBudget(t *testing.T) {
	c := newClock()
	g := gate(t, DefaultBudget(), constant(80), c)
	decision, err := g.Admit(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	want := Decision{Held: 120 * time.Second, Reason: ReasonIOPressure, Forced: true}
	if decision != want {
		t.Fatalf("decision = %+v, want %+v", decision, want)
	}
	if state := g.State(); state.Held != 0 || state.Starting != 1 {
		t.Fatalf("state = %+v, want the forced Attempt counted as starting", state)
	}
}

func TestACanceledAttemptLeavesTheLine(t *testing.T) {
	c := newClock()
	g := gate(t, DefaultBudget(), constant(80), c)
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
	g := gate(t, DefaultBudget(), constant(5), c)
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
	g := gate(t, DefaultBudget(), func() (float64, error) { return 0, os.ErrNotExist }, c)
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
	g := gate(t, Budget{}, constant(99), c)
	for range 5 {
		decision, err := g.Admit(context.Background())
		if err != nil || decision != (Decision{}) {
			t.Fatalf("decision = %+v, %v; want an immediate start", decision, err)
		}
	}
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

func TestParseSomeAvg10(t *testing.T) {
	for _, row := range []struct {
		content string
		want    float64
		fails   bool
	}{
		{content: "some avg10=4.03 avg60=6.77 avg300=10.64 total=5945908642\nfull avg10=4.02 avg60=6.71 avg300=10.18 total=5720730406\n", want: 4.03},
		{content: "full avg10=1.00 avg60=0 avg300=0 total=1\nsome avg10=58.10 avg60=40 avg300=20 total=2\n", want: 58.1},
		{content: "some avg60=6.77 total=1\n", fails: true},
		{content: "some avg10=abc\n", fails: true},
		{content: "", fails: true},
	} {
		got, err := ParseSomeAvg10(row.content)
		if row.fails {
			if err == nil {
				t.Errorf("ParseSomeAvg10(%q) = %g, want an error", row.content, got)
			}
			continue
		}
		if err != nil || got != row.want {
			t.Errorf("ParseSomeAvg10(%q) = %g, %v; want %g", row.content, got, err, row.want)
		}
	}
}

// The Action Runner Agent forwards State in its heartbeat and the control plane validates it.
// Both read this file in their tests, so a renamed field fails there. Regenerate it with
// ERAINFRA_UPDATE_GOLDEN=1 go test ./apps/runtime/internal/admission/.
func TestStateJSONMatchesTheGoldenFileTheAgentAndControlPlaneRead(t *testing.T) {
	c := newClock()
	g := gate(t, DefaultBudget(), constant(41.5), c)
	g.waiting = []uint64{9}
	g.starting = []time.Time{c.Now().Add(30 * time.Second), c.Now().Add(50 * time.Second)}
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
