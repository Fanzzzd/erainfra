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
// A job of the repository that gave the name up can still save under it: its
// facts were issued while the repository had the name, and they stay valid
// for the controller's facts lifetime. Such a save must not take the name back
// from the repository that holds it now, or the two would remove each other's
// entries on every save until the old job ends. GitHub hands out repository
// IDs in increasing order, so a repository created under the name after the
// old one left has the larger ID, and a save from a smaller ID than the
// holder's is refused while the holder's claim is younger than
// staleSaveWindow. After that no job with old facts is left, so a smaller ID
// can only be an older repository renamed into the name, and it takes the
// name as any other.
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
// again. Until it does, claimName also refuses a smaller ID when the name
// holds a larger ID's entries from within staleSaveWindow.

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
	// staleSaveWindow is how long after a repository takes a name a save from
	// a smaller repository ID is refused. It is the controller's job facts
	// lifetime (cacheFactsTTL in apps/controller/cmd/runner-center-controller),
	// the longest a job of the repository that left the name can still save.
	staleSaveWindow = 6 * time.Hour
)

// ErrNameHeldByNewerRepository is a save refused because the repository name
// now belongs to a repository GitHub created later: the saving job is one of
// the repository that gave the name up. ClaimName returns it. Exists answers
// such a save as a key that exists, and Commit drops it, so the protocol
// handlers skip it the way they skip any save that is not needed.
var ErrNameHeldByNewerRepository = errors.New("this repository name now belongs to a newer repository; the save was not stored")

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
	holder nameRecord
	read   time.Time
}

func (m *nameMemo) get(segment string, now time.Time) (nameRecord, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	entry, ok := m.entries[segment]
	if !ok || now.Sub(entry.read) >= nameMemoTTL || now.Before(entry.read) {
		return nameRecord{}, false
	}
	return entry.holder, true
}

func (m *nameMemo) put(segment string, holder nameRecord, now time.Time) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.entries == nil {
		m.entries = map[string]nameMemoEntry{}
	}
	m.entries[segment] = nameMemoEntry{holder: holder, read: now}
}

// nameLocks serializes the claims on one name within this process. The first
// save under a new ID reads every entry the name has, which after an upgrade
// is every entry saved before IDs were recorded. Without the lock each of a
// matrix's first saves would read them all at once. With it, the first one
// claims and the rest find the name already theirs in the memo. Saves under
// different names do not wait for each other. Replicas are not serialized:
// each reads the name once.
type nameLocks struct {
	mu   sync.Mutex
	held map[string]*nameLock
}

type nameLock struct {
	token chan struct{}
	users int
}

// lock takes the name's lock, or gives up when ctx ends first.
func (l *nameLocks) lock(ctx context.Context, segment string) (func(), error) {
	l.mu.Lock()
	if l.held == nil {
		l.held = map[string]*nameLock{}
	}
	lock := l.held[segment]
	if lock == nil {
		lock = &nameLock{token: make(chan struct{}, 1)}
		l.held[segment] = lock
	}
	lock.users++
	l.mu.Unlock()

	select {
	case lock.token <- struct{}{}:
		return func() {
			<-lock.token
			l.leave(segment, lock)
		}, nil
	case <-ctx.Done():
		l.leave(segment, lock)
		return nil, ctx.Err()
	}
}

func (l *nameLocks) leave(segment string, lock *nameLock) {
	l.mu.Lock()
	defer l.mu.Unlock()
	lock.users--
	if lock.users == 0 {
		delete(l.held, segment)
	}
}

func nameRecordObject(repository string) string {
	return namesRoot + repositorySegment(repository)
}

// nameHolder is the record of the repository ID that holds a name, with a zero
// ID when no save with an ID has been made under it.
func (i *Index) nameHolder(ctx context.Context, repository string) (nameRecord, error) {
	segment := repositorySegment(repository)
	if holder, ok := i.names.get(segment, i.now()); ok {
		return holder, nil
	}
	body, err := i.store.GetBytes(ctx, nameRecordObject(repository), maxNameRecordBytes)
	if err != nil {
		if errors.Is(err, objectstore.ErrNotFound) {
			i.names.put(segment, nameRecord{}, i.now())
			return nameRecord{}, nil
		}
		return nameRecord{}, err
	}
	var record nameRecord
	if err := json.Unmarshal(body, &record); err != nil || record.RepositoryID < 0 {
		// A record this service cannot read says nothing about whose the
		// entries are. Answering zero keeps today's by-name behaviour for
		// entries without an ID; entries with one are still checked against it.
		i.logger.Warn("repository name record does not parse", "repository", repository, "error", err)
		i.names.put(segment, nameRecord{}, i.now())
		return nameRecord{}, nil
	}
	i.names.put(segment, record, i.now())
	return record, nil
}

// nameOwner is the repository ID that holds a name, or zero when no save with
// an ID has been made under it.
func (i *Index) nameOwner(ctx context.Context, repository string) (int64, error) {
	holder, err := i.nameHolder(ctx, repository)
	return holder.RepositoryID, err
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

// supersedes reports whether the holder's claim on a name refuses a save from
// id: the holder is a repository GitHub created after id's, and it took the
// name recently enough that id's save can come from a job that started before
// the name changed hands.
func (i *Index) supersedes(holder nameRecord, id int64) bool {
	return id > 0 && holder.RepositoryID > id &&
		i.now().Sub(time.UnixMilli(holder.Since)) < staleSaveWindow
}

// Superseded reports whether a save from id under the repository name would be
// refused with ErrNameHeldByNewerRepository. It changes nothing; the git seed
// lookup asks it so a guest does not build a seed that cannot be stored.
func (i *Index) Superseded(ctx context.Context, repository string, id int64) (bool, error) {
	holder, err := i.nameHolder(ctx, repository)
	if err != nil {
		return false, err
	}
	return i.supersedes(holder, id), nil
}

// StaleSavesRefused is how many saves this process has refused with
// ErrNameHeldByNewerRepository. The service's /metrics reports it.
func (i *Index) StaleSavesRefused() int64 {
	return i.staleSaves.Load()
}

// ClaimName makes sure the name's entries belong to id before id writes under
// it, for a save that does not go through Exists or Commit first (the git
// seed's, which removes the older seeds in its scope before it commits). It
// returns ErrNameHeldByNewerRepository when id may not save under the name.
func (i *Index) ClaimName(ctx context.Context, repository string, id int64) error {
	return i.claimName(ctx, repository, id)
}

func (i *Index) refuseStaleSave(repository string, id int64, holder nameRecord, reason string) error {
	i.staleSaves.Add(1)
	i.logger.Warn("refused a save from a repository that gave this name up; the name belongs to a newer repository",
		"repository", repository, "repositoryId", id, "heldBy", holder.RepositoryID,
		"heldSince", time.UnixMilli(holder.Since).UTC(), "reason", reason)
	return ErrNameHeldByNewerRepository
}

// claimName makes sure the name's entries belong to id before id saves one.
//
// The first save under a new ID is where a name changes hands. It removes every
// entry another ID saved, and, when the name was already held by another ID,
// the entries without one too: those were adopted by that ID. Only then is the
// name record moved, so that a lookup in between still answers the old entries
// as a miss rather than as this ID's. A crash in between leaves the record
// where it was, and the next save does the whole of it again.
//
// A save from a smaller ID than the holder's, within staleSaveWindow of the
// holder's claim, is refused before anything is removed (see the top of this
// file).
func (i *Index) claimName(ctx context.Context, repository string, id int64) error {
	if id <= 0 {
		return nil
	}
	holder, err := i.nameHolder(ctx, repository)
	if err != nil {
		return err
	}
	if holder.RepositoryID == id {
		return nil
	}
	if i.supersedes(holder, id) {
		return i.refuseStaleSave(repository, id, holder, "name record")
	}

	unlock, err := i.nameLocks.lock(ctx, repositorySegment(repository))
	if err != nil {
		return err
	}
	defer unlock()
	// Another save may have claimed the name while this one waited.
	if holder, err = i.nameHolder(ctx, repository); err != nil {
		return err
	}
	if holder.RepositoryID == id {
		return nil
	}
	if i.supersedes(holder, id) {
		return i.refuseStaleSave(repository, id, holder, "name record")
	}
	held := holder.RepositoryID

	records, err := i.Entries(ctx, repository, Match{})
	if err != nil {
		return err
	}
	// The name record can be gone while a newer repository's entries are not:
	// the lifecycle rule ages the record out from when it was written, and the
	// holder's later entries are younger. Those entries are evidence of the
	// holder as good as the record.
	for _, record := range records {
		newer := nameRecord{Repository: repository, RepositoryID: record.RepositoryID, Since: record.CreatedAt}
		if i.supersedes(newer, id) {
			return i.refuseStaleSave(repository, id, newer, "newer entry")
		}
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
	claim := nameRecord{Repository: repository, RepositoryID: id, Since: i.now().UnixMilli()}
	body, err := json.Marshal(claim)
	if err != nil {
		return err
	}
	if err := i.store.PutBytes(ctx, nameRecordObject(repository), "application/json", body); err != nil {
		return err
	}
	i.names.put(repositorySegment(repository), claim, i.now())
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
