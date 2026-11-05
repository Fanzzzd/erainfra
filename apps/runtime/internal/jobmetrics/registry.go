package jobmetrics

import (
	"context"
	"sync"
	"time"
)

const (
	// finishedRetention is how long a finished Attempt's last Snapshot stays
	// readable. The Worker collects it seconds after the VM exits; the margin
	// covers an Agent that is slow to ask, not a second consumer.
	finishedRetention = 15 * time.Minute
	// maxFinished bounds the finished set on a Worker that churns through
	// short jobs faster than anyone collects them.
	maxFinished = 128
)

type finishedSnapshot struct {
	snapshot Snapshot
	at       time.Time
}

// Registry is the runtime service's set of Samplers, one per running
// Attempt, plus the final Snapshot of each recently finished one.
type Registry struct {
	interval time.Duration
	now      func() time.Time

	mu       sync.Mutex
	live     map[string]*Sampler
	finished map[string]finishedSnapshot
	order    []string
}

func NewRegistry(interval time.Duration) *Registry {
	return &Registry{
		interval: interval,
		now:      time.Now,
		live:     make(map[string]*Sampler),
		finished: make(map[string]finishedSnapshot),
	}
}

// Start begins sampling an Attempt. A second Start for the same Attempt
// replaces the first, which is stopped.
func (r *Registry) Start(attemptID string, source Source) {
	sampler := startSampler(context.Background(), source, r.interval, r.now)
	r.mu.Lock()
	previous := r.live[attemptID]
	r.live[attemptID] = sampler
	r.mu.Unlock()
	if previous != nil {
		previous.Stop()
	}
}

// Finish stops an Attempt's Sampler and keeps its final Snapshot for
// collection. It is a no-op for an Attempt that is not being sampled.
func (r *Registry) Finish(attemptID string) {
	r.mu.Lock()
	sampler := r.live[attemptID]
	delete(r.live, attemptID)
	r.mu.Unlock()
	if sampler == nil {
		return
	}
	sampler.Stop()
	snapshot := sampler.Snapshot()
	r.mu.Lock()
	defer r.mu.Unlock()
	r.pruneLocked()
	if _, exists := r.finished[attemptID]; !exists {
		r.order = append(r.order, attemptID)
	}
	r.finished[attemptID] = finishedSnapshot{snapshot: snapshot, at: r.now()}
	for len(r.order) > maxFinished {
		delete(r.finished, r.order[0])
		r.order = r.order[1:]
	}
}

// Snapshot returns an Attempt's current Snapshot. live is false once the
// Attempt has finished; ok is false when the runtime has nothing for it.
func (r *Registry) Snapshot(attemptID string) (snapshot Snapshot, live bool, ok bool) {
	r.mu.Lock()
	sampler := r.live[attemptID]
	if sampler == nil {
		r.pruneLocked()
		finished, found := r.finished[attemptID]
		r.mu.Unlock()
		return finished.snapshot, false, found
	}
	r.mu.Unlock()
	return sampler.Snapshot(), true, true
}

func (r *Registry) pruneLocked() {
	cutoff := r.now().Add(-finishedRetention)
	kept := r.order[:0]
	for _, attemptID := range r.order {
		if r.finished[attemptID].at.Before(cutoff) {
			delete(r.finished, attemptID)
			continue
		}
		kept = append(kept, attemptID)
	}
	r.order = kept
}

// Shutdown stops every live Sampler.
func (r *Registry) Shutdown() {
	r.mu.Lock()
	live := r.live
	r.live = make(map[string]*Sampler)
	r.mu.Unlock()
	for _, sampler := range live {
		sampler.Stop()
	}
}
