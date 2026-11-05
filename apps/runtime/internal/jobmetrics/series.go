package jobmetrics

import (
	"time"
)

const (
	// MaxPoints bounds a Series however long its Attempt runs. 360 points
	// draw a chart at one point per two pixels on a wide screen, and keep the
	// document the Worker uploads near 30 KiB.
	MaxPoints = 360
	// DefaultSampleInterval is how often a boundary is read. Every reading is
	// a handful of small procfs or cgroupfs files, so five seconds costs the
	// job nothing measurable and still shows a burst a few seconds long.
	DefaultSampleInterval = 5 * time.Second
	// SnapshotVersion changes when the Snapshot document changes shape.
	SnapshotVersion = 1
	maxErrorLength  = 200
)

// bucket accumulates every interval that ended inside it.
type bucket struct {
	index       int64
	coveredMs   int64
	cpuMicros   uint64
	cpuMaxMilli uint64
	memMax      uint64
	netRx       uint64
	netTx       uint64
	diskRead    uint64
	diskWrite   uint64
}

// Series is the bounded history of one Attempt.
//
// Buckets start as wide as the sample interval. When the Attempt outlives
// MaxPoints buckets, every bucket doubles in width and adjacent pairs merge,
// so a ten-minute job keeps five-second resolution and a six-hour job ends
// with 80-second buckets, both under MaxPoints. Merging keeps what each
// metric means: CPU time, traffic and disk bytes add up, memory keeps its
// maximum, and the fastest single interval's CPU rate survives as cpuMax so
// a short spike is not averaged away.
type Series struct {
	source         string
	sampleInterval time.Duration
	width          time.Duration
	start          time.Time
	first          *Reading
	previous       *Reading
	buckets        []bucket
	memoryPeak     uint64
	hasNetwork     bool
	hasDisk        bool
	hasOOM         bool
	oomKills       uint64
	samples        uint64
	errors         uint64
	lastError      string
}

func NewSeries(source string, sampleInterval time.Duration) *Series {
	if sampleInterval < time.Second {
		sampleInterval = time.Second
	}
	sampleInterval = sampleInterval.Truncate(time.Second)
	return &Series{source: source, sampleInterval: sampleInterval, width: sampleInterval}
}

// Observe folds one reading in. The first reading is the baseline: usage is
// always the difference between two readings, so whatever a warm microVM
// spent before its claim is not charged to the Attempt.
func (s *Series) Observe(reading Reading) {
	if s.previous == nil {
		s.first, s.previous = &reading, &reading
		s.start = reading.At
		s.samples = 1
		s.absorbLevels(reading)
		return
	}
	previous := *s.previous
	interval := reading.At.Sub(previous.At)
	if interval <= 0 {
		return
	}
	s.previous = &reading
	s.samples++
	s.absorbLevels(reading)

	index := s.indexFor(reading.At)
	for index >= MaxPoints {
		s.compact()
		index = s.indexFor(reading.At)
	}
	if len(s.buckets) == 0 || s.buckets[len(s.buckets)-1].index != index {
		s.buckets = append(s.buckets, bucket{index: index})
	}
	current := &s.buckets[len(s.buckets)-1]
	current.coveredMs += interval.Milliseconds()
	cpu := delta(reading.CPUMicros, previous.CPUMicros)
	current.cpuMicros += cpu
	if micros := interval.Microseconds(); micros > 0 {
		current.cpuMaxMilli = max(current.cpuMaxMilli, cpu*1000/uint64(micros))
	}
	current.memMax = max(current.memMax, reading.MemoryBytes)
	if reading.HasNetwork && previous.HasNetwork {
		current.netRx += delta(reading.NetRxBytes, previous.NetRxBytes)
		current.netTx += delta(reading.NetTxBytes, previous.NetTxBytes)
	}
	if reading.HasDisk && previous.HasDisk {
		current.diskRead += delta(reading.DiskReadBytes, previous.DiskReadBytes)
		current.diskWrite += delta(reading.DiskWriteBytes, previous.DiskWriteBytes)
	}
}

// RecordError counts a failed reading. A Series with errors is still a
// Series: the readings around the failure carry the usage across it.
func (s *Series) RecordError(err error) {
	s.errors++
	message := err.Error()
	if len(message) > maxErrorLength {
		message = message[:maxErrorLength]
	}
	s.lastError = message
}

func (s *Series) absorbLevels(reading Reading) {
	s.memoryPeak = max(s.memoryPeak, reading.MemoryBytes, reading.MemoryPeakBytes)
	s.hasNetwork = s.hasNetwork || reading.HasNetwork
	s.hasDisk = s.hasDisk || reading.HasDisk
	if reading.HasOOM {
		s.hasOOM = true
		var baseline uint64
		if s.first.HasOOM {
			baseline = s.first.OOMKills
		}
		s.oomKills = max(s.oomKills, delta(reading.OOMKills, baseline))
	}
}

func (s *Series) indexFor(at time.Time) int64 {
	// An interval belongs to the bucket it ends in; one nanosecond back puts
	// an interval ending exactly on a boundary in the bucket it filled.
	return int64(at.Sub(s.start)-1) / int64(s.width)
}

func (s *Series) compact() {
	s.width *= 2
	merged := s.buckets[:0]
	for _, current := range s.buckets {
		current.index /= 2
		if n := len(merged); n > 0 && merged[n-1].index == current.index {
			last := &merged[n-1]
			last.coveredMs += current.coveredMs
			last.cpuMicros += current.cpuMicros
			last.cpuMaxMilli = max(last.cpuMaxMilli, current.cpuMaxMilli)
			last.memMax = max(last.memMax, current.memMax)
			last.netRx += current.netRx
			last.netTx += current.netTx
			last.diskRead += current.diskRead
			last.diskWrite += current.diskWrite
			continue
		}
		merged = append(merged, current)
	}
	s.buckets = merged
}

// delta is the growth of a cumulative counter. A counter that went backwards
// was reset underneath us, and the honest usage for that interval is unknown;
// zero is reported rather than an underflow.
func delta(current uint64, previous uint64) uint64 {
	if current < previous {
		return 0
	}
	return current - previous
}

// Snapshot is the document a Worker uploads for an Attempt. Points are
// columns rather than rows: nine arrays of 360 numbers are about half the
// JSON of 360 objects naming nine keys each.
type Snapshot struct {
	Version       int    `json:"version"`
	Source        string `json:"source"`
	StartedAt     int64  `json:"startedAt"`
	SampleSeconds int64  `json:"sampleSeconds"`
	BucketSeconds int64  `json:"bucketSeconds"`
	// Samples counts successful readings. It only grows, so it doubles as
	// the upload's sequence number: the control plane keeps the snapshot with
	// the most samples and ignores a replay or a late, older upload.
	Samples         uint64  `json:"samples"`
	Errors          uint64  `json:"errors"`
	LastError       string  `json:"lastError,omitempty"`
	MemoryPeakBytes uint64  `json:"memoryPeakBytes"`
	OOMKills        *uint64 `json:"oomKills"`
	Points          Points  `json:"points"`
}

// Points holds one entry per bucket in every array.
type Points struct {
	// Offset is the bucket's start, in seconds after StartedAt.
	Offset []int64 `json:"offset"`
	// Ms is how much wall-clock time the bucket's readings covered. The last
	// bucket is usually partial, and a gap in sampling leaves one short.
	Ms []int64 `json:"ms"`
	// CPUMs is CPU time consumed in the bucket; CPUMs/Ms is vCPUs in use.
	CPUMs []uint64 `json:"cpuMs"`
	// CPUMaxMilli is the busiest single sample interval in the bucket, in
	// thousandths of a vCPU.
	CPUMaxMilli []uint64 `json:"cpuMaxMilli"`
	// MemBytes is the highest memory reading in the bucket.
	MemBytes       []uint64 `json:"memBytes"`
	NetRxBytes     []uint64 `json:"netRxBytes,omitempty"`
	NetTxBytes     []uint64 `json:"netTxBytes,omitempty"`
	DiskReadBytes  []uint64 `json:"diskReadBytes,omitempty"`
	DiskWriteBytes []uint64 `json:"diskWriteBytes,omitempty"`
}

func (s *Series) Snapshot() Snapshot {
	snapshot := Snapshot{
		Version:         SnapshotVersion,
		Source:          s.source,
		SampleSeconds:   int64(s.sampleInterval / time.Second),
		BucketSeconds:   int64(s.width / time.Second),
		Samples:         s.samples,
		Errors:          s.errors,
		LastError:       s.lastError,
		MemoryPeakBytes: s.memoryPeak,
	}
	if !s.start.IsZero() {
		snapshot.StartedAt = s.start.UnixMilli()
	}
	if s.hasOOM {
		kills := s.oomKills
		snapshot.OOMKills = &kills
	}
	count := len(s.buckets)
	points := Points{
		Offset:      make([]int64, 0, count),
		Ms:          make([]int64, 0, count),
		CPUMs:       make([]uint64, 0, count),
		CPUMaxMilli: make([]uint64, 0, count),
		MemBytes:    make([]uint64, 0, count),
	}
	if s.hasNetwork {
		points.NetRxBytes = make([]uint64, 0, count)
		points.NetTxBytes = make([]uint64, 0, count)
	}
	if s.hasDisk {
		points.DiskReadBytes = make([]uint64, 0, count)
		points.DiskWriteBytes = make([]uint64, 0, count)
	}
	for _, current := range s.buckets {
		points.Offset = append(points.Offset, current.index*snapshot.BucketSeconds)
		points.Ms = append(points.Ms, current.coveredMs)
		points.CPUMs = append(points.CPUMs, (current.cpuMicros+500)/1000)
		points.CPUMaxMilli = append(points.CPUMaxMilli, current.cpuMaxMilli)
		points.MemBytes = append(points.MemBytes, current.memMax)
		if s.hasNetwork {
			points.NetRxBytes = append(points.NetRxBytes, current.netRx)
			points.NetTxBytes = append(points.NetTxBytes, current.netTx)
		}
		if s.hasDisk {
			points.DiskReadBytes = append(points.DiskReadBytes, current.diskRead)
			points.DiskWriteBytes = append(points.DiskWriteBytes, current.diskWrite)
		}
	}
	snapshot.Points = points
	return snapshot
}
