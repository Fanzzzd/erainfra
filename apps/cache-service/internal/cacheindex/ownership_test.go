package cacheindex

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"strings"
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
