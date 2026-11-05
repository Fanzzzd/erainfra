package jobmetrics

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

var epoch = time.Unix(1_700_000_000, 0)

// steady returns readings every interval of a job using vcpus cores, memory
// bytes, and fixed traffic and disk rates per second.
func steady(at time.Time, elapsed time.Duration, vcpus float64) Reading {
	seconds := uint64(elapsed / time.Second)
	return Reading{
		At:             at,
		CPUMicros:      uint64(vcpus * float64(elapsed/time.Microsecond)),
		MemoryBytes:    gib,
		HasNetwork:     true,
		NetRxBytes:     1000 * seconds,
		NetTxBytes:     10 * seconds,
		HasDisk:        true,
		DiskReadBytes:  500 * seconds,
		DiskWriteBytes: 50 * seconds,
	}
}

func TestSeriesTurnsCumulativeReadingsIntoPerBucketUsage(t *testing.T) {
	series := NewSeries("test", 5*time.Second)
	for step := range 4 {
		elapsed := time.Duration(step) * 5 * time.Second
		series.Observe(steady(epoch.Add(elapsed), elapsed, 2))
	}
	snapshot := series.Snapshot()
	if snapshot.StartedAt != epoch.UnixMilli() || snapshot.BucketSeconds != 5 || snapshot.Samples != 4 {
		t.Fatalf("header = %+v", snapshot)
	}
	points := snapshot.Points
	if got := len(points.Offset); got != 3 {
		t.Fatalf("points = %d, want 3 intervals after the baseline", got)
	}
	for index := range points.Offset {
		if points.Offset[index] != int64(index*5) {
			t.Errorf("offset[%d] = %d", index, points.Offset[index])
		}
		if points.Ms[index] != 5000 || points.CPUMs[index] != 10_000 || points.CPUMaxMilli[index] != 2000 {
			t.Errorf("point %d: ms %d cpuMs %d cpuMax %d; want 2 vCPUs over 5 s",
				index, points.Ms[index], points.CPUMs[index], points.CPUMaxMilli[index])
		}
		if points.NetRxBytes[index] != 5000 || points.DiskWriteBytes[index] != 250 {
			t.Errorf("point %d: rx %d write %d", index, points.NetRxBytes[index], points.DiskWriteBytes[index])
		}
	}
}

func TestSeriesStaysUnderMaxPointsForASixHourJob(t *testing.T) {
	series := NewSeries("test", 5*time.Second)
	const duration = 6 * time.Hour
	spikeAt := 3*time.Hour + 35*time.Second
	var cpu uint64
	for elapsed := time.Duration(0); elapsed <= duration; elapsed += 5 * time.Second {
		reading := steady(epoch.Add(elapsed), elapsed, 1)
		// One five-second burst of all four vCPUs and one memory spike, both
		// far narrower than the final bucket.
		if elapsed > 0 {
			cpu += 1_000_000 * 5
			if elapsed == spikeAt {
				cpu += 3_000_000 * 5
			}
		}
		reading.CPUMicros = cpu
		if elapsed == spikeAt {
			reading.MemoryBytes = 7 * gib
		}
		series.Observe(reading)
		if points := len(series.buckets); points > MaxPoints {
			t.Fatalf("%d points at %s", points, elapsed)
		}
	}
	snapshot := series.Snapshot()
	points := snapshot.Points
	if snapshot.BucketSeconds != 80 {
		t.Errorf("bucket = %ds, want 80 (5 doubled until 360 buckets span 6 h)", snapshot.BucketSeconds)
	}
	if len(points.Offset) > MaxPoints || len(points.Offset) < MaxPoints/2 {
		t.Errorf("points = %d", len(points.Offset))
	}
	var covered int64
	var cpuMs, rx uint64
	var cpuMax, memMax uint64
	for index := range points.Offset {
		if index > 0 && points.Offset[index] <= points.Offset[index-1] {
			t.Fatalf("offsets not increasing at %d", index)
		}
		if points.Offset[index] >= MaxPoints*snapshot.BucketSeconds {
			t.Fatalf("offset %d beyond the bounded span", points.Offset[index])
		}
		covered += points.Ms[index]
		cpuMs += points.CPUMs[index]
		rx += points.NetRxBytes[index]
		cpuMax = max(cpuMax, points.CPUMaxMilli[index])
		memMax = max(memMax, points.MemBytes[index])
	}
	if covered != duration.Milliseconds() {
		t.Errorf("covered %d ms, want the whole job", covered)
	}
	if want := cpu / 1000; cpuMs != want {
		t.Errorf("cpuMs = %d, want %d: merging must not lose CPU time", cpuMs, want)
	}
	if want := uint64(1000 * duration / time.Second); rx != want {
		t.Errorf("rx = %d, want %d", rx, want)
	}
	if cpuMax != 4000 {
		t.Errorf("cpuMax = %d, want the 4-vCPU burst kept through every merge", cpuMax)
	}
	if memMax != 7*gib || snapshot.MemoryPeakBytes != 7*gib {
		t.Errorf("memory max %d peak %d, want the spike kept", memMax, snapshot.MemoryPeakBytes)
	}
}

func TestSeriesTreatsACounterResetAsUnknownNotAnUnderflow(t *testing.T) {
	series := NewSeries("test", 5*time.Second)
	series.Observe(Reading{At: epoch, CPUMicros: 50_000_000})
	series.Observe(Reading{At: epoch.Add(5 * time.Second), CPUMicros: 1_000})
	series.Observe(Reading{At: epoch.Add(10 * time.Second), CPUMicros: 5_001_000})
	cpu := series.Snapshot().Points.CPUMs
	if len(cpu) != 2 || cpu[0] != 0 || cpu[1] != 5000 {
		t.Errorf("cpuMs = %v, want [0 5000]", cpu)
	}
}

func TestSeriesIgnoresAReadingThatDoesNotMoveForward(t *testing.T) {
	series := NewSeries("test", 5*time.Second)
	series.Observe(Reading{At: epoch})
	series.Observe(Reading{At: epoch, CPUMicros: 10})
	series.Observe(Reading{At: epoch.Add(-time.Second), CPUMicros: 10})
	if snapshot := series.Snapshot(); snapshot.Samples != 1 || len(snapshot.Points.Offset) != 0 {
		t.Errorf("snapshot = %+v", snapshot)
	}
}

func TestSeriesCountsOOMKillsFromTheBaseline(t *testing.T) {
	series := NewSeries("test", 5*time.Second)
	series.Observe(Reading{At: epoch, HasOOM: true, OOMKills: 2})
	series.Observe(Reading{At: epoch.Add(5 * time.Second), HasOOM: true, OOMKills: 3})
	snapshot := series.Snapshot()
	if snapshot.OOMKills == nil || *snapshot.OOMKills != 1 {
		t.Errorf("oomKills = %v, want the one kill after the Attempt began", snapshot.OOMKills)
	}

	unknown := NewSeries("test", 5*time.Second)
	unknown.Observe(Reading{At: epoch})
	encoded, err := json.Marshal(unknown.Snapshot())
	if err != nil {
		t.Fatal(err)
	}
	text := string(encoded)
	if !strings.Contains(text, `"oomKills":null`) {
		t.Errorf("an unknown OOM count must encode as null, not 0: %s", text)
	}
	for _, column := range []string{"netRxBytes", "diskReadBytes"} {
		if strings.Contains(text, column) {
			t.Errorf("an unmeasured %s must be absent, not zeros: %s", column, text)
		}
	}
	if !strings.Contains(text, `"offset":[]`) {
		t.Errorf("an empty series must still carry empty columns: %s", text)
	}
}

func TestSeriesKeepsOnlyTheLastErrorBounded(t *testing.T) {
	series := NewSeries("test", 5*time.Second)
	series.RecordError(errors.New("first"))
	series.RecordError(errors.New(strings.Repeat("x", 1000)))
	snapshot := series.Snapshot()
	if snapshot.Errors != 2 || len(snapshot.LastError) != maxErrorLength {
		t.Errorf("errors %d, last error %d bytes", snapshot.Errors, len(snapshot.LastError))
	}
}

// fakeSource returns one second of one vCPU per call.
type fakeSource struct {
	mu    sync.Mutex
	calls int
	gone  bool
	err   error
}

func (*fakeSource) Kind() string { return "fake" }

func (f *fakeSource) Read(now time.Time) (Reading, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.gone {
		return Reading{}, ErrGone
	}
	if f.err != nil {
		return Reading{}, f.err
	}
	f.calls++
	return Reading{At: epoch.Add(time.Duration(f.calls) * time.Second), CPUMicros: uint64(f.calls) * 1_000_000}, nil
}

func TestSamplerNeverCountsTheBoundaryEndingAsAnError(t *testing.T) {
	source := &fakeSource{}
	sampler := StartSampler(t.Context(), source, time.Hour)
	source.mu.Lock()
	source.gone = true
	source.mu.Unlock()
	sampler.Stop()
	sampler.Stop()
	snapshot := sampler.Snapshot()
	if snapshot.Samples != 1 || snapshot.Errors != 0 {
		t.Errorf("samples %d errors %d", snapshot.Samples, snapshot.Errors)
	}

	failing := &fakeSource{err: errors.New("permission denied")}
	broken := startSampler(t.Context(), failing, 5*time.Millisecond, time.Now)
	time.Sleep(30 * time.Millisecond)
	broken.Stop()
	if snapshot := broken.Snapshot(); snapshot.Errors == 0 || snapshot.LastError != "permission denied" {
		t.Errorf("a real failure must be counted: %+v", snapshot)
	}
}

func TestRegistryKeepsAFinishedAttemptsFinalSnapshot(t *testing.T) {
	registry := NewRegistry(time.Hour)
	if _, _, ok := registry.Snapshot("missing"); ok {
		t.Fatal("an unknown Attempt must not be found")
	}
	registry.Start("attempt-1", &fakeSource{})
	if snapshot, live, ok := registry.Snapshot("attempt-1"); !ok || !live || snapshot.Samples != 1 {
		t.Fatalf("live snapshot = %+v live=%v ok=%v", snapshot, live, ok)
	}
	registry.Finish("attempt-1")
	registry.Finish("attempt-1")
	snapshot, live, ok := registry.Snapshot("attempt-1")
	if !ok || live {
		t.Fatalf("finished snapshot live=%v ok=%v", live, ok)
	}
	if snapshot.Samples != 2 || len(snapshot.Points.CPUMs) != 1 || snapshot.Points.CPUMs[0] != 1000 {
		t.Errorf("Finish must take a closing reading: %+v", snapshot)
	}

	registry.now = func() time.Time { return time.Now().Add(finishedRetention + time.Minute) }
	if _, _, ok := registry.Snapshot("attempt-1"); ok {
		t.Error("a finished Snapshot must expire")
	}
}

func TestRegistryBoundsTheFinishedSet(t *testing.T) {
	registry := NewRegistry(time.Hour)
	for index := range maxFinished + 10 {
		id := "attempt-" + string(rune('a'+index%26)) + string(rune('a'+index/26))
		registry.Start(id, &fakeSource{})
		registry.Finish(id)
	}
	if len(registry.finished) != maxFinished || len(registry.order) != maxFinished {
		t.Errorf("finished = %d, order = %d, want %d", len(registry.finished), len(registry.order), maxFinished)
	}
	if _, _, ok := registry.Snapshot("attempt-aa"); ok {
		t.Error("the oldest finished Attempt must be evicted first")
	}
	registry.Shutdown()
}

func TestWriteReportsSkipsUnchangedSnapshotsAndEndsWithAFinalLine(t *testing.T) {
	var mu sync.Mutex
	samples := uint64(0)
	collect := func(context.Context) (Snapshot, bool) {
		mu.Lock()
		defer mu.Unlock()
		if samples == 0 {
			return Snapshot{}, false
		}
		return Snapshot{Samples: samples}, true
	}
	var output strings.Builder
	var outputMu sync.Mutex
	writer := writerFunc(func(p []byte) (int, error) {
		outputMu.Lock()
		defer outputMu.Unlock()
		return output.Write(p)
	})
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() { done <- WriteReports(ctx, writer, 5*time.Millisecond, collect) }()
	time.Sleep(20 * time.Millisecond)
	mu.Lock()
	samples = 3
	mu.Unlock()
	time.Sleep(40 * time.Millisecond)
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(output.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("lines = %q, want one report for the change and one final", lines)
	}
	var first, final Report
	if err := json.Unmarshal([]byte(lines[0]), &first); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(lines[1]), &final); err != nil {
		t.Fatal(err)
	}
	if first.Final || first.Snapshot.Samples != 3 || !final.Final || final.Snapshot.Samples != 3 {
		t.Errorf("first %+v final %+v", first, final)
	}
}

type writerFunc func([]byte) (int, error)

func (f writerFunc) Write(p []byte) (int, error) { return f(p) }
