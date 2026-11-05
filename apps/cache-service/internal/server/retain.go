package server

import (
	"context"
	"time"

	"github.com/Fanzzzd/erainfra/apps/cache-service/internal/cacheindex"
)

// retainTick is how often restores are written as access markers and how often
// a repository that just saved an entry is checked against its quota.
const retainTick = 30 * time.Second

// firstSweepDelay lets a freshly started service answer jobs before it walks the
// bucket.
const firstSweepDelay = time.Minute

// retain is the eviction loop. It runs on every replica: eviction keeps all of
// its state in the bucket and every step of it is safe to repeat, so two
// replicas sweeping at once cost duplicate listings, never a wrong deletion.
func (s *Server) retain() {
	defer close(s.retained)
	interval := s.config.EvictionInterval
	if interval <= 0 {
		interval = time.Hour
	}
	tick := time.NewTicker(retainTick)
	defer tick.Stop()
	full := time.NewTimer(firstSweepDelay)
	defer full.Stop()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		<-s.stop
		cancel()
	}()

	for {
		select {
		case <-s.stop:
			// The last restores of this process still count. Bounded, because
			// a store that is down must not hold up a shutdown.
			flush, done := context.WithTimeout(context.Background(), 10*time.Second)
			if err := s.index.FlushAccess(flush); err != nil {
				s.logger.Warn("cache access markers not written at shutdown", "error", err)
			}
			done()
			return
		case <-tick.C:
			s.retainTickOnce(ctx)
		case <-full.C:
			s.sweepAll(ctx, interval)
			full.Reset(interval)
		}
	}
}

func (s *Server) retainTickOnce(ctx context.Context) {
	flush, done := context.WithTimeout(ctx, retainTick)
	if err := s.index.FlushAccess(flush); err != nil {
		s.logger.Warn("cache access markers not written; retrying next tick", "error", err)
	}
	done()

	quota, done := context.WithTimeout(ctx, 5*time.Minute)
	defer done()
	report, err := s.index.SweepDirty(quota)
	if err != nil {
		s.logger.Error("cache quota check failed; retrying next tick", "error", err)
	}
	if report.EvictedIdle+report.EvictedQuota+report.EvictedDangling+report.BlobsDeleted > 0 {
		s.logSweep("cache quota check finished", report)
	}
}

func (s *Server) sweepAll(ctx context.Context, interval time.Duration) {
	sweep, done := context.WithTimeout(ctx, interval)
	defer done()
	report, err := s.index.Sweep(sweep)
	if err != nil {
		s.logger.Error("cache eviction sweep failed; the next one retries", "error", err)
	}
	s.logSweep("cache eviction sweep finished", report)
}

func (s *Server) logSweep(message string, report cacheindex.SweepReport) {
	s.logger.Info(message,
		"repositories", report.Repositories,
		"evictedIdle", report.EvictedIdle,
		"evictedQuota", report.EvictedQuota,
		"evictedDangling", report.EvictedDangling,
		"evictedBytes", report.EvictedBytes,
		"entriesAdopted", report.EntriesAdopted,
		"blobsDeleted", report.BlobsDeleted,
		"blobBytesDeleted", report.BlobBytesDeleted,
		"markersDeleted", report.MarkersDeleted,
		"tombstonesDeleted", report.TombstonesDeleted)
}
