package cacheindex

// Ownership: which repository a name's entries belong to.
//
// Entries live under the repository's name, "owner/name", because that is what
// an operator writes a lifecycle rule against and what every deployed store
// already holds. A name is not a repository, though. One deleted, or renamed
// away, and then created again under the same name is a different repository,
// and GitHub deletes a repository's Actions cache with it. So every entry also
// records GitHub's ID for the repository that saved it, and a token whose facts
// carry an ID reads only entries saved under that ID.
//
// Entries saved before the ID was recorded carry none, and a controller from
// before the ID was pushed issues facts with none. Both keep working by name.
// For those entries the name record below says whose they are: the first
// repository ID that saves under a name after this change adopts every entry
// already there, and a different ID saving later removes them along with the
// earlier ID's own. That is the whole window in which a name's entries can
// reach a different repository: it is open only until the first save that
// carries an ID, and a token without an ID (an older controller) reads by name
// for as long as it is in use.
//
// The layout, beside entries/ and blobs/:
//
//	names/<owner>/<name>   one per repository name that has been saved under
//	                       with an ID: {"repository", "repositoryId", "since"}.
//
// The bucket's backstop lifecycle rule ages these out with everything else
// below the prefix. That is safe for the entries saved before IDs were
// recorded: the record was written after them, so the rule has removed them
// by the time it removes the record. The holder's next save writes the record
// again.

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/Fanzzzd/erainfra/apps/cache-service/cachetoken"
	"github.com/Fanzzzd/erainfra/apps/cache-service/internal/objectstore"
)

const (
	namesRoot = "names/"
	// maxNameRecordBytes bounds a name record read. The document is under a
	// hundred bytes.
	maxNameRecordBytes = 4 << 10
	// nameMemoTTL is how long a process trusts the name record it last read.
	// Another replica can move a name to a new ID in between; what that
	// replica does first (removing every entry the old ID owned) is what keeps
	// a stale answer here from serving them, so this bounds only how often the
	// record is reread.
	nameMemoTTL = time.Minute
	// maxPassedCandidates bounds how many entries a lookup reads past in one
	// scope before it answers a miss: ones that raced an eviction, do not
	// parse, or another repository saved. The first save under a new ID
	// removes the last kind, so a lookup meets them only between a name
	// changing hands and that save.
	maxPassedCandidates = 8
)

// nameRecord is the ID a repository name's entries belong to.
type nameRecord struct {
	Repository   string `json:"repository"`
	RepositoryID int64  `json:"repositoryId"`
	// Since is unix milliseconds: when this ID took the name.
	Since int64 `json:"since"`
}

type nameMemo struct {
	mu      sync.Mutex
	entries map[string]nameMemoEntry
}

type nameMemoEntry struct {
	id   int64
	read time.Time
}

func (m *nameMemo) get(segment string, now time.Time) (int64, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	entry, ok := m.entries[segment]
	if !ok || now.Sub(entry.read) >= nameMemoTTL || now.Before(entry.read) {
		return 0, false
	}
	return entry.id, true
}

func (m *nameMemo) put(segment string, id int64, now time.Time) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.entries == nil {
		m.entries = map[string]nameMemoEntry{}
	}
	m.entries[segment] = nameMemoEntry{id: id, read: now}
}

func nameRecordObject(repository string) string {
	return namesRoot + repositorySegment(repository)
}

// nameOwner is the repository ID that holds a name, or zero when no save with
// an ID has been made under it.
func (i *Index) nameOwner(ctx context.Context, repository string) (int64, error) {
	segment := repositorySegment(repository)
	if id, ok := i.names.get(segment, i.now()); ok {
		return id, nil
	}
	body, err := i.store.GetBytes(ctx, nameRecordObject(repository), maxNameRecordBytes)
	if err != nil {
		if errors.Is(err, objectstore.ErrNotFound) {
			i.names.put(segment, 0, i.now())
			return 0, nil
		}
		return 0, err
	}
	var record nameRecord
	if err := json.Unmarshal(body, &record); err != nil || record.RepositoryID < 0 {
		// A record this service cannot read says nothing about whose the
		// entries are. Answering zero keeps today's by-name behaviour for
		// entries without an ID; entries with one are still checked against it.
		i.logger.Warn("repository name record does not parse", "repository", repository, "error", err)
		i.names.put(segment, 0, i.now())
		return 0, nil
	}
	i.names.put(segment, record.RepositoryID, i.now())
	return record.RepositoryID, nil
}

// ownedBy reports whether an entry was saved by the repository a token is for.
func (i *Index) ownedBy(ctx context.Context, claims cachetoken.Claims, entry *Entry) (bool, error) {
	if claims.RepositoryID == 0 {
		// An older controller pushed no ID. Its jobs read by name, as before.
		return true, nil
	}
	owner := entry.RepositoryID
	if owner == 0 {
		// Saved before IDs were recorded, or by a job whose facts had none:
		// it belongs to whichever ID holds the name.
		var err error
		if owner, err = i.nameOwner(ctx, claims.Repository); err != nil {
			return false, err
		}
	}
	return owner == 0 || owner == claims.RepositoryID, nil
}

// claimName makes sure the name's entries belong to id before id saves one.
//
// The first save under a new ID is where a name changes hands. It removes every
// entry another ID saved, and, when the name was already held by another ID,
// the entries without one too: those were adopted by that ID. Only then is the
// name record moved, so that a lookup in between still answers the old entries
// as a miss rather than as this ID's. A crash in between leaves the record
// where it was, and the next save does the whole of it again.
func (i *Index) claimName(ctx context.Context, repository string, id int64) error {
	if id <= 0 {
		return nil
	}
	held, err := i.nameOwner(ctx, repository)
	if err != nil {
		return err
	}
	if held == id {
		return nil
	}
	records, err := i.Entries(ctx, repository, Match{})
	if err != nil {
		return err
	}
	removed := 0
	for _, record := range records {
		if record.RepositoryID == id {
			continue
		}
		if record.RepositoryID == 0 && held == 0 {
			// Nobody has claimed the name with an ID yet, so these are
			// adopted rather than removed: they were saved by name, by the
			// repository that held the name before IDs were recorded.
			continue
		}
		if err := i.evict(ctx, record); err != nil {
			return err
		}
		removed++
		i.logger.Info("cache entry evicted", "reason", "repository changed",
			"repository", record.Repository, "ref", record.Ref, "key", record.Key,
			"bytes", record.Size, "savedBy", record.RepositoryID, "heldBy", held, "repositoryId", id)
	}
	if removed > 0 {
		i.markDirty(repository)
	}
	body, err := json.Marshal(nameRecord{Repository: repository, RepositoryID: id, Since: i.now().UnixMilli()})
	if err != nil {
		return err
	}
	if err := i.store.PutBytes(ctx, nameRecordObject(repository), "application/json", body); err != nil {
		return err
	}
	i.names.put(repositorySegment(repository), id, i.now())
	if held != 0 {
		i.logger.Warn("a repository name changed hands; the earlier repository's cache entries were removed",
			"repository", repository, "from", held, "to", id, "removed", removed)
	}
	return nil
}

// NameOwner is the repository ID a name's entries belong to, or zero when no
// save with an ID has been made under it. The admin API reports it.
func (i *Index) NameOwner(ctx context.Context, repository string) (int64, error) {
	return i.nameOwner(ctx, repository)
}
