package cacheindex

// Retention: what this service keeps, and for how long.
//
// The reference behaviour is GitHub's own cache service, which every workflow
// moving onto this fleet already depends on: an entry nobody has restored for 7
// days is evicted, and a repository over its quota (10 GB by default) loses its
// least recently used entries until it fits. Blacksmith keeps the same shape at
// 25 GB. A bucket lifecycle rule cannot express either: it can expire an object
// by the age of its creation, never by when it was last read, and it has no
// notion of a repository's total. So the service evicts, and the lifecycle rule
// stays only as a backstop for the day the service is not running.
//
// Everything here keeps the bucket the whole of the index. There is no process
// state that eviction depends on for correctness, so a restart loses nothing and
// two replicas sweeping the same bucket at once do no harm (see evict).
//
// The layout below the configured prefix, beside the existing entries/ and
// blobs/ trees:
//
//	access/<entry object>          one per entry restored at least once. Its
//	                               LastModified is the entry's last access.
//	access/<entry object>~adopted  one per entry a sweep found with no access
//	                               marker. Its LastModified is when, and it is
//	                               where that entry's idle clock starts.
//	tombstones/<blob object>       one per blob whose entry was deleted. Its
//	                               LastModified is when, and the blob is kept
//	                               until BlobGrace has passed.
//	names/<owner>/<name>           which repository ID holds a name (see
//	                               ownership.go). No sweep lists it.

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/Fanzzzd/erainfra/apps/cache-service/internal/objectstore"
)

const (
	entriesRoot   = "entries/"
	blobsRoot     = "blobs/"
	accessRoot    = "access/"
	tombstoneRoot = "tombstones/"

	// adoptedSuffix names an adoption marker beside an entry's access marker.
	// An entry object's last segment is hex, a dot and hex, so the suffix can
	// never be part of an entry's own name.
	adoptedSuffix = "~adopted"

	// listPage is S3's own ceiling for one ListObjectsV2 page.
	listPage = 1000
	// metadataWorkers bounds the concurrent metadata reads a sweep makes the
	// first time it sees a repository. After that the memo answers.
	metadataWorkers = 8
	// maxPendingAccess bounds the restores waiting for their marker write. A
	// restore beyond it is not recorded, which costs eviction accuracy and
	// nothing else.
	maxPendingAccess = 50000
)

// Defaults. The idle TTL and the quota are GitHub's.
const (
	DefaultIdleTTL           = 7 * 24 * time.Hour
	DefaultRepoQuotaBytes    = int64(10 << 30)
	DefaultBlobGrace         = 45 * time.Minute
	DefaultOrphanGrace       = 3 * time.Hour
	DefaultMarkerGrace       = time.Hour
	DefaultAccessGranularity = 10 * time.Minute
)

// Retention is the eviction policy.
type Retention struct {
	// IdleTTL evicts an entry nobody has restored for this long. An entry
	// never restored counts from its creation.
	IdleTTL time.Duration
	// RepoQuotaBytes caps one repository's live entries. Over it, the least
	// recently used entries go until the total fits.
	RepoQuotaBytes int64
	// BlobGrace is how long a deleted entry's bytes stay readable. A restore
	// that found the entry a moment before it was deleted has already been
	// handed a URL for those bytes; the URL must still work for as long as it
	// is valid and for as long as a download through it may take.
	BlobGrace time.Duration
	// OrphanGrace is how old a blob no entry names must be before it is
	// removed. A blob is written before the entry that names it, and v2 holds
	// a written blob until FinalizeCacheEntryUpload, so this must outlast an
	// upload session.
	OrphanGrace time.Duration
	// MarkerGrace is how old an access marker for an entry that no longer
	// exists must be before it is removed. A restore that raced an eviction
	// can write one after the eviction removed the original.
	MarkerGrace time.Duration
	// AccessGranularity is how often one entry's access marker is rewritten
	// by one process. Restores in between are not written: a 7-day idle TTL
	// does not need a finer clock than this, and the store does not need a
	// write per restore.
	AccessGranularity time.Duration
}

func (r Retention) withDefaults() Retention {
	if r.IdleTTL <= 0 {
		r.IdleTTL = DefaultIdleTTL
	}
	if r.RepoQuotaBytes <= 0 {
		r.RepoQuotaBytes = DefaultRepoQuotaBytes
	}
	if r.BlobGrace <= 0 {
		r.BlobGrace = DefaultBlobGrace
	}
	if r.OrphanGrace <= 0 {
		r.OrphanGrace = DefaultOrphanGrace
	}
	if r.MarkerGrace <= 0 {
		r.MarkerGrace = DefaultMarkerGrace
	}
	if r.AccessGranularity <= 0 {
		r.AccessGranularity = DefaultAccessGranularity
	}
	return r
}

// Record is an entry with the one fact the entry document does not hold: when
// it was last restored.
type Record struct {
	Entry
	// LastAccess is the last restore, or the creation time for an entry
	// never restored. Least-recently-used order is by this.
	LastAccess time.Time

	// idleSince is where the idle clock runs from: the later of LastAccess
	// and the adoption marker. marked is whether either marker exists.
	//
	// An entry with neither has never been seen by a sweep. It may predate
	// access tracking altogether — saved by a version that recorded no
	// restores — so its creation time says nothing about whether it is in
	// use, and it is never evicted for idleness on that alone. The sweep that
	// first sees it adopts it instead, and its idle clock starts then. Quota
	// eviction does not wait: an unmarked entry is ordered by creation time.
	idleSince time.Time
	marked    bool
}

// Created is the entry's creation time.
func (r Record) Created() time.Time { return time.UnixMilli(r.CreatedAt).UTC() }

func (i *Index) markDirty(repository string) {
	i.dirtyMu.Lock()
	defer i.dirtyMu.Unlock()
	if i.dirty == nil {
		i.dirty = map[string]struct{}{}
	}
	i.dirty[repositorySegment(repository)] = struct{}{}
}

func (i *Index) takeDirty() []string {
	i.dirtyMu.Lock()
	defer i.dirtyMu.Unlock()
	repositories := make([]string, 0, len(i.dirty))
	for repository := range i.dirty {
		repositories = append(repositories, repository)
	}
	i.dirty = nil
	sort.Strings(repositories)
	return repositories
}

// metadataMemo caches parsed entry documents by object name. An entry is
// immutable — its object name carries its key, version, scope and creation
// millisecond — so a document read once is the document forever, and only the
// first sweep of a repository pays a read per entry.
type metadataMemo struct {
	mu      sync.Mutex
	entries map[string]Entry
}

func (m *metadataMemo) get(object string) (Entry, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	entry, ok := m.entries[object]
	return entry, ok
}

func (m *metadataMemo) put(object string, entry Entry) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.entries == nil {
		m.entries = map[string]Entry{}
	}
	m.entries[object] = entry
}

func (m *metadataMemo) forget(object string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.entries, object)
}

// keepOnly drops every memoised entry under prefix that is not in keep.
func (m *metadataMemo) keepOnly(prefix string, keep map[string]bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for object := range m.entries {
		if strings.HasPrefix(object, prefix) && !keep[object] {
			delete(m.entries, object)
		}
	}
}

// snapshot is one repository's objects, as listed.
type snapshot struct {
	repository string
	entries    []string
	markers    map[string]objectstore.Object
	adopted    map[string]objectstore.Object
	blobs      map[string]objectstore.Object
	tombstones map[string]objectstore.Object
}

func (i *Index) listAll(ctx context.Context, prefix string) ([]objectstore.Object, error) {
	var all []objectstore.Object
	after := ""
	for {
		page, truncated, err := i.store.ListAfter(ctx, prefix, after, listPage)
		if err != nil {
			return nil, err
		}
		all = append(all, page...)
		if !truncated || len(page) == 0 {
			return all, nil
		}
		after = page[len(page)-1].Key
	}
}

// repositoryOf reads "owner/name" out of an object name below root.
func repositoryOf(object, root string) (string, bool) {
	rest, ok := strings.CutPrefix(object, root)
	if !ok {
		return "", false
	}
	parts := strings.SplitN(rest, "/", 3)
	if len(parts) < 3 {
		return "", false
	}
	return parts[0] + "/" + parts[1], true
}

// scan lists one repository, or every repository when repository is empty.
//
// The order of the listings is load-bearing. An entry is written after its
// blob, so listing entries first means every entry seen here has a blob that
// existed before the blob listing began: an entry whose blob is missing from
// that listing really has lost it, and a blob that no listed entry names is
// either garbage or newer than the entry listing (which OrphanGrace covers).
func (i *Index) scan(ctx context.Context, repository string, garbage bool) (map[string]*snapshot, error) {
	segment := ""
	if repository != "" {
		segment = repositorySegment(repository) + "/"
	}
	snapshots := map[string]*snapshot{}
	at := func(repo string) *snapshot {
		snap := snapshots[repo]
		if snap == nil {
			snap = &snapshot{
				repository: repo,
				markers:    map[string]objectstore.Object{},
				adopted:    map[string]objectstore.Object{},
				blobs:      map[string]objectstore.Object{},
				tombstones: map[string]objectstore.Object{},
			}
			snapshots[repo] = snap
		}
		return snap
	}

	entries, err := i.listAll(ctx, entriesRoot+segment)
	if err != nil {
		return nil, err
	}
	for _, object := range entries {
		if repo, ok := repositoryOf(object.Key, entriesRoot); ok {
			snap := at(repo)
			snap.entries = append(snap.entries, object.Key)
		}
	}
	markers, err := i.listAll(ctx, accessRoot+entriesRoot+segment)
	if err != nil {
		return nil, err
	}
	for _, object := range markers {
		repo, ok := repositoryOf(object.Key, accessRoot+entriesRoot)
		if !ok {
			continue
		}
		entryObject := strings.TrimPrefix(object.Key, accessRoot)
		if adoptedOf, isAdoption := strings.CutSuffix(entryObject, adoptedSuffix); isAdoption {
			at(repo).adopted[adoptedOf] = object
			continue
		}
		at(repo).markers[entryObject] = object
	}
	if !garbage {
		return snapshots, nil
	}
	blobs, err := i.listAll(ctx, blobsRoot+segment)
	if err != nil {
		return nil, err
	}
	for _, object := range blobs {
		if repo, ok := repositoryOf(object.Key, blobsRoot); ok {
			at(repo).blobs[object.Key] = object
		}
	}
	tombstones, err := i.listAll(ctx, tombstoneRoot+blobsRoot+segment)
	if err != nil {
		return nil, err
	}
	for _, object := range tombstones {
		if repo, ok := repositoryOf(object.Key, tombstoneRoot+blobsRoot); ok {
			at(repo).tombstones[strings.TrimPrefix(object.Key, tombstoneRoot)] = object
		}
	}
	return snapshots, nil
}

// entryAt reads one entry document, through the memo. A document that has gone
// (another replica evicted it) or does not parse answers nil and no error: it
// is not an entry anyone can restore.
func (i *Index) entryAt(ctx context.Context, object string) (*Entry, error) {
	if entry, ok := i.memo.get(object); ok {
		return &entry, nil
	}
	body, err := i.store.GetBytes(ctx, object, maxEntryMetadataBytes)
	if err != nil {
		if errors.Is(err, objectstore.ErrNotFound) {
			return nil, nil
		}
		return nil, err
	}
	var entry Entry
	if err := json.Unmarshal(body, &entry); err != nil {
		i.logger.Warn("cache entry metadata does not parse", "object", object, "error", err)
		return nil, nil
	}
	entry.Object = object
	i.memo.put(object, entry)
	return &entry, nil
}

// records turns a snapshot's entry names into records, reading each document at
// most once per process.
func (i *Index) records(ctx context.Context, snap *snapshot) ([]Record, error) {
	type result struct {
		at     int
		record *Record
		err    error
	}
	jobs := make(chan int)
	results := make(chan result)
	workers := metadataWorkers
	if len(snap.entries) < workers {
		workers = len(snap.entries)
	}
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for at := range jobs {
				object := snap.entries[at]
				entry, err := i.entryAt(ctx, object)
				if err != nil || entry == nil {
					results <- result{at: at, err: err}
					continue
				}
				if !strings.EqualFold(entry.Repository, snap.repository) {
					i.logger.Error("cache entry metadata contradicts its own location",
						"object", object, "repository", entry.Repository)
					results <- result{at: at}
					continue
				}
				record := Record{Entry: *entry, LastAccess: time.UnixMilli(entry.CreatedAt).UTC()}
				marker, accessed := snap.markers[object]
				if accessed && marker.LastModified.After(record.LastAccess) {
					record.LastAccess = marker.LastModified.UTC()
				}
				record.idleSince = record.LastAccess
				adoption, adopted := snap.adopted[object]
				if adopted && adoption.LastModified.After(record.idleSince) {
					record.idleSince = adoption.LastModified.UTC()
				}
				record.marked = accessed || adopted
				results <- result{at: at, record: &record}
			}
		}()
	}
	go func() {
		for at := range snap.entries {
			jobs <- at
		}
		close(jobs)
		wg.Wait()
		close(results)
	}()

	ordered := make([]*Record, len(snap.entries))
	var firstErr error
	for result := range results {
		if result.err != nil && firstErr == nil {
			firstErr = result.err
		}
		ordered[result.at] = result.record
	}
	if firstErr != nil {
		return nil, firstErr
	}
	records := make([]Record, 0, len(ordered))
	for _, record := range ordered {
		if record != nil {
			records = append(records, *record)
		}
	}
	return records, nil
}

// evict deletes one entry so that no restore can find it, and leaves its bytes
// for the sweeper to remove once nothing can still be reading them.
//
// The order is the whole of the safety argument:
//
//  1. a tombstone for the blob, stamped now. Without it a later sweep would see
//     an unreferenced, old blob and delete it at once, inside the window where
//     a restore that found this entry a moment ago is still downloading it.
//  2. the entry document. From here every restore is a miss.
//  3. the access and adoption markers, which are now meaningless.
//
// The blob goes in a later sweep, after BlobGrace. Two replicas evicting the
// same entry write the same tombstone and delete the same objects; both succeed.
func (i *Index) evict(ctx context.Context, record Record) error {
	ownBlobs := blobsRoot + repositorySegment(record.Repository) + "/"
	if strings.HasPrefix(record.Blob, ownBlobs) {
		if err := i.store.PutBytes(ctx, tombstoneRoot+record.Blob, "text/plain",
			[]byte(record.Object)); err != nil {
			return err
		}
	} else {
		// The document names bytes outside its own repository's tree. They are
		// not this entry's to delete; the document still goes.
		i.logger.Error("cache entry names a blob outside its repository; leaving the blob",
			"object", record.Object, "blob", record.Blob)
	}
	if err := i.store.Delete(ctx, record.Object); err != nil {
		return err
	}
	i.memo.forget(record.Object)
	if err := i.store.Delete(ctx, accessRoot+record.Object); err != nil {
		return err
	}
	return i.store.Delete(ctx, accessRoot+record.Object+adoptedSuffix)
}

// SweepReport is what one sweep did.
type SweepReport struct {
	Repositories      int
	EvictedIdle       int
	EvictedQuota      int
	EvictedDangling   int
	EvictedBytes      int64
	EntriesAdopted    int
	BlobsDeleted      int
	BlobBytesDeleted  int64
	MarkersDeleted    int
	TombstonesDeleted int
}

func (r *SweepReport) add(other SweepReport) {
	r.Repositories += other.Repositories
	r.EvictedIdle += other.EvictedIdle
	r.EvictedQuota += other.EvictedQuota
	r.EvictedDangling += other.EvictedDangling
	r.EvictedBytes += other.EvictedBytes
	r.EntriesAdopted += other.EntriesAdopted
	r.BlobsDeleted += other.BlobsDeleted
	r.BlobBytesDeleted += other.BlobBytesDeleted
	r.MarkersDeleted += other.MarkersDeleted
	r.TombstonesDeleted += other.TombstonesDeleted
}

// Sweep applies the retention policy to every repository in the bucket.
func (i *Index) Sweep(ctx context.Context) (SweepReport, error) {
	return i.sweep(ctx, "")
}

// SweepRepository applies the retention policy to one repository.
func (i *Index) SweepRepository(ctx context.Context, repository string) (SweepReport, error) {
	if repository == "" {
		return SweepReport{}, errors.New("a repository is required")
	}
	return i.sweep(ctx, repository)
}

// SweepDirty sweeps every repository that has committed an entry since the last
// call. It is how a quota holds within a minute of the commit that broke it
// rather than within a full sweep interval.
func (i *Index) SweepDirty(ctx context.Context) (SweepReport, error) {
	var total SweepReport
	for _, repository := range i.takeDirty() {
		report, err := i.sweep(ctx, repository)
		total.add(report)
		if err != nil {
			// Put it back: the quota is still owed.
			i.markDirty(repository)
			return total, err
		}
	}
	return total, nil
}

func (i *Index) sweep(ctx context.Context, repository string) (SweepReport, error) {
	i.sweepMu.Lock()
	defer i.sweepMu.Unlock()

	snapshots, err := i.scan(ctx, repository, true)
	if err != nil {
		return SweepReport{}, err
	}
	var total SweepReport
	seen := map[string]bool{}
	repositories := make([]string, 0, len(snapshots))
	for repo := range snapshots {
		repositories = append(repositories, repo)
	}
	sort.Strings(repositories)
	for _, repo := range repositories {
		report, live, err := i.sweepSnapshot(ctx, snapshots[repo])
		total.add(report)
		if err != nil {
			return total, err
		}
		for object := range live {
			seen[object] = true
		}
	}
	prefix := entriesRoot
	if repository != "" {
		prefix += repositorySegment(repository) + "/"
	}
	i.memo.keepOnly(prefix, seen)
	return total, nil
}

// lruOrder sorts least recently used first. Ties — entries restored within one
// AccessGranularity of each other, or never restored — go to the older entry,
// then to the object name so the order is total.
func lruOrder(records []Record) {
	sort.SliceStable(records, func(a, b int) bool {
		left, right := records[a], records[b]
		if !left.LastAccess.Equal(right.LastAccess) {
			return left.LastAccess.Before(right.LastAccess)
		}
		if left.CreatedAt != right.CreatedAt {
			return left.CreatedAt < right.CreatedAt
		}
		return left.Object < right.Object
	})
}

func (i *Index) sweepSnapshot(ctx context.Context, snap *snapshot) (SweepReport, map[string]bool, error) {
	policy := i.Retention.withDefaults()
	now := i.now()
	report := SweepReport{Repositories: 1}

	records, err := i.records(ctx, snap)
	if err != nil {
		return report, nil, err
	}
	lruOrder(records)

	idleBefore := now.Add(-policy.IdleTTL)
	var keep []Record
	var total int64
	for _, record := range records {
		// An entry whose blob is missing from a blob listing taken after the
		// entry listing has really lost its bytes (see scan). Restores already
		// answer it as a miss, but it would still make Exists refuse a fresh
		// save of the same key, so it goes now rather than after the idle TTL.
		_, hasBlob := snap.blobs[record.Blob]
		idle := record.marked && record.idleSince.Before(idleBefore)
		if !hasBlob || idle {
			if err := i.evict(ctx, record); err != nil {
				return report, nil, err
			}
			// Recorded so the tombstone evict just wrote is accounted for
			// below: kept for the grace period if the blob exists, deleted at
			// once if it does not.
			snap.tombstones[record.Blob] = objectstore.Object{Key: record.Blob, LastModified: now}
			reason := "idle"
			if !hasBlob {
				reason = "blob missing"
				report.EvictedDangling++
			} else {
				report.EvictedIdle++
				report.EvictedBytes += record.Size
			}
			i.logger.Info("cache entry evicted", "reason", reason, "repository", record.Repository,
				"ref", record.Ref, "key", record.Key, "bytes", record.Size,
				"lastAccess", record.LastAccess.Format(time.RFC3339))
			continue
		}
		keep = append(keep, record)
		total += record.Size
	}
	// keep is still least recently used first.
	evicted := 0
	for evicted < len(keep) && total > policy.RepoQuotaBytes {
		record := keep[evicted]
		if err := i.evict(ctx, record); err != nil {
			return report, nil, err
		}
		snap.tombstones[record.Blob] = objectstore.Object{Key: record.Blob, LastModified: now}
		total -= record.Size
		report.EvictedQuota++
		report.EvictedBytes += record.Size
		i.logger.Info("cache entry evicted", "reason", "quota", "repository", record.Repository,
			"ref", record.Ref, "key", record.Key, "bytes", record.Size,
			"lastAccess", record.LastAccess.Format(time.RFC3339), "quotaBytes", policy.RepoQuotaBytes)
		evicted++
	}
	keep = keep[evicted:]

	// Adopt every surviving entry no sweep has seen before. Its idle clock
	// starts now, so the sweep that first meets an entry saved by a version
	// without access tracking never evicts it for idleness.
	for _, record := range keep {
		if record.marked {
			continue
		}
		if err := i.store.PutBytes(ctx, accessRoot+record.Object+adoptedSuffix, "text/plain",
			[]byte(now.UTC().Format(time.RFC3339))); err != nil {
			return report, nil, err
		}
		report.EntriesAdopted++
	}

	live := map[string]bool{}
	gone := map[string]bool{}
	for _, record := range records {
		gone[record.Object] = true
	}
	referenced := map[string]bool{}
	for _, record := range keep {
		live[record.Object] = true
		delete(gone, record.Object)
		referenced[record.Blob] = true
	}

	// Blobs. Each one is referenced, tombstoned, or neither.
	for key, blob := range snap.blobs {
		tombstone, tombstoned := snap.tombstones[key]
		switch {
		case referenced[key]:
			// A live entry with a tombstone is an eviction that stopped between
			// its first and second write. The entry stands; the stale tombstone
			// goes once it is old enough that no eviction can still be running.
			if tombstoned && now.Sub(tombstone.LastModified) >= policy.BlobGrace {
				if err := i.store.Delete(ctx, tombstoneRoot+key); err != nil {
					return report, live, err
				}
				report.TombstonesDeleted++
			}
		case tombstoned:
			if now.Sub(tombstone.LastModified) < policy.BlobGrace {
				continue
			}
			if err := i.store.Delete(ctx, key); err != nil {
				return report, live, err
			}
			report.BlobsDeleted++
			report.BlobBytesDeleted += blob.Size
			if err := i.store.Delete(ctx, tombstoneRoot+key); err != nil {
				return report, live, err
			}
			report.TombstonesDeleted++
		default:
			// Nothing names it and nothing deleted it: a save that wrote its
			// bytes and never published the entry.
			if now.Sub(blob.LastModified) < policy.OrphanGrace {
				continue
			}
			if err := i.store.Delete(ctx, key); err != nil {
				return report, live, err
			}
			report.BlobsDeleted++
			report.BlobBytesDeleted += blob.Size
		}
	}
	// Tombstones for blobs that are already gone.
	for key := range snap.tombstones {
		if _, exists := snap.blobs[key]; exists {
			continue
		}
		if err := i.store.Delete(ctx, tombstoneRoot+key); err != nil {
			return report, live, err
		}
		report.TombstonesDeleted++
	}
	// Markers for entries that are gone. One written by a restore that raced an
	// eviction is young, which is why this waits MarkerGrace.
	for _, set := range []struct {
		markers map[string]objectstore.Object
		suffix  string
	}{{snap.markers, ""}, {snap.adopted, adoptedSuffix}} {
		for object, marker := range set.markers {
			if live[object] {
				continue
			}
			if gone[object] {
				continue // evict already deleted it
			}
			if now.Sub(marker.LastModified) < policy.MarkerGrace {
				continue
			}
			if err := i.store.Delete(ctx, accessRoot+object+set.suffix); err != nil {
				return report, live, err
			}
			report.MarkersDeleted++
		}
	}
	return report, live, nil
}

// Match selects entries for the admin API. Every field narrows; an empty field
// matches anything. Exactly one of Key, Prefix and All is set for a delete.
type Match struct {
	// Key matches the cache key exactly.
	Key string
	// Prefix matches cache keys that start with it.
	Prefix string
	// Search matches cache keys that contain it.
	Search string
	// Version matches the client's version string exactly.
	Version string
	// Ref matches the scope an entry was saved under, such as refs/heads/main.
	Ref string
	// RepositoryID matches entries saved by that GitHub repository ID. Zero
	// matches any; entries saved without an ID never match a non-zero one.
	RepositoryID int64
	// All is the explicit "every entry", for clearing a repository.
	All bool
}

// Matches reports whether a record is selected.
func (m Match) Matches(record Record) bool {
	if m.Key != "" && record.Key != m.Key {
		return false
	}
	if m.Prefix != "" && !strings.HasPrefix(record.Key, m.Prefix) {
		return false
	}
	if m.Search != "" && !strings.Contains(record.Key, m.Search) {
		return false
	}
	if m.Version != "" && record.Version != m.Version {
		return false
	}
	if m.Ref != "" && record.Ref != m.Ref {
		return false
	}
	if m.RepositoryID != 0 && record.RepositoryID != m.RepositoryID {
		return false
	}
	return true
}

// Entries lists one repository's entries that match. The repository is always
// explicit: there is no call that reaches across repositories.
func (i *Index) Entries(ctx context.Context, repository string, match Match) ([]Record, error) {
	snapshots, err := i.scan(ctx, repository, false)
	if err != nil {
		return nil, err
	}
	snap := snapshots[repositorySegment(repository)]
	if snap == nil {
		return []Record{}, nil
	}
	records, err := i.records(ctx, snap)
	if err != nil {
		return nil, err
	}
	selected := make([]Record, 0, len(records))
	for _, record := range records {
		if match.Matches(record) {
			selected = append(selected, record)
		}
	}
	return selected, nil
}

// Remove deletes one repository's entries that match, through the same path
// eviction takes: a restore after this returns is a miss, and the bytes go once
// nothing can still be downloading them.
func (i *Index) Remove(ctx context.Context, repository string, match Match) ([]Record, error) {
	selected, err := i.Entries(ctx, repository, match)
	if err != nil {
		return nil, err
	}
	removed := make([]Record, 0, len(selected))
	for _, record := range selected {
		if err := i.evict(ctx, record); err != nil {
			return removed, err
		}
		removed = append(removed, record)
	}
	if len(removed) > 0 {
		i.markDirty(repository)
	}
	return removed, nil
}
