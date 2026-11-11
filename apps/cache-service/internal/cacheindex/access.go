package cacheindex

import (
	"context"
	"sync"
	"time"
)

// Access markers: a restore is noted in memory and written to access/<entry object> by a later
// flush, so the restore path never waits on the store. Retention reads the markers (retention.go).

// accessLog holds restores that have not been written to the bucket yet.
type accessLog struct {
	mu      sync.Mutex
	pending map[string]struct{}
	// written is when this process last wrote each entry's marker, so a hot
	// entry is written once per AccessGranularity rather than once per restore.
	written map[string]time.Time
}

// recordAccess notes a restore hit. It does not touch the store: the restore
// is already answered, and a marker write on the restore path would put a store
// round trip between every job and its cache.
func (i *Index) recordAccess(object string) {
	if object == "" {
		return
	}
	now := i.now()
	granularity := i.Retention.withDefaults().AccessGranularity
	log := &i.access
	log.mu.Lock()
	defer log.mu.Unlock()
	if log.pending == nil {
		log.pending = map[string]struct{}{}
		log.written = map[string]time.Time{}
	}
	if last, ok := log.written[object]; ok && now.Sub(last) < granularity {
		return
	}
	if len(log.pending) >= maxPendingAccess {
		return
	}
	log.pending[object] = struct{}{}
}

// FlushAccess writes an access marker for every entry restored since the last
// flush. A marker that cannot be written is kept for the next flush.
func (i *Index) FlushAccess(ctx context.Context) error {
	log := &i.access
	log.mu.Lock()
	batch := log.pending
	log.pending = map[string]struct{}{}
	if log.written == nil {
		log.written = map[string]time.Time{}
	}
	log.mu.Unlock()

	var firstErr error
	for object := range batch {
		now := i.now()
		err := i.store.PutBytes(ctx, accessRoot+object, "text/plain",
			[]byte(now.UTC().Format(time.RFC3339)))
		log.mu.Lock()
		if err != nil {
			if len(log.pending) < maxPendingAccess {
				log.pending[object] = struct{}{}
			}
			if firstErr == nil {
				firstErr = err
			}
		} else {
			log.written[object] = now
		}
		log.mu.Unlock()
	}

	granularity := i.Retention.withDefaults().AccessGranularity
	now := i.now()
	log.mu.Lock()
	for object, at := range log.written {
		if now.Sub(at) >= granularity {
			delete(log.written, object)
		}
	}
	log.mu.Unlock()
	return firstErr
}
