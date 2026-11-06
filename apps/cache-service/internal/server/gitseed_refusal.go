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
const (
	// gitSeedRefusalRoot is where refusals are kept in the bucket, one small
	// object per repository, beside facts/. No eviction walk lists it.
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

// The key is a digest of the repository, which needs no escaping and keeps
// repositories that differ only in case together, as GitHub does.
func gitSeedRefusalKey(repository string) string {
	digest := sha256.Sum256([]byte(strings.ToLower(repository)))
	return gitSeedRefusalRoot + hex.EncodeToString(digest[:])
}

func (s *Server) loadGitSeedRefusal(ctx context.Context, repository string) (gitSeedRefusal, bool) {
	raw, err := s.store.GetBytes(ctx, gitSeedRefusalKey(repository), maxGitSeedRefusalBytes)
	if err != nil {
		if !errors.Is(err, objectstore.ErrNotFound) {
			s.logger.Warn("git seed refusal could not be read; the seed may be rebuilt", "repository", repository, "error", err)
		}
		return gitSeedRefusal{}, false
	}
	var refusal gitSeedRefusal
	if err := json.Unmarshal(raw, &refusal); err != nil || !strings.EqualFold(refusal.Repository, repository) {
		return gitSeedRefusal{}, false
	}
	return refusal, true
}

// gitSeedBackoff reports until when this repository's seed should not be
// built, or the zero time when it should.
func (s *Server) gitSeedBackoff(ctx context.Context, repository string) time.Time {
	refusal, ok := s.loadGitSeedRefusal(ctx, repository)
	if !ok || refusal.Bytes <= s.config.MaxEntryBytes {
		return time.Time{}
	}
	until := refusal.until()
	if !s.now().Before(until) {
		return time.Time{}
	}
	return until
}

func (s *Server) recordGitSeedRefusal(ctx context.Context, repository string, size int64) {
	refusal, _ := s.loadGitSeedRefusal(ctx, repository)
	refusal = gitSeedRefusal{
		Repository: repository,
		Bytes:      size,
		Limit:      s.config.MaxEntryBytes,
		Refusals:   refusal.Refusals + 1,
		RefusedAt:  s.now().Unix(),
	}
	body, err := json.Marshal(refusal)
	if err == nil {
		err = s.store.PutBytes(ctx, gitSeedRefusalKey(repository), "application/json", body)
	}
	if err != nil {
		s.logger.Warn("git seed refusal could not be recorded; the next job may rebuild it", "repository", repository, "error", err)
		return
	}
	s.logger.Warn("git seed refused: it is over the entry size limit; jobs stop building it until the backoff passes",
		"repository", repository, "bytes", size, "limit", s.config.MaxEntryBytes,
		"refusals", refusal.Refusals, "until", refusal.until().UTC().Format(time.RFC3339))
}

func (s *Server) clearGitSeedRefusal(ctx context.Context, repository string) {
	if err := s.store.Delete(ctx, gitSeedRefusalKey(repository)); err != nil {
		s.logger.Warn("git seed refusal could not be cleared", "repository", repository, "error", err)
	}
}
