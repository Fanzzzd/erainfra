package cacheindex

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/Fanzzzd/erainfra/apps/cache-service/cachetoken"
	"github.com/Fanzzzd/erainfra/apps/cache-service/internal/objectstore/fakes3"
)

var retentionStart = time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC)

// fixture is an index over a fake store with a clock the test moves.
type fixture struct {
	t     *testing.T
	index *Index
	store *fakes3.Server
	at    time.Time
	set   func(time.Time)
}

func newFixture(t *testing.T, retention Retention) *fixture {
	t.Helper()
	index, store, set := newTestIndex(t)
	index.Retention = retention
	f := &fixture{t: t, index: index, store: store, at: retentionStart, set: set}
	set(retentionStart)
	return f
}

func (f *fixture) advance(by time.Duration) {
	f.at = f.at.Add(by)
	f.set(f.at)
}

// save writes a blob of size bytes and the entry that names it, the order a real
// save uses.
func (f *fixture) save(repository, ref, key, version string, size int) Entry {
	f.t.Helper()
	blob := "blobs/" + repositorySegment(repository) + "/" + strings.ReplaceAll(ref+"-"+key+"-"+version, "/", "_")
	f.store.Overwrite(blob, make([]byte, size))
	entry := Entry{Key: key, Version: version, Repository: repository, Ref: ref, Blob: blob, Size: int64(size)}
	if err := f.index.Commit(context.Background(), entry); err != nil {
		f.t.Fatal(err)
	}
	return entry
}

// restore is a restore hit on one exact key in the main scope, with its access
// written the way the service's loop writes it.
func (f *fixture) restore(repository, key, version string) *Entry {
	f.t.Helper()
	claims := cachetoken.Claims{Repository: repository, Ref: "refs/heads/main"}
	entry, err := f.index.Lookup(context.Background(), claims, []string{key}, version)
	if err != nil {
		f.t.Fatal(err)
	}
	if err := f.index.FlushAccess(context.Background()); err != nil {
		f.t.Fatal(err)
	}
	return entry
}

func (f *fixture) sweep() SweepReport {
	f.t.Helper()
	report, err := f.index.Sweep(context.Background())
	if err != nil {
		f.t.Fatal(err)
	}
	return report
}

func (f *fixture) present(repository, key string) bool {
	f.t.Helper()
	records, err := f.index.Entries(context.Background(), repository, Match{Key: key})
	if err != nil {
		f.t.Fatal(err)
	}
	return len(records) > 0
}

const repo = "Fanzzzd/erainfra"
const main = "refs/heads/main"

// GitHub's rule: an entry nobody has restored for the idle TTL goes. Restoring
// it is what keeps it, and creation counts as the first access.
func TestIdleEntriesAreEvictedAndRestoredOnesAreKept(t *testing.T) {
	f := newFixture(t, Retention{IdleTTL: 7 * 24 * time.Hour})
	f.save(repo, main, "never-restored", "v1", 10)
	f.save(repo, main, "restored", "v1", 10)

	f.advance(3 * 24 * time.Hour)
	if f.restore(repo, "restored", "v1") == nil {
		t.Fatal("restore missed before any eviction")
	}
	f.advance(5 * 24 * time.Hour) // 8 days since creation, 5 since the restore

	report := f.sweep()
	if report.EvictedIdle != 1 || report.EvictedQuota != 0 {
		t.Fatalf("report = %+v, want exactly one idle eviction", report)
	}
	if f.present(repo, "never-restored") {
		t.Error("an entry idle for 8 days survived a 7-day TTL")
	}
	if !f.present(repo, "restored") {
		t.Error("an entry restored 5 days ago was evicted")
	}
	if f.restore(repo, "never-restored", "v1") != nil {
		t.Error("an evicted entry still answers a restore")
	}
}

// Over quota, the least recently used entries go first, and only as many as it
// takes. Restoring an old entry moves it to the back of the line; a new save
// is the most recently used thing in the repository.
func TestQuotaEvictsLeastRecentlyUsedFirst(t *testing.T) {
	f := newFixture(t, Retention{RepoQuotaBytes: 100})
	f.save(repo, main, "a", "v1", 40)
	f.advance(time.Minute)
	f.save(repo, main, "b", "v1", 40)
	f.advance(time.Minute)
	f.save(repo, main, "c", "v1", 40)
	f.advance(11 * time.Minute)
	f.restore(repo, "a", "v1") // a is now the most recently used of the three

	report, err := f.index.SweepDirty(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if report.EvictedQuota != 1 || report.EvictedBytes != 40 {
		t.Fatalf("report = %+v, want one 40-byte quota eviction", report)
	}
	for key, want := range map[string]bool{"a": true, "b": false, "c": true} {
		if got := f.present(repo, key); got != want {
			t.Errorf("after the first pass %q present = %v, want %v", key, got, want)
		}
	}

	// A fourth save puts the repository over again. c was never restored and
	// is older than a's last restore, so c goes next.
	f.advance(time.Minute)
	f.save(repo, main, "d", "v1", 40)
	if _, err := f.index.SweepDirty(context.Background()); err != nil {
		t.Fatal(err)
	}
	for key, want := range map[string]bool{"a": true, "b": false, "c": false, "d": true} {
		if got := f.present(repo, key); got != want {
			t.Errorf("after the second pass %q present = %v, want %v", key, got, want)
		}
	}
}

// A quota belongs to one repository. Another repository's bytes never count
// against it and are never evicted to make room in it.
func TestQuotaIsPerRepository(t *testing.T) {
	f := newFixture(t, Retention{RepoQuotaBytes: 100})
	f.save("other/repo", main, "big", "v1", 90)
	f.advance(time.Minute)
	f.save(repo, main, "x", "v1", 60)
	f.advance(time.Minute)
	f.save(repo, main, "y", "v1", 30)

	report := f.sweep()
	if report.EvictedQuota != 0 {
		t.Fatalf("report = %+v, want nothing evicted: each repository is under its own quota", report)
	}
	if !f.present("other/repo", "big") || !f.present(repo, "x") || !f.present(repo, "y") {
		t.Fatal("an entry was evicted from a repository under quota")
	}
}

// Eviction deletes the entry document first and keeps the bytes. A restore that
// found the entry a moment earlier is still downloading through a URL that has
// to keep working; only after the grace period are the bytes deleted.
func TestEvictedBytesOutliveTheirEntryForTheGracePeriod(t *testing.T) {
	f := newFixture(t, Retention{IdleTTL: time.Hour, BlobGrace: 30 * time.Minute})
	entry := f.save(repo, main, "k", "v1", 10)
	f.advance(2 * time.Hour)

	if report := f.sweep(); report.EvictedIdle != 1 || report.BlobsDeleted != 0 {
		t.Fatalf("first sweep = %+v, want the entry evicted and its blob kept", report)
	}
	if _, ok := f.store.Object(entry.Blob); !ok {
		t.Fatal("the blob was deleted in the same sweep that deleted its entry")
	}
	if _, ok := f.store.Object(tombstoneRoot + entry.Blob); !ok {
		t.Fatal("eviction left no tombstone; a second replica would delete the blob at once")
	}

	f.advance(20 * time.Minute)
	if report := f.sweep(); report.BlobsDeleted != 0 {
		t.Fatalf("sweep inside the grace period deleted a blob: %+v", report)
	}

	f.advance(15 * time.Minute)
	if report := f.sweep(); report.BlobsDeleted != 1 || report.TombstonesDeleted != 1 {
		t.Fatalf("sweep after the grace period = %+v, want the blob and its tombstone gone", report)
	}
	for _, key := range f.store.Keys() {
		t.Errorf("left behind: %s", key)
	}
}

// A save that wrote its bytes and never published the entry leaves a blob that
// nothing names. It goes once it is older than any save could still be.
func TestOrphanedBlobsAreRemovedAfterTheirGrace(t *testing.T) {
	f := newFixture(t, Retention{OrphanGrace: 2 * time.Hour})
	orphan := "blobs/" + repositorySegment(repo) + "/abandoned"
	f.store.Overwrite(orphan, []byte("half a save"))
	kept := f.save(repo, main, "k", "v1", 10)

	f.advance(time.Hour)
	if report := f.sweep(); report.BlobsDeleted != 0 {
		t.Fatalf("a young unreferenced blob was deleted; it may be a save in progress: %+v", report)
	}
	f.advance(90 * time.Minute)
	if report := f.sweep(); report.BlobsDeleted != 1 {
		t.Fatalf("report = %+v, want the orphan deleted", report)
	}
	if _, ok := f.store.Object(orphan); ok {
		t.Error("orphan survived")
	}
	if _, ok := f.store.Object(kept.Blob); !ok {
		t.Error("a referenced blob was deleted as an orphan")
	}
}

// An eviction that stopped after its tombstone and before deleting the entry
// leaves a live entry with a tombstone. The entry stands and keeps its bytes.
func TestAnInterruptedEvictionNeverDeletesALiveEntrysBytes(t *testing.T) {
	f := newFixture(t, Retention{BlobGrace: 30 * time.Minute})
	entry := f.save(repo, main, "k", "v1", 10)
	f.store.Overwrite(tombstoneRoot+entry.Blob, []byte("interrupted"))

	f.advance(time.Hour)
	report := f.sweep()
	if report.BlobsDeleted != 0 || report.TombstonesDeleted != 1 {
		t.Fatalf("report = %+v, want the stale tombstone removed and nothing else", report)
	}
	if f.restore(repo, "k", "v1") == nil {
		t.Fatal("the live entry stopped answering restores")
	}
}

// An entry whose bytes are gone — the lifecycle backstop, an operator's own
// tool, a store that lost an object — is a miss, never a hit with a URL that
// 404s.
func TestAnEntryWhoseBlobIsGoneIsAMiss(t *testing.T) {
	f := newFixture(t, Retention{})
	entry := f.save(repo, main, "k", "v1", 10)
	f.store.Remove(entry.Blob)
	if got := f.restore(repo, "k", "v1"); got != nil {
		t.Fatalf("restore = %+v, want a miss", got)
	}

	// The miss marked the repository, so the next quota tick removes the
	// dangling entry, and the key can be saved again instead of being refused
	// as a duplicate of an entry nobody can restore.
	report, err := f.index.SweepDirty(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if report.EvictedDangling != 1 {
		t.Fatalf("report = %+v, want the dangling entry evicted", report)
	}
	exists, err := f.index.Exists(context.Background(), repo, main, "k", "v1")
	if err != nil || exists {
		t.Fatalf("Exists after the dangling entry went = %v, %v; want the key free to save", exists, err)
	}
	for _, key := range f.store.Keys() {
		t.Errorf("left behind: %s", key)
	}
}

// One process writes an entry's access marker at most once per granularity, so
// a hot entry costs the store a write every few minutes, not one per restore.
func TestAccessWritesAreDebounced(t *testing.T) {
	f := newFixture(t, Retention{AccessGranularity: 10 * time.Minute})
	f.save(repo, main, "hot", "v1", 10)
	marker := func() time.Time {
		t.Helper()
		for _, key := range f.store.Keys() {
			if strings.HasPrefix(key, accessRoot) {
				at, _ := f.store.Modified(key)
				return at
			}
		}
		return time.Time{}
	}

	f.advance(time.Minute)
	f.restore(repo, "hot", "v1")
	first := marker()
	if first.IsZero() {
		t.Fatal("a restore wrote no access marker")
	}
	f.advance(time.Minute)
	f.restore(repo, "hot", "v1")
	if got := marker(); !got.Equal(first) {
		t.Fatalf("marker rewritten after one minute (%s -> %s); want it debounced", first, got)
	}
	f.advance(10 * time.Minute)
	f.restore(repo, "hot", "v1")
	if got := marker(); !got.After(first) {
		t.Fatalf("marker not rewritten after the granularity elapsed: still %s", got)
	}
}

// A restore that raced an eviction can write a marker for an entry that no
// longer exists. The sweep removes it once it is old enough not to be a race.
func TestAMarkerForAnEvictedEntryIsCleanedUp(t *testing.T) {
	f := newFixture(t, Retention{MarkerGrace: time.Hour})
	f.store.Overwrite(accessRoot+entriesRoot+repositorySegment(repo)+"/refs~2Fheads~2Fmain/v/6b.0", []byte("x"))
	f.save(repo, main, "k", "v1", 10)
	f.advance(30 * time.Minute)
	if report := f.sweep(); report.MarkersDeleted != 0 {
		t.Fatalf("a young orphan marker was deleted: %+v", report)
	}
	f.advance(time.Hour)
	if report := f.sweep(); report.MarkersDeleted != 1 {
		t.Fatalf("report = %+v, want the orphan marker deleted", report)
	}
}

// The admin selectors: exact key, prefix, version and ref each narrow; All
// takes everything. None of them reaches another repository.
func TestRemoveSelectsWithinOneRepository(t *testing.T) {
	f := newFixture(t, Retention{})
	f.save(repo, main, "node-cache-linux-abc", "v1", 1)
	f.save(repo, main, "node-cache-linux-abc", "v2", 1)
	f.save(repo, "refs/heads/feature", "node-cache-linux-abc", "v1", 1)
	f.save(repo, main, "node-cache-macos-abc", "v1", 1)
	f.save(repo, main, "go-build-1", "v1", 1)
	f.save("other/repo", main, "node-cache-linux-abc", "v1", 1)
	ctx := context.Background()

	count := func(repository string) int {
		t.Helper()
		records, err := f.index.Entries(ctx, repository, Match{})
		if err != nil {
			t.Fatal(err)
		}
		return len(records)
	}

	removed, err := f.index.Remove(ctx, repo, Match{Key: "node-cache-linux-abc", Version: "v1", Ref: main})
	if err != nil || len(removed) != 1 {
		t.Fatalf("key+version+ref removed %d (%v), want 1", len(removed), err)
	}
	removed, err = f.index.Remove(ctx, repo, Match{Key: "node-cache-linux-abc"})
	if err != nil || len(removed) != 2 {
		t.Fatalf("key alone removed %d (%v), want the other version and the other ref", len(removed), err)
	}
	removed, err = f.index.Remove(ctx, repo, Match{Prefix: "node-cache-"})
	if err != nil || len(removed) != 1 || removed[0].Key != "node-cache-macos-abc" {
		t.Fatalf("prefix removed %+v (%v), want only the macOS entry", removed, err)
	}
	if count(repo) != 1 {
		t.Fatalf("%d entries left, want go-build-1 only", count(repo))
	}
	removed, err = f.index.Remove(ctx, repo, Match{All: true})
	if err != nil || len(removed) != 1 {
		t.Fatalf("all removed %d (%v), want 1", len(removed), err)
	}
	if count(repo) != 0 {
		t.Fatal("clear left entries behind")
	}
	if count("other/repo") != 1 {
		t.Fatal("deleting in one repository touched another repository's entry with the same key")
	}
}
