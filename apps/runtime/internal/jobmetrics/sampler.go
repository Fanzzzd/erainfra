package jobmetrics

import (
	"context"
	"errors"
	"sync"
	"time"
)

// Sampler reads a Source on a fixed interval into a Series until stopped.
//
// It never fails anything. A reading that errors is counted and the next tick
// tries again, so a sampler problem costs the Attempt some resolution in its
// chart and nothing else.
type Sampler struct {
	source   Source
	interval time.Duration
	now      func() time.Time

	mu     sync.Mutex
	series *Series

	cancel   context.CancelFunc
	done     chan struct{}
	stopOnce sync.Once
}

// StartSampler takes the baseline reading immediately and then one per
// interval. The goroutine ends when Stop is called or ctx is done.
func StartSampler(ctx context.Context, source Source, interval time.Duration) *Sampler {
	return startSampler(ctx, source, interval, time.Now)
}

func startSampler(
	ctx context.Context,
	source Source,
	interval time.Duration,
	now func() time.Time,
) *Sampler {
	if interval <= 0 {
		interval = DefaultSampleInterval
	}
	ctx, cancel := context.WithCancel(ctx)
	sampler := &Sampler{
		source:   source,
		interval: interval,
		now:      now,
		series:   NewSeries(source.Kind(), interval),
		cancel:   cancel,
		done:     make(chan struct{}),
	}
	sampler.sample(true)
	go sampler.run(ctx)
	return sampler
}

func (s *Sampler) run(ctx context.Context) {
	defer close(s.done)
	ticker := time.NewTicker(s.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.sample(true)
		}
	}
}

// sample takes one reading. countErrors is false for the closing reading,
// which may fail in ways other than ErrGone while the boundary is torn down.
func (s *Sampler) sample(countErrors bool) {
	reading, err := s.source.Read(s.now())
	s.mu.Lock()
	defer s.mu.Unlock()
	if err != nil {
		if countErrors && !errors.Is(err, ErrGone) {
			s.series.RecordError(err)
		}
		return
	}
	s.series.Observe(reading)
}

// Stop ends sampling after one last reading, which catches the final
// seconds whenever the boundary still exists to be read. Safe to call more
// than once.
func (s *Sampler) Stop() {
	s.stopOnce.Do(func() {
		s.cancel()
		<-s.done
		s.sample(false)
	})
}

func (s *Sampler) Snapshot() Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.series.Snapshot()
}
