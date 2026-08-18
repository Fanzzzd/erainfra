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
	"strings"
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
	Ref        string `json:"ref"`
	Blob       string `json:"blob"`
	Size       int64  `json:"size"`
	// CreatedAt is unix milliseconds. It is also encoded into the metadata
	// object's own name, inverted, so a listing sorts newest-first without a
	// read per candidate.
	CreatedAt int64 `json:"createdAt"`
}

// Index answers key questions against a bucket.
type Index struct {
	store  objectstore.Store
	logger *slog.Logger
	// Now is the clock. Tests replace it so "newest wins" is decidable rather
	// than a race with the wall clock.
	Now           func() time.Time
	MaxCandidates int
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
			entry, err := i.newest(ctx, claims.Repository, ref, versionSegment, encoded+".", version)
			if err != nil {
				return nil, err
			}
			if entry != nil {
				return entry, nil
			}
		}
		// Then prefix. Hex is a byte-for-byte encoding, so a hex prefix of even
		// length is exactly a prefix of the decoded key — which is what makes
		// the store's own prefix listing the whole of the prefix match.
		for _, ref := range scopes {
			entry, err := i.newest(ctx, claims.Repository, ref, versionSegment, encoded, version)
			if err != nil {
				return nil, err
			}
			if entry != nil {
				return entry, nil
			}
		}
	}
	return nil, nil
}

// newest lists one scope and returns the most recently created match.
func (i *Index) newest(ctx context.Context, repository, ref, versionSegment, encodedKey, version string) (*Entry, error) {
	prefix := scopePrefix(repository, ref, versionSegment) + encodedKey
	objects, truncated, err := i.store.List(ctx, prefix, i.maxCandidates())
	if err != nil {
		return nil, err
	}
	if truncated {
		i.logger.Warn("cache key prefix has more entries than one listing page",
			"repository", repository, "ref", ref, "candidates", len(objects))
	}
	if len(objects) == 0 {
		return nil, nil
	}

	best := ""
	bestStamp := ""
	for _, object := range objects {
		stamp := recencyStamp(object.Key)
		if stamp == "" {
			continue
		}
		// The stamp is the creation time subtracted from the largest int64 and
		// printed at a fixed width, so the smallest stamp is the newest entry
		// and a plain string comparison decides it.
		if best == "" || stamp < bestStamp {
			best, bestStamp = object.Key, stamp
		}
	}
	if best == "" {
		return nil, nil
	}

	body, err := i.store.GetBytes(ctx, best, maxEntryMetadataBytes)
	if err != nil {
		if errors.Is(err, objectstore.ErrNotFound) {
			// Raced with an eviction. A miss is the right answer.
			return nil, nil
		}
		return nil, err
	}
	var entry Entry
	if err := json.Unmarshal(body, &entry); err != nil {
		i.logger.Warn("cache entry metadata does not parse", "object", best, "error", err)
		return nil, nil
	}
	// Defence in depth: the listing already narrowed by repository, ref and
	// version, so a document that disagrees means the layout and the reader
	// have drifted apart. Refuse it rather than serve another scope's bytes.
	if !strings.EqualFold(entry.Repository, repository) || entry.Ref != ref || entry.Version != version {
		i.logger.Error("cache entry metadata contradicts its own location",
			"object", best, "repository", entry.Repository, "ref", entry.Ref)
		return nil, nil
	}
	return &entry, nil
}

// Exists reports whether the given key and version already have an entry in
// this ref's scope. GitHub's cache entries are immutable, and so are these: a
// second save of the same key is refused rather than allowed to replace bytes
// an earlier job already restored.
//
// It is a check, not a lock. Two jobs reserving the same key at the same
// instant both pass it and both publish, and the newer one wins every later
// restore. That is a wasted upload rather than a security property: what stops
// an untrusted job from writing at all is the permission in its token, which is
// decided before this is ever called.
func (i *Index) Exists(ctx context.Context, repository, ref, key, version string) (bool, error) {
	prefix := scopePrefix(repository, ref, versionSegment(version)) + hex.EncodeToString([]byte(key)) + "."
	objects, _, err := i.store.List(ctx, prefix, 1)
	if err != nil {
		return false, err
	}
	return len(objects) > 0, nil
}

// NewBlob starts an upload of an entry's bytes and returns the object key it
// will land at. The blob is written before the metadata that names it, so a
// crash mid-save leaves an unreferenced object for the bucket's lifecycle rule
// to remove rather than an entry pointing at bytes that are not there.
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
// is the write that makes it findable.
func (i *Index) Commit(ctx context.Context, entry Entry) error {
	if err := cachetoken.ValidateRepository(entry.Repository); err != nil {
		return err
	}
	if entry.Ref == "" {
		return errors.New("a cache entry needs a ref to be scoped by")
	}
	entry.CreatedAt = i.now().UnixMilli()
	body, err := json.Marshal(entry)
	if err != nil {
		return err
	}
	object := scopePrefix(entry.Repository, entry.Ref, versionSegment(entry.Version)) +
		hex.EncodeToString([]byte(entry.Key)) + "." + recencySuffix(entry.CreatedAt)
	return i.store.PutBytes(ctx, object, "application/json", body)
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
