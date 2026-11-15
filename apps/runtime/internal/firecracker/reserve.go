package firecracker

import (
	"slices"
	"sync"
)

// reserveUsedMiB is how much of their pool reserves the given guests have
// already written, reported as storage.poolReserveUsedMiB.
//
// The thin-pool's free space already lacks what live guests wrote, so the
// control plane adds this back before it charges each guest a full reserve,
// rather than charging that part twice. Each guest counts for at most one
// reserve: a guest past its reserve still holds the excess, and the excess is
// not room for another guest. Bytes round down, so the credit is never larger
// than what the guests wrote.
func reserveUsedMiB(writtenBytes []int64, reserveMiB int64) int64 {
	var used int64
	for _, written := range writtenBytes {
		used += min(max(written, 0)/(1<<20), reserveMiB)
	}
	return used
}

// parkedReserveUsedMiB is the reserve credit for parked guests when only the
// count of parked guests is known, not which live roots they own. It credits
// the parked smallest writes among the live roots: no parked guests can have
// written less than that, so the credit never exceeds what they wrote. The
// warm-pool setup check adds it back, as the control plane adds back
// reserveUsedMiB, so a parked guest is not charged its own writes twice.
func parkedReserveUsedMiB(writtenBytes []int64, parked int, reserveMiB int64) int64 {
	if parked <= 0 {
		return 0
	}
	smallest := slices.Clone(writtenBytes)
	slices.Sort(smallest)
	return reserveUsedMiB(smallest[:min(parked, len(smallest))], reserveMiB)
}

// liveRoots is the set of containerd snapshot keys of the root disks of the
// guests this runtime holds, cold-booted and warm alike. A guest is added once
// its root snapshot exists and removed before its containerd lease is released,
// so a key in the set always names a root whose blocks are still in the pool.
// A root left behind by a failed release is not in the set and earns no credit.
type liveRoots struct {
	mu   sync.Mutex
	keys map[string]struct{}
}

func (l *liveRoots) add(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.keys == nil {
		l.keys = make(map[string]struct{})
	}
	l.keys[key] = struct{}{}
}

func (l *liveRoots) remove(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.keys, key)
}

func (l *liveRoots) list() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	keys := make([]string, 0, len(l.keys))
	for key := range l.keys {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	return keys
}

// stillLive returns the keys from an earlier list that are still live. The
// runtime reads each root's usage, then samples the pool, then keeps only the
// roots live across both: a guest that ended in between may already have
// given its blocks back to the sample, and must not be credited for them too.
func (l *liveRoots) stillLive(earlier []string) []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	live := make([]string, 0, len(earlier))
	for _, key := range earlier {
		if _, ok := l.keys[key]; ok {
			live = append(live, key)
		}
	}
	return live
}
