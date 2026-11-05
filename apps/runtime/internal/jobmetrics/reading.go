// Package jobmetrics measures what one Attempt's boundary consumed: CPU,
// memory, network and disk over the job, read on the host from counters the
// kernel keeps for the boundary. Nothing here asks the guest or the container
// for a number. A job that owns its guest kernel can make any in-guest counter
// say anything; the VMM process, its tap device and a container's cgroup are
// outside its reach.
//
// The pieces are a Source (one cumulative reading of a boundary), a Series
// (a bounded, downsampled history of the deltas between readings) and a
// Sampler (the goroutine that reads a Source every few seconds into a Series).
// The runtime service owns a Registry of Samplers for its microVMs; the
// `runner-center-runtime sample` command runs one Sampler for a Docker
// container. Both hand the Worker the same Snapshot document.
package jobmetrics

import (
	"errors"
	"io/fs"
	"os"
	"time"
)

// ErrGone is what a Source returns once the process it measures has exited.
// It ends a boundary's history and is not a failure: every Attempt's last
// reading attempt meets it.
var ErrGone = errors.New("the measured process has exited")

// processGone reports whether /proc has stopped listing the process.
func processGone(procDir string) bool {
	_, err := os.Stat(procDir)
	return errors.Is(err, fs.ErrNotExist)
}

// Reading is one cumulative measurement of a boundary. Every counter only
// grows for the life of the boundary; the Series turns two consecutive
// readings into the usage between them.
type Reading struct {
	At time.Time
	// CPUMicros is CPU time consumed by everything in the boundary, all
	// threads and all cores, in microseconds.
	CPUMicros uint64
	// MemoryBytes is the boundary's resident memory at At.
	MemoryBytes uint64
	// MemoryPeakBytes is the kernel's own high-water mark, which catches a
	// spike between two readings. Zero when the kernel does not keep one.
	MemoryPeakBytes uint64
	// HasNetwork is false when the boundary's network device could not be
	// identified; the network fields are then meaningless.
	HasNetwork bool
	// NetRxBytes is traffic delivered into the boundary, NetTxBytes traffic
	// it sent, both seen from the job's side.
	NetRxBytes uint64
	NetTxBytes uint64
	// HasDisk is false when no block I/O counter was readable.
	HasDisk        bool
	DiskReadBytes  uint64
	DiskWriteBytes uint64
	// HasOOM is false when the source cannot see out-of-memory kills, which
	// is different from having seen none.
	HasOOM   bool
	OOMKills uint64
}

// Source reads a boundary. A Source is used from one goroutine at a time.
type Source interface {
	// Kind names where the numbers come from, for the dashboard and for
	// anyone comparing two Attempts measured differently.
	Kind() string
	Read(now time.Time) (Reading, error)
}
