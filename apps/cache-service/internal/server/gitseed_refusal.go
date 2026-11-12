package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/Fanzzzd/erainfra/apps/cache-service/internal/objectstore"
	"github.com/Fanzzzd/erainfra/internal/cachetoken"
)

// A seed this service refused to store is remembered, so that it is not built
// again by every job. Building one is the expensive part: the guest fetches
// the repository's whole history from GitHub in the background, which for a
// repository too large to store runs for many minutes, and only then finds out
// at the PUT. The guest cannot remember the refusal (nothing outlives it), so
// the service does, and answers the next jobs' seed lookups as not writable
// until the backoff has passed.
//
// Only a refusal that will happen again is remembered: a seed over the entry
// size limit. A store that failed is a transient outage, and the next job
// should try.
//
// The refusal is decided from the PUT's Content-Length, before any byte of the
// body is read, so the job that sent it chooses it. Who may choose for whom
// follows the cache's own write scopes:
//
//   - A refusal from the default branch holds for the whole repository. Every
//     scope's seed is a bundle of the same branches and tags, and a job on the
//     default branch runs the repository's own reviewed workflow.
//   - A refusal from any other ref holds for that ref alone. A job on a pull
//     request or a feature branch runs code nobody has reviewed yet, and a
//     length it made up must not stop the default branch's seed, which is the
//     one every other scope reads, from being built for up to a week.
//
// A record also carries the repository ID from the job's facts, so a
// repository created under a name another one had does not inherit that one's
// refusal.
const (
	// gitSeedRefusalRoot is where refusals are kept in the bucket, one small
	// object per repository and, for refs other than the default branch, per
	// ref, beside facts/. No eviction walk lists it.
	gitSeedRefusalRoot = "gitseed-refusals/"
	// gitSeedRefusalBackoff is how long the first refusal holds, the guest's
	// own refresh interval: one rebuild a day at most. It doubles with every
	// refusal in a row, up to gitSeedRefusalMaxBackoff, so a repository that
	// will never fit costs a rebuild a week, and one that shrank (a history
	// rewrite) is tried again within that. Raising the entry size limit above
	// the refused size lifts the backoff at once.
	gitSeedRefusalBackoff    = 24 * time.Hour
	gitSeedRefusalMaxBackoff = 7 * 24 * time.Hour
	maxGitSeedRefusalBytes   = 4 << 10

	headerGitSeedRefusedUntil = "X-Erainfra-Git-Seed-Refused-Until"
)

// gitSeedRefusal is one repository's refusal record.
type gitSeedRefusal struct {
	Repository string `json:"repository"`
	// RepositoryID is GitHub's ID for the repository whose seed was refused.
	// A record without one stops no seed being built.
	RepositoryID int64 `json:"repositoryId,omitempty"`
	// Ref is the scope whose seed was refused. A record without one was
	// written before refusals were scoped, by a job on any ref.
	Ref string `json:"ref,omitempty"`
	// Bytes is the size of the seed refused, and Limit the entry size limit
	// it was refused under.
	Bytes     int64 `json:"bytes"`
	Limit     int64 `json:"limit"`
	Refusals  int   `json:"refusals"`
	RefusedAt int64 `json:"refusedAt"`
}

// until is when a new seed is worth building again.
func (r gitSeedRefusal) until() time.Time {
	backoff := gitSeedRefusalBackoff
	for range max(r.Refusals-1, 0) {
		backoff *= 2
		if backoff >= gitSeedRefusalMaxBackoff {
			backoff = gitSeedRefusalMaxBackoff
			break
		}
	}
	return time.Unix(r.RefusedAt, 0).Add(backoff)
}

// onDefaultBranch reports whether a job's seed is the default branch's.
func onDefaultBranch(claims cachetoken.Claims) bool {
	return claims.DefaultBranch != "" && claims.WriteScope() == claims.DefaultBranch
}

// gitSeedRefusalKey is the repository-wide record: the default branch's. The
// key is a digest of the repository, which needs no escaping and keeps
// repositories that differ only in case together, as GitHub does. It is the
// key every refusal had before refusals were scoped, so the records a deployed
// store holds are read where they were written.
func gitSeedRefusalKey(repository string) string {
	digest := sha256.Sum256([]byte(strings.ToLower(repository)))
	return gitSeedRefusalRoot + hex.EncodeToString(digest[:])
}

// gitSeedRefKey is one other ref's record. It stays one flat object name
// beside the repository's own rather than a path below it: MinIO cannot hold
// an object and another one "inside" it.
func gitSeedRefKey(repository, ref string) string {
	digest := sha256.Sum256([]byte(ref))
	return gitSeedRefusalKey(repository) + "~" + hex.EncodeToString(digest[:])
}

// gitSeedRefusalKeyFor is where a job's own refusal is written.
func gitSeedRefusalKeyFor(claims cachetoken.Claims) string {
	if onDefaultBranch(claims) {
		return gitSeedRefusalKey(claims.Repository)
	}
	return gitSeedRefKey(claims.Repository, claims.WriteScope())
}

// loadGitSeedRefusal reads one record. One written for another repository of
// the same name, by ID, is not this repository's.
func (s *Server) loadGitSeedRefusal(ctx context.Context, key string, claims cachetoken.Claims) (gitSeedRefusal, bool) {
	raw, err := s.store.GetBytes(ctx, key, maxGitSeedRefusalBytes)
	if err != nil {
		if !errors.Is(err, objectstore.ErrNotFound) {
			s.logger.Warn("git seed refusal could not be read; the seed may be rebuilt",
				"repository", claims.Repository, "error", err)
		}
		return gitSeedRefusal{}, false
	}
	var refusal gitSeedRefusal
	if err := json.Unmarshal(raw, &refusal); err != nil || !strings.EqualFold(refusal.Repository, claims.Repository) {
		return gitSeedRefusal{}, false
	}
	if !sameRepositoryID(refusal.RepositoryID, claims.RepositoryID) {
		return gitSeedRefusal{}, false
	}
	return refusal, true
}

// active reports until when a record stops a seed being built, or the zero
// time when it does not.
func (s *Server) active(refusal gitSeedRefusal) time.Time {
	if refusal.Bytes <= s.config.MaxEntryBytes {
		return time.Time{}
	}
	until := refusal.until()
	if !s.now().Before(until) {
		return time.Time{}
	}
	return until
}

// gitSeedBackoff reports until when this job's seed should not be built, or
// the zero time when it should: the later of the repository-wide record and
// the job's own ref's.
func (s *Server) gitSeedBackoff(ctx context.Context, claims cachetoken.Claims) time.Time {
	var until time.Time
	if refusal, ok := s.loadGitSeedRefusal(ctx, gitSeedRefusalKey(claims.Repository), claims); ok {
		// A record with no ref was written before refusals were scoped, by
		// whichever job got there, so it may have been a length a pull request
		// made up. It still holds the other refs back; the default branch
		// builds once more and writes a record of its own, refusal or seed.
		if refusal.Ref != "" || !onDefaultBranch(claims) {
			until = s.active(refusal)
		}
	}
	if !onDefaultBranch(claims) {
		key := gitSeedRefKey(claims.Repository, claims.WriteScope())
		if refusal, ok := s.loadGitSeedRefusal(ctx, key, claims); ok {
			own := s.active(refusal)
			if own.IsZero() && !s.now().Before(refusal.until()) {
				// Expired: one ref's record would otherwise stay in the
				// bucket after the branch is gone.
				_ = s.store.Delete(ctx, key)
			}
			if own.After(until) {
				until = own
			}
		}
	}
	return until
}

func (s *Server) recordGitSeedRefusal(ctx context.Context, claims cachetoken.Claims, size int64) {
	key := gitSeedRefusalKeyFor(claims)
	refusal, _ := s.loadGitSeedRefusal(ctx, key, claims)
	refusal = gitSeedRefusal{
		Repository:   claims.Repository,
		RepositoryID: claims.RepositoryID,
		Ref:          claims.WriteScope(),
		Bytes:        size,
		Limit:        s.config.MaxEntryBytes,
		Refusals:     refusal.Refusals + 1,
		RefusedAt:    s.now().Unix(),
	}
	body, err := json.Marshal(refusal)
	if err == nil {
		err = s.store.PutBytes(ctx, key, "application/json", body)
	}
	if err != nil {
		s.logger.Warn("git seed refusal could not be recorded; the next job may rebuild it",
			"repository", claims.Repository, "error", err)
		return
	}
	scope := "this ref"
	if onDefaultBranch(claims) {
		scope = "the repository"
	}
	s.logger.Warn("git seed refused: it is over the entry size limit; jobs stop building it until the backoff passes",
		"repository", claims.Repository, "ref", claims.WriteScope(), "holdsFor", scope,
		"bytes", size, "limit", s.config.MaxEntryBytes,
		"refusals", refusal.Refusals, "until", refusal.until().UTC().Format(time.RFC3339))
}

// clearGitSeedRefusal removes the job's own record once its seed was saved.
// A seed saved on another ref does not clear the default branch's refusal: it
// is that ref's job that chose its own bytes.
func (s *Server) clearGitSeedRefusal(ctx context.Context, claims cachetoken.Claims) {
	if err := s.store.Delete(ctx, gitSeedRefusalKeyFor(claims)); err != nil {
		s.logger.Warn("git seed refusal could not be cleared", "repository", claims.Repository, "error", err)
	}
}
