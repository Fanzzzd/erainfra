package cacheindex

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Fanzzzd/erainfra/apps/cache-service/cachetoken"
)

const (
	renamedRepo = "acme/app"
	oldID       = int64(1001)
	newID       = int64(2002)
)

func claimsFor(id int64) cachetoken.Claims {
	return cachetoken.Claims{Repository: renamedRepo, RepositoryID: id, Ref: "refs/heads/main"}
}

func (f *fixture) saveAs(id int64, key string) Entry {
	f.t.Helper()
	blob := "blobs/" + repositorySegment(renamedRepo) + "/" + hex.EncodeToString([]byte(key))
	f.store.Overwrite(blob, []byte(key))
	entry := Entry{
		Key: key, Version: "v1", Repository: renamedRepo, RepositoryID: id,
		Ref: "refs/heads/main", Blob: blob, Size: int64(len(key)),
	}
	if _, err := f.index.Exists(context.Background(), claimsFor(id), key, "v1"); err != nil {
		f.t.Fatal(err)
	}
	if err := f.index.Commit(context.Background(), entry); err != nil {
		f.t.Fatal(err)
	}
	f.advance(time.Second)
	return entry
}

func (f *fixture) lookupAs(id int64, key string) *Entry {
	f.t.Helper()
	entry, err := f.index.Lookup(context.Background(), claimsFor(id), []string{key}, "v1")
	if err != nil {
		f.t.Fatal(err)
	}
	return entry
}

func (f *fixture) keysOf(id int64) []string {
	f.t.Helper()
	records, err := f.index.Entries(context.Background(), renamedRepo, Match{})
	if err != nil {
		f.t.Fatal(err)
	}
	var keys []string
	for _, record := range records {
		if record.RepositoryID == id {
			keys = append(keys, record.Key)
		}
	}
	return keys
}

// An entry records the repository ID that saved it, and a token for another ID
// does not restore it, by exact key or by prefix, in any of its read scopes.
func TestEntryIsReadOnlyByTheRepositoryIDThatSavedIt(t *testing.T) {
	f := newFixture(t, Retention{})
	f.saveAs(oldID, "deps-linux")

	if entry := f.lookupAs(oldID, "deps-linux"); entry == nil || entry.RepositoryID != oldID {
		t.Fatalf("the saving repository's lookup = %+v, want its entry", entry)
	}
	if entry := f.lookupAs(newID, "deps-linux"); entry != nil {
		t.Fatalf("another repository of the same name restored %+v", entry)
	}
	if entry := f.lookupAs(newID, "deps-"); entry != nil {
		t.Fatalf("another repository's prefix restore matched %+v", entry)
	}
	feature := claimsFor(newID)
	feature.Ref, feature.DefaultBranch = "refs/heads/feature", "refs/heads/main"
	if entry, err := f.index.LookupExact(context.Background(), feature, "deps-linux", "v1"); err != nil || entry != nil {
		t.Fatalf("another repository's default-branch fallback = %+v, %v; want a miss", entry, err)
	}
	// A controller from before the ID was pushed reads by name, as it did.
	if entry := f.lookupAs(0, "deps-linux"); entry == nil {
		t.Fatal("a token without an ID lost the by-name restore it had")
	}
}

// A lookup reads past another repository's newer entry to this repository's
// older one rather than answering a miss.
func TestLookupReadsPastAnotherRepositorysNewerEntry(t *testing.T) {
	f := newFixture(t, Retention{})
	own := f.saveAs(newID, "deps-a")

	// The other repository's entry is newer and was never removed: a purge that
	// stopped part way, say. It is written the way Commit lays it out.
	foreign := Entry{
		Key: "deps-b", Version: "v1", Repository: renamedRepo, RepositoryID: oldID,
		Ref: "refs/heads/main", Blob: own.Blob, Size: own.Size, CreatedAt: f.at.UnixMilli(),
	}
	body, err := json.Marshal(foreign)
	if err != nil {
		t.Fatal(err)
	}
	f.store.Overwrite(scopePrefix(renamedRepo, "refs/heads/main", versionSegment("v1"))+
		hex.EncodeToString([]byte("deps-b"))+"."+recencySuffix(foreign.CreatedAt), body)

	if entry := f.lookupAs(newID, "deps-"); entry == nil || entry.Key != "deps-a" {
		t.Fatalf("prefix lookup = %+v, want this repository's own deps-a", entry)
	}
	if entry := f.lookupAs(0, "deps-"); entry == nil || entry.Key != "deps-b" {
		t.Fatalf("a token without an ID = %+v, want the newest entry by name", entry)
	}
}

// The first save under a new ID is where the name changes hands: the earlier
// repository's entries go, the key it held is free to save again, and the name
// record says who holds it now.
func TestFirstSaveUnderANewIDRemovesTheEarlierRepositorysEntries(t *testing.T) {
	f := newFixture(t, Retention{})
	f.saveAs(oldID, "deps-linux")
	f.saveAs(oldID, "go-build")

	exists, err := f.index.Exists(context.Background(), claimsFor(newID), "deps-linux", "v1")
	if err != nil || exists {
		t.Fatalf("Exists for the new repository = %v, %v; want the old repository's key free", exists, err)
	}
	if keys := f.keysOf(oldID); len(keys) != 0 {
		t.Fatalf("the earlier repository's entries survived the new one's first save: %v", keys)
	}
	if holder, err := f.index.NameOwner(context.Background(), renamedRepo); err != nil || holder != newID {
		t.Fatalf("name holder = %d, %v; want %d", holder, err, newID)
	}
	f.saveAs(newID, "deps-linux")
	if entry := f.lookupAs(newID, "deps-linux"); entry == nil || entry.RepositoryID != newID {
		t.Fatalf("the new repository's own save = %+v", entry)
	}

	// A process that has never seen the name reads the holder from the bucket.
	fresh := New(f.index.store, f.index.logger)
	fresh.Now = f.index.Now
	if holder, err := fresh.NameOwner(context.Background(), renamedRepo); err != nil || holder != newID {
		t.Fatalf("a fresh process reads the holder as %d, %v; want %d", holder, err, newID)
	}
}

// Entries saved before IDs were recorded keep working: the first ID that saves
// under the name adopts them. A different ID saving later removes them, so
// that is the end of the window in which they reach another repository.
func TestEntriesWithoutAnIDBelongToTheFirstIDThatSaves(t *testing.T) {
	f := newFixture(t, Retention{})
	legacy := f.saveAs(0, "deps-legacy")

	// The stored document is the shape an older service wrote and reads.
	for _, key := range f.store.Keys() {
		if strings.HasPrefix(key, entriesRoot) {
			body, _ := f.store.Object(key)
			if strings.Contains(string(body), "repositoryId") {
				t.Fatalf("an entry saved without an ID carries one: %s", body)
			}
		}
	}

	// No save with an ID yet: by name, as before, for every token.
	if entry := f.lookupAs(oldID, legacy.Key); entry == nil {
		t.Fatal("an entry saved before IDs were recorded is no longer restored")
	}

	f.saveAs(oldID, "deps-new")
	if entry := f.lookupAs(oldID, legacy.Key); entry == nil {
		t.Fatal("the first ID to save lost the entries it adopted")
	}
	if entry := f.lookupAs(newID, legacy.Key); entry != nil {
		t.Fatalf("another ID restored an entry the holder adopted: %+v", entry)
	}
	if entry := f.lookupAs(0, legacy.Key); entry == nil {
		t.Fatal("a token without an ID lost the by-name restore it had")
	}

	f.saveAs(newID, "deps-mine")
	if keys := f.keysOf(0); len(keys) != 0 {
		t.Fatalf("the adopted entries survived the name changing hands: %v", keys)
	}
	if keys := f.keysOf(oldID); len(keys) != 0 {
		t.Fatalf("the earlier ID's entries survived the name changing hands: %v", keys)
	}
	if keys := f.keysOf(newID); len(keys) != 1 || keys[0] != "deps-mine" {
		t.Fatalf("the new holder's entries = %v, want its own", keys)
	}
}

func TestMatchNarrowsByRepositoryID(t *testing.T) {
	record := Record{Entry: Entry{Key: "k", RepositoryID: oldID}}
	if !(Match{}).Matches(record) || !(Match{RepositoryID: oldID}).Matches(record) {
		t.Fatal("a match without an ID, or with the entry's, must select it")
	}
	if (Match{RepositoryID: newID}).Matches(record) {
		t.Fatal("a match for another ID selected the entry")
	}
	if (Match{RepositoryID: newID}).Matches(Record{Entry: Entry{Key: "k"}}) {
		t.Fatal("a match for an ID selected an entry saved without one")
	}
}

// staleEntry is a save from the repository that gave the name up, as a job of
// it that was already running when the name moved makes one.
func staleEntry(key string) Entry {
	return Entry{
		Key: key, Version: "v1", Repository: renamedRepo, RepositoryID: oldID,
		Ref: "refs/heads/main", Blob: "blobs/" + repositorySegment(renamedRepo) + "/stale", Size: 1,
	}
}

// A job of the renamed-away repository saves after the new repository took
// the name. The save is skipped: it does not remove the holder's entries, does
// not take the name back, and is counted.
func TestASaveFromASmallerIDDoesNotTakeTheNameBack(t *testing.T) {
	f := newFixture(t, Retention{})
	f.saveAs(newID, "deps-new")

	exists, err := f.index.Exists(context.Background(), claimsFor(oldID), "deps-stale", "v1")
	if err != nil || !exists {
		t.Fatalf("Exists for the stale repository = %v, %v; want it answered as an existing key", exists, err)
	}
	if err := f.index.Commit(context.Background(), staleEntry("deps-stale")); err != nil {
		t.Fatalf("Commit for the stale repository = %v; want the save dropped without an error", err)
	}
	if keys := f.keysOf(newID); len(keys) != 1 || keys[0] != "deps-new" {
		t.Fatalf("the holder's entries = %v, want deps-new", keys)
	}
	if keys := f.keysOf(oldID); len(keys) != 0 {
		t.Fatalf("the stale save was published: %v", keys)
	}
	if holder, err := f.index.NameOwner(context.Background(), renamedRepo); err != nil || holder != newID {
		t.Fatalf("name holder = %d, %v; want %d", holder, err, newID)
	}
	if err := f.index.ClaimName(context.Background(), renamedRepo, oldID); !errors.Is(err, ErrNameHeldByNewerRepository) {
		t.Fatalf("ClaimName for the stale repository = %v, want ErrNameHeldByNewerRepository", err)
	}
	if superseded, err := f.index.Superseded(context.Background(), renamedRepo, oldID); err != nil || !superseded {
		t.Fatalf("Superseded = %v, %v; want true", superseded, err)
	}
	if got := f.index.StaleSavesRefused(); got != 3 {
		t.Fatalf("refused saves counted = %d, want 3 (Exists, Commit, ClaimName)", got)
	}

	// The holder keeps saving as before.
	f.saveAs(newID, "deps-next")
	if keys := f.keysOf(newID); len(keys) != 2 {
		t.Fatalf("the holder's entries after its next save = %v", keys)
	}
}

// Past the window no job with the old facts is left, so a smaller ID is an
// older repository renamed into the name, and it takes the name as any other.
func TestAnOlderRepositoryRenamedIntoTheNameTakesItAfterTheWindow(t *testing.T) {
	f := newFixture(t, Retention{})
	f.saveAs(newID, "deps-new")

	f.advance(staleSaveWindow - time.Minute)
	if exists, err := f.index.Exists(context.Background(), claimsFor(oldID), "deps-renamed-in", "v1"); err != nil || !exists {
		t.Fatalf("inside the window Exists = %v, %v; want the save refused", exists, err)
	}
	f.advance(2 * time.Minute)
	f.saveAs(oldID, "deps-renamed-in")
	if holder, err := f.index.NameOwner(context.Background(), renamedRepo); err != nil || holder != oldID {
		t.Fatalf("name holder = %d, %v; want %d", holder, err, oldID)
	}
	if keys := f.keysOf(newID); len(keys) != 0 {
		t.Fatalf("the repository that left the name kept its entries: %v", keys)
	}
	if keys := f.keysOf(oldID); len(keys) != 1 {
		t.Fatalf("the repository renamed in = %v, want its own save", keys)
	}
}

// The lifecycle rule can age the name record out while the holder's later
// entries remain. Those entries still refuse a smaller ID.
func TestAStaleSaveIsRefusedWhenTheNameRecordIsGone(t *testing.T) {
	f := newFixture(t, Retention{})
	f.saveAs(newID, "deps-new")
	f.store.Remove(nameRecordObject(renamedRepo))
	fresh := New(f.index.store, f.index.logger)
	fresh.Now = f.index.Now

	if exists, err := fresh.Exists(context.Background(), claimsFor(oldID), "deps-stale", "v1"); err != nil || !exists {
		t.Fatalf("Exists = %v, %v; want the save refused", exists, err)
	}
	if keys := f.keysOf(newID); len(keys) != 1 {
		t.Fatalf("the holder's entries = %v, want deps-new", keys)
	}
	if fresh.StaleSavesRefused() != 1 {
		t.Fatalf("refused saves counted = %d, want 1", fresh.StaleSavesRefused())
	}
}

// After an upgrade every name holds entries without an ID, and the first save
// under an ID reads all of them. A matrix's first saves arrive together; they
// read the name once, not once each.
func TestConcurrentFirstSavesUnderANameReadItsEntriesOnce(t *testing.T) {
	f := newFixture(t, Retention{})
	for _, key := range []string{"legacy-a", "legacy-b", "legacy-c"} {
		f.saveAs(0, key)
	}

	const savers = 6
	var mu sync.Mutex
	scans := 0
	allScanning := make(chan struct{})
	// Each full read of the name lists entries/<owner>/<name>/ from the start.
	// It is held until every saver has started one, or for 300 ms, so that
	// saves which do not wait for each other are all seen reading.
	f.store.SetFail(func(method, key string, query map[string][]string) int {
		if method != http.MethodGet || key != "" ||
			strings.Join(query["prefix"], "") != entriesRoot+repositorySegment(renamedRepo)+"/" ||
			strings.Join(query["start-after"], "") != "" {
			return 0
		}
		mu.Lock()
		scans++
		if scans == savers {
			close(allScanning)
		}
		mu.Unlock()
		select {
		case <-allScanning:
		case <-time.After(300 * time.Millisecond):
		}
		return 0
	})

	var wg sync.WaitGroup
	errs := make(chan error, savers)
	for n := range savers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := f.index.Exists(context.Background(), claimsFor(newID), fmt.Sprintf("deps-%d", n), "v1")
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	f.store.SetFail(nil)
	if scans != 1 {
		t.Fatalf("%d concurrent first saves read the name's entries %d times, want once", savers, scans)
	}
	if holder, err := f.index.NameOwner(context.Background(), renamedRepo); err != nil || holder != newID {
		t.Fatalf("name holder = %d, %v; want %d", holder, err, newID)
	}
}

// A waiter whose request ends while another save holds the name's lock gives
// up rather than waiting on.
func TestAClaimWaitingForTheNameGivesUpWithItsRequest(t *testing.T) {
	var locks nameLocks
	unlock, err := locks.lock(context.Background(), "acme/app")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := locks.lock(ctx, "acme/app"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("a waiter past its deadline = %v, want context.DeadlineExceeded", err)
	}
	if _, err := locks.lock(context.Background(), "acme/other"); err != nil {
		t.Fatalf("another name waited on this one: %v", err)
	}
	unlock()
	locks.mu.Lock()
	left := len(locks.held)
	locks.mu.Unlock()
	if left != 1 {
		t.Fatalf("locks held after release = %d, want only acme/other's", left)
	}
}
