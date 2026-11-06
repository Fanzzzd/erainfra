// Package cacheindex owns what a cache key means in a bucket: how an entry is
// named, which entries a token may see, and in what order a restore matches
// them.
//
// It is separate from the protocol handlers because both generations ask the
// same three questions — does this key match anything I may read, where are its
// bytes, and may I write this key — and neither generation may be able to
// answer them differently.
package cacheindex

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Fanzzzd/erainfra/apps/cache-service/cachetoken"
	"github.com/Fanzzzd/erainfra/apps/cache-service/internal/objectstore"
)

// maxEntryMetadataBytes bounds what a metadata read will pull into memory. The
// documents this package writes are a few hundred bytes.
const maxEntryMetadataBytes = 64 << 10

// defaultMaxCandidates bounds a prefix listing. A prefix match is already
// narrowed to one repository, one ref and one version, so a page this size
// being full means something pathological is happening and the log line below
// says so rather than the newest match silently coming out of the wrong set.
const defaultMaxCandidates = 256

// Entry is one cache entry's metadata, stored as a small JSON object next to
// the blob it names.
type Entry struct {
	Key        string `json:"key"`
	Version    string `json:"version"`
	Repository string `json:"repository"`
	// RepositoryID is GitHub's ID for the repository that saved the entry,
	// from the job's facts. Zero for an entry saved before it was recorded or
	// by a job whose facts carried none; ownership.go says whose those are.
	RepositoryID int64  `json:"repositoryId,omitempty"`
	Ref          string `json:"ref"`
	Blob         string `json:"blob"`
	Size         int64  `json:"size"`
	// CreatedAt is unix milliseconds. It is also encoded into the metadata
	// object's own name, inverted, so a listing sorts newest-first without a
	// read per candidate.
	CreatedAt int64 `json:"createdAt"`
	// Attributes are what a protocol has to hand back with a hit besides the
	// bytes: the Go build cache's output ID, Turborepo's task duration and
	// signature tag. The actions/cache protocols store none, and an entry they
	// wrote decodes with this empty.
	Attributes map[string]string `json:"attributes,omitempty"`
	// Object is the name of the metadata object this entry was read from. It
	// is not stored: it is where the entry was found, which is what an access
	// marker and an eviction are keyed by.
	Object string `json:"-"`
}

// Index answers key questions against a bucket.
type Index struct {
	store  objectstore.Store
	logger *slog.Logger
	// Now is the clock. Tests replace it so "newest wins" is decidable rather
	// than a race with the wall clock.
	Now           func() time.Time
	MaxCandidates int
	// Retention is the eviction policy. A zero field takes its default.
	Retention Retention

	access    accessLog
	memo      metadataMemo
	names     nameMemo
	nameLocks nameLocks
	// staleSaves counts saves refused because the name belongs to a newer
	// repository (see claimName).
	staleSaves atomic.Int64

	dirtyMu sync.Mutex
	dirty   map[string]struct{}
	sweepMu sync.Mutex
}

func New(store objectstore.Store, logger *slog.Logger) *Index {
	if logger == nil {
		logger = slog.Default()
	}
	return &Index{store: store, logger: logger, MaxCandidates: defaultMaxCandidates}
}

func (i *Index) now() time.Time {
	if i.Now != nil {
		return i.Now()
	}
	return time.Now()
}

func (i *Index) maxCandidates() int {
	if i.MaxCandidates > 0 {
		return i.MaxCandidates
	}
	return defaultMaxCandidates
}

// Lookup resolves a restore. keys arrive in the client's order: v1 sends them
// comma-separated in `keys`, v2 sends `key` followed by `restore_keys`.
//
// The ordering is key-major and scope-minor, and both halves are decisions
// rather than measurements. The capture establishes only that a key is
// prefix-matched — L072 answers a request for `index-D1-1-f921bd05` with
// `index-D1-1-f921bd05#1` — and it contains no multi-entry restore_keys case
// and no ref other than refs/heads/main (ADR 0007, "What this did not
// measure"). So:
//
//   - key-major: a more specific key wins over a nearer scope, because the
//     client ordered the keys and did not order the scopes. A restore that
//     preferred a stale own-branch prefix match over an exact match on the
//     default branch would restore the wrong lockfile's store.
//   - exact before prefix, within a key.
//   - scopes in the order the token fixes: own ref, base ref, default branch.
//     A sibling branch is not in that list, so no request can reach one.
//
// A miss is (nil, nil): every caller turns it into the protocol's own miss
// shape, which is never a 404 (capture L001, L007).
func (i *Index) Lookup(ctx context.Context, claims cachetoken.Claims, keys []string, version string) (*Entry, error) {
	scopes := claims.ReadScopes()
	if len(scopes) == 0 {
		return nil, nil
	}
	versionSegment := versionSegment(version)

	for _, key := range keys {
		key = strings.TrimSpace(key)
		if key == "" {
			continue
		}
		encoded := hex.EncodeToString([]byte(key))
		// Exact first. The metadata object's name is the key's hex followed by
		// a dot, and hex never contains a dot, so this prefix cannot reach a
		// longer key by accident.
		for _, ref := range scopes {
			entry, err := i.newest(ctx, claims, ref, versionSegment, encoded+".", version)
			if err != nil {
				return nil, err
			}
			if entry != nil {
				i.recordAccess(entry.Object)
				return entry, nil
			}
		}
		// Then prefix. Hex is a byte-for-byte encoding, so a hex prefix of even
		// length is exactly a prefix of the decoded key — which is what makes
		// the store's own prefix listing the whole of the prefix match.
		for _, ref := range scopes {
			entry, err := i.newest(ctx, claims, ref, versionSegment, encoded, version)
			if err != nil {
				return nil, err
			}
			if entry != nil {
				i.recordAccess(entry.Object)
				return entry, nil
			}
		}
	}
	return nil, nil
}

// LookupExact resolves one key with no prefix match, in the same scope order as
// Lookup: own ref, base ref, default branch. The build-system caches use it
// because their keys are content hashes, and a hash that merely starts with
// the one asked for names a different build's output.
func (i *Index) LookupExact(ctx context.Context, claims cachetoken.Claims, key, version string) (*Entry, error) {
	key = strings.TrimSpace(key)
	if key == "" {
		return nil, nil
	}
	versionSegment := versionSegment(version)
	encoded := hex.EncodeToString([]byte(key)) + "."
	for _, ref := range claims.ReadScopes() {
		entry, err := i.newest(ctx, claims, ref, versionSegment, encoded, version)
		if err != nil {
			return nil, err
		}
		if entry != nil {
			i.recordAccess(entry.Object)
			return entry, nil
		}
	}
	return nil, nil
}

// newest lists one scope and returns the most recently created match that the
// token's repository saved. Another repository's entry under the same name is
// read past, as if it were not there: a token whose facts carry GitHub's
// repository ID never restores an entry saved under a different one.
func (i *Index) newest(ctx context.Context, claims cachetoken.Claims, ref, versionSegment, encodedKey, version string) (*Entry, error) {
	repository := claims.Repository
	prefix := scopePrefix(repository, ref, versionSegment) + encodedKey
	objects, truncated, err := i.store.List(ctx, prefix, i.maxCandidates())
	if err != nil {
		return nil, err
	}
	if truncated {
		i.logger.Warn("cache key prefix has more entries than one listing page",
			"repository", repository, "ref", ref, "candidates", len(objects))
	}

	// The stamp is the creation time subtracted from the largest int64 and
	// printed at a fixed width, so the smallest stamp is the newest entry and a
	// plain string comparison orders them.
	candidates := make([]string, 0, len(objects))
	for _, object := range objects {
		if recencyStamp(object.Key) != "" {
			candidates = append(candidates, object.Key)
		}
	}
	sort.Slice(candidates, func(a, b int) bool {
		return recencyStamp(candidates[a]) < recencyStamp(candidates[b])
	})

	passed := 0
	for _, object := range candidates {
		entry, err := i.candidate(ctx, object, repository, ref, version)
		if err != nil {
			return nil, err
		}
		if entry != nil {
			owned, err := i.ownedBy(ctx, claims, entry)
			if err != nil {
				return nil, err
			}
			if owned {
				return i.servable(ctx, entry, repository)
			}
			i.logger.Info("cache lookup read past an entry another repository saved under this name",
				"repository", repository, "repositoryId", claims.RepositoryID,
				"savedBy", entry.RepositoryID, "ref", ref, "key", entry.Key)
		}
		// The newest candidate is the answer almost every time. A lookup reads
		// past it only for one that raced an eviction, one that does not parse,
		// or one another repository saved before the name changed hands, and
		// the first save under the new ID removes those.
		passed++
		if passed >= maxPassedCandidates {
			break
		}
	}
	return nil, nil
}

// candidate reads one listed entry document. One that has gone or cannot be
// trusted is nil with no error.
func (i *Index) candidate(ctx context.Context, object, repository, ref, version string) (*Entry, error) {
	body, err := i.store.GetBytes(ctx, object, maxEntryMetadataBytes)
	if err != nil {
		if errors.Is(err, objectstore.ErrNotFound) {
			// Raced with an eviction.
			return nil, nil
		}
		return nil, err
	}
	var entry Entry
	if err := json.Unmarshal(body, &entry); err != nil {
		i.logger.Warn("cache entry metadata does not parse", "object", object, "error", err)
		return nil, nil
	}
	// Defence in depth: the listing already narrowed by repository, ref and
	// version, so a document that disagrees means the layout and the reader
	// have drifted apart. Refuse it rather than serve another scope's bytes.
	if !strings.EqualFold(entry.Repository, repository) || entry.Ref != ref || entry.Version != version {
		i.logger.Error("cache entry metadata contradicts its own location",
			"object", object, "repository", entry.Repository, "ref", entry.Ref)
		return nil, nil
	}
	entry.Object = object
	return &entry, nil
}

// servable answers an entry as a hit only if its bytes are there.
//
// Eviction deletes the metadata before the blob and keeps the blob readable for
// a grace period, so this service never produces a dangling entry; but the
// bucket's lifecycle rule, an operator with the store's own tools, or a store
// that lost an object can. Answering such an entry would hand the job a URL that
// 404s, which some clients survive as a warning and BuildKit does not. One HEAD
// per hit turns every one of those into a miss.
func (i *Index) servable(ctx context.Context, entry *Entry, repository string) (*Entry, error) {
	if _, err := i.store.Stat(ctx, entry.Blob); err != nil {
		if errors.Is(err, objectstore.ErrNotFound) {
			i.logger.Warn("cache entry names a blob that is gone; answering a miss",
				"object", entry.Object, "blob", entry.Blob)
			// The next quota tick sweeps this repository, which removes the
			// entry so the key can be saved again.
			i.markDirty(repository)
			return nil, nil
		}
		return nil, err
	}
	return entry, nil
}

// Exists reports whether the given key and version already have an entry in
// the token's write scope. GitHub's cache entries are immutable, and so are
// these: a second save of the same key is refused rather than allowed to
// replace bytes an earlier job already restored.
//
// Every save starts here, so this is also where a repository name changes
// hands: before it answers, the entries another repository saved under the name
// are removed (see claimName). Otherwise a key the earlier repository saved
// would refuse the new repository's save of it for as long as the old entry
// lived. A save the name refuses, from a job of a repository that gave the
// name up to a newer one, is answered as a key that exists: every caller
// already turns that into a skipped save the client does not retry.
//
// It is a check, not a lock. Two jobs reserving the same key at the same
// instant both pass it and both publish, and the newer one wins every later
// restore. That is a wasted upload rather than a security property: what stops
// an untrusted job from writing at all is the permission in its token, which is
// decided before this is ever called.
func (i *Index) Exists(ctx context.Context, claims cachetoken.Claims, key, version string) (bool, error) {
	if err := i.claimName(ctx, claims.Repository, claims.RepositoryID); err != nil {
		if errors.Is(err, ErrNameHeldByNewerRepository) {
			return true, nil
		}
		return false, err
	}
	prefix := scopePrefix(claims.Repository, claims.WriteScope(), versionSegment(version)) +
		hex.EncodeToString([]byte(key)) + "."
	objects, _, err := i.store.List(ctx, prefix, 1)
	if err != nil {
		return false, err
	}
	return len(objects) > 0, nil
}

// NewBlob starts an upload of an entry's bytes and returns the object key it
// will land at. The blob is written before the metadata that names it, so a
// crash mid-save leaves an unreferenced object for the sweeper to remove (see
// Retention.OrphanGrace) rather than an entry pointing at bytes that are not
// there.
func (i *Index) NewBlob(ctx context.Context, repository string) (string, objectstore.Upload, error) {
	name := make([]byte, 16)
	if _, err := rand.Read(name); err != nil {
		return "", nil, err
	}
	key := "blobs/" + repositorySegment(repository) + "/" + hex.EncodeToString(name)
	upload, err := i.store.NewUpload(ctx, key)
	if err != nil {
		return "", nil, err
	}
	return key, upload, nil
}

// Commit publishes an entry. Everything it needs is already in the bucket; this
// is the write that makes it findable. The entry carries the saving
// repository's ID when the job's facts had one, and from then on only a token
// for that ID, or one with no ID at all, restores it.
func (i *Index) Commit(ctx context.Context, entry Entry) error {
	if err := cachetoken.ValidateRepository(entry.Repository); err != nil {
		return err
	}
	if entry.Ref == "" {
		return errors.New("a cache entry needs a ref to be scoped by")
	}
	if entry.RepositoryID < 0 {
		return errors.New("a repository ID is positive, or zero when unknown")
	}
	// A save that did not start at Exists takes the name here. For one that
	// did, the name is already this ID's and this is a memo read, unless a
	// newer repository took the name since. That save is dropped rather than
	// failed: it is refused for good, the job can do nothing about it, and a
	// failure would only make the client retry. claimName has logged and
	// counted it.
	if err := i.claimName(ctx, entry.Repository, entry.RepositoryID); err != nil {
		if errors.Is(err, ErrNameHeldByNewerRepository) {
			return nil
		}
		return err
	}
	entry.CreatedAt = i.now().UnixMilli()
	body, err := json.Marshal(entry)
	if err != nil {
		return err
	}
	object := scopePrefix(entry.Repository, entry.Ref, versionSegment(entry.Version)) +
		hex.EncodeToString([]byte(entry.Key)) + "." + recencySuffix(entry.CreatedAt)
	if err := i.store.PutBytes(ctx, object, "application/json", body); err != nil {
		return err
	}
	// The repository just grew. The next quota pass looks at it rather than
	// waiting for the full sweep.
	i.markDirty(entry.Repository)
	return nil
}

// PresignBlob mints the URL a job downloads an entry through. It is a GET for
// exactly one object and it expires (ADR 0007 rule 4).
func (i *Index) PresignBlob(ctx context.Context, blob string, ttl time.Duration) (string, error) {
	return i.store.PresignGet(ctx, blob, ttl)
}

// OpenBlob streams an entry's bytes through this service, for deployments
// whose store is not reachable from the jobs themselves.
func (i *Index) OpenBlob(ctx context.Context, blob string) (io.ReadCloser, int64, error) {
	return i.store.Open(ctx, blob)
}

// scopePrefix is where one repository's entries for one ref and one version
// live. Everything below is derived from token claims; nothing in it comes
// from a request body, which is what makes rule 1 hold.
func scopePrefix(repository, ref, versionSegment string) string {
	return "entries/" + repositorySegment(repository) + "/" + refSegment(ref) + "/" + versionSegment + "/"
}

// repositorySegment keeps "owner/name" readable in the bucket so an operator
// can write a lifecycle rule per repository. It is safe to interpolate because
// cachetoken.ValidateRepository has already refused anything outside
// [A-Za-z0-9._-], and it is lowercased so two spellings of the same repository
// cannot end up with two caches.
func repositorySegment(repository string) string {
	return strings.ToLower(repository)
}

// refSegment escapes a ref into one path segment. Anything outside the
// unreserved set becomes ~XX, which is reversible, injective, and leaves
// refs/heads/main legible as refs~2Fheads~2Fmain.
func refSegment(ref string) string {
	var out strings.Builder
	for i := 0; i < len(ref); i++ {
		c := ref[i]
		if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
			c == '.' || c == '_' || c == '-' {
			out.WriteByte(c)
			continue
		}
		out.WriteString("~")
		out.WriteString(strings.ToUpper(hex.EncodeToString([]byte{c})))
	}
	return out.String()
}

// versionSegment hashes the client's version. The captured versions are all
// sha256 hex already (capture L001, L020), but the field is the client's to
// fill and this is an exact-match dimension, so hashing keeps it one safe
// fixed-width segment whatever arrives.
func versionSegment(version string) string {
	sum := sha256.Sum256([]byte(version))
	return hex.EncodeToString(sum[:])
}

// recencySuffix encodes creation time so that lexicographic order is
// newest-first. Listing gives back names, not timestamps, and an object store's
// own modification time is only second-granular; putting the millisecond in the
// name means "the newest match" is decided without a read per candidate and
// without depending on the store's clock.
func recencySuffix(createdAtMillis int64) string {
	return fmt.Sprintf("%016x", uint64(math.MaxInt64-createdAtMillis))
}

func recencyStamp(object string) string {
	dot := strings.LastIndex(object, ".")
	if dot < 0 {
		return ""
	}
	return object[dot+1:]
}
