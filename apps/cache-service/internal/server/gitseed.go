package server

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/Fanzzzd/erainfra/apps/cache-service/internal/cacheindex"
	"github.com/Fanzzzd/erainfra/apps/cache-service/internal/objectstore"
	"github.com/Fanzzzd/erainfra/internal/cachetoken"
)

// The git seed is one git bundle per repository and ref scope: the branches and
// tags of the job's own repository as a guest last fetched them from GitHub. A
// Firecracker guest restores it into a local mirror so that a job's checkout
// fetches only the objects GitHub has gained since (docs/runbooks/
// operate-the-job-cache.md, "Git checkout mirror").
//
// A seed is stored as an ordinary cache entry under a reserved key and version.
// That is a decision, not a shortcut: an entry already has every property the
// seed needs and nothing new has to be secured. Its repository and ref come
// from the runner's job facts and never from the request (ADR 0007 rule 1), so
// a job reads only its own repository's seed; a fork pull request's read-only
// token cannot write one (rule 2); a pull request reads its base branch's and
// the default branch's seeds but not a sibling branch's (rule 3); and the seed
// counts against the repository's quota, ages out with idle eviction, and is
// listed and deleted by the same admin API and `erainfra cache` commands as
// every other entry.
const (
	gitSeedMarker = "/_erainfra-git-seed/v1"
	// gitSeedKeyPrefix and gitSeedVersion keep a seed apart from the entries
	// actions/cache and BuildKit write. Those clients derive version from a
	// hash of the cached paths, so no real client produces this version
	// string; a job that forges one only feeds its own repository's guests a
	// bundle they verify object by object anyway (see the guest's gitmirror
	// package).
	gitSeedKeyPrefix = "erainfra-git-seed/"
	gitSeedVersion   = "erainfra-git-seed-v1"

	// Response headers. The repository is how a guest learns which repository
	// its job is for: the guest boots before GitHub assigns it a job, and the
	// job facts the controller pushed are the authority on it.
	headerGitSeedRepository = "X-Erainfra-Repository"
	headerGitSeedWritable   = "X-Erainfra-Git-Seed-Writable"
	headerGitSeedCreated    = "X-Erainfra-Git-Seed-Created"
)

// gitSeedVersionFor is the version a job's seed is saved and looked up under.
// It carries GitHub's ID for the repository. The name alone is not the
// repository: one deleted, or renamed away, and then created again under the
// same name is a different repository, with a different history, and must not
// restore the old one's seed. GitHub deletes a repository's own Actions cache
// with it; this is the seed's equivalent.
func gitSeedVersionFor(claims cachetoken.Claims) string {
	return gitSeedVersion + gitSeedRepositoryIDTag + strconv.FormatInt(claims.RepositoryID, 10)
}

const gitSeedRepositoryIDTag = "+repository-"

// isGitSeedVersion matches every seed version, including the bare one seeds
// had before they were keyed by repository ID, so a new seed replaces any of
// them in its scope.
func isGitSeedVersion(version string) bool {
	return version == gitSeedVersion || strings.HasPrefix(version, gitSeedVersion+gitSeedRepositoryIDTag)
}

// removeGitSeeds removes the seeds in the claimant's write scope, of any
// version, before its new one is committed. The claimant has already claimed
// the name (Index.ClaimName), which removed every seed another repository ID
// saved, except one a newer repository saved after this process last read the
// name. That one is left: a repository that gave the name up never removes
// the entries of the one holding it now.
func (s *Server) removeGitSeeds(ctx context.Context, claims cachetoken.Claims, scope string) error {
	repository := claims.Repository
	records, err := s.index.Entries(ctx, repository, cacheindex.Match{Prefix: gitSeedKeyPrefix, Ref: scope})
	if err != nil {
		return err
	}
	for _, record := range records {
		if !isGitSeedVersion(record.Version) {
			continue
		}
		if record.RepositoryID > claims.RepositoryID {
			s.metrics.stalePurgesRefused.Add(1)
			s.logger.Warn("left a newer repository's git seed in place; the saving job's repository gave this name up",
				"repository", repository, "ref", scope, "repositoryId", claims.RepositoryID,
				"seedRepositoryId", record.RepositoryID, "key", record.Key)
			continue
		}
		if _, err := s.index.Remove(ctx, repository, cacheindex.Match{
			Key: record.Key, Version: record.Version, Ref: scope,
		}); err != nil {
			return err
		}
	}
	return nil
}

// serveGitSeed answers the guest's git seed requests.
//
//   - HEAD or GET: 200 with the newest seed this runner may read, or 404 when
//     there is none. Both carry the repository and whether this runner may
//     save a seed, so a guest can decide whether building one is worth it.
//   - PUT: store a new seed for this runner's own ref, replacing the older
//     seeds in that scope. 403 for a read-only token.
func (s *Server) serveGitSeed(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet, http.MethodHead:
		s.gitSeedRead(w, r)
	case http.MethodPut:
		s.gitSeedWrite(w, r)
	default:
		w.Header().Set("Allow", "GET, HEAD, PUT")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"message": "git seeds are GET, HEAD or PUT"})
	}
}

func (s *Server) gitSeedRead(w http.ResponseWriter, r *http.Request) {
	claims, ok := s.require(w, r, false)
	if !ok {
		return
	}
	w.Header().Set(headerGitSeedRepository, claims.Repository)

	lookup, cancel := s.deadline(w, r, s.config.LookupTimeout)
	// Writable tells the guest whether to build a seed, so a repository whose
	// last seed was refused reads as not writable until the backoff passes.
	writable := claims.CanWrite()
	if writable {
		if until := s.gitSeedBackoff(lookup, claims); !until.IsZero() {
			writable = false
			w.Header().Set(headerGitSeedRefusedUntil, strconv.FormatInt(until.Unix(), 10))
		}
	}
	if writable {
		// A job of a repository that gave the name up would build a seed the
		// PUT refuses. An unreadable name record leaves the answer to the PUT.
		if superseded, err := s.index.Superseded(lookup, claims.Repository, claims.RepositoryID); err == nil && superseded {
			writable = false
		}
	}
	w.Header().Set(headerGitSeedWritable, strconv.FormatBool(writable))
	entry, err := s.index.Lookup(lookup, claims, []string{gitSeedKeyPrefix}, gitSeedVersionFor(claims))
	cancel()
	if err != nil {
		s.logger.Error("git seed lookup failed", "repository", claims.Repository, "error", err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"message": "cache store unavailable"})
		return
	}
	if entry == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"message": "no git seed for this repository"})
		return
	}

	ctx, cancelTransfer := s.deadline(w, r, s.config.TransferTimeout)
	defer cancelTransfer()
	body, size, err := s.index.OpenBlob(ctx, entry.Blob)
	if err != nil {
		if errors.Is(err, objectstore.ErrNotFound) {
			writeJSON(w, http.StatusNotFound, map[string]string{"message": "no git seed for this repository"})
			return
		}
		s.logger.Error("git seed could not be opened", "repository", claims.Repository, "error", err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"message": "cache store unavailable"})
		return
	}
	defer body.Close() //nolint:errcheck // read-only body; a close error loses nothing

	w.Header().Set(headerGitSeedCreated, strconv.FormatInt(entry.CreatedAt/1000, 10))
	w.Header().Set("Content-Type", "application/x-git-bundle")
	if size >= 0 {
		w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	}
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodHead {
		return
	}
	if _, err := io.Copy(w, body); err != nil {
		s.logger.Warn("git seed download stopped early", "repository", claims.Repository, "error", err)
	}
}

func (s *Server) gitSeedWrite(w http.ResponseWriter, r *http.Request) {
	claims, ok := s.require(w, r, true)
	if !ok {
		return
	}
	size := r.ContentLength
	switch {
	case size <= 0:
		// The store's part accounting needs the length up front, and the guest
		// always knows it: it uploads a finished file.
		writeJSON(w, http.StatusLengthRequired, map[string]string{"message": "a git seed needs a Content-Length"})
		return
	case size > s.config.MaxEntryBytes:
		record, cancel := s.deadline(w, r, s.config.LookupTimeout)
		s.recordGitSeedRefusal(record, claims, size)
		cancel()
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"message": ErrEntryTooLarge.Error()})
		return
	}
	// The budget covers reading the body: a guest that stalls mid-upload
	// must not hold a goroutine and a store upload open indefinitely.
	ctx, cancel := s.deadline(w, r, s.config.TransferTimeout)
	defer cancel()

	// The name is claimed before any byte is read and before the older seeds
	// in the scope are removed: a job of a repository that gave the name up
	// must not remove the seed of the one that holds it now.
	if err := s.index.ClaimName(ctx, claims.Repository, claims.RepositoryID); err != nil {
		if errors.Is(err, cacheindex.ErrNameHeldByNewerRepository) {
			writeJSON(w, http.StatusConflict, map[string]string{"message": err.Error()})
			return
		}
		if errors.Is(err, cacheindex.ErrNoRepositoryID) {
			writeJSON(w, http.StatusForbidden, map[string]string{"message": err.Error()})
			return
		}
		s.logger.Error("git seed save could not read the repository name", "repository", claims.Repository, "error", err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"message": "cache store unavailable"})
		return
	}

	blob, upload, err := s.index.NewBlob(ctx, claims.Repository)
	if err != nil {
		s.logger.Error("git seed upload could not start", "repository", claims.Repository, "error", err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"message": "cache store unavailable"})
		return
	}
	if err := s.streamBody(ctx, upload, http.MaxBytesReader(w, r.Body, size), size); err != nil {
		_ = upload.Abort(ctx)
		s.logger.Error("git seed upload failed", "repository", claims.Repository, "error", err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"message": "git seed upload failed"})
		return
	}
	if err := upload.Complete(ctx); err != nil {
		_ = upload.Abort(ctx)
		s.logger.Error("git seed upload could not complete", "repository", claims.Repository, "error", err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"message": "git seed upload failed"})
		return
	}

	// One seed per scope is all a guest ever reads: Lookup returns the newest.
	// Older ones would only hold quota until idle eviction reached them, at
	// the size of a whole repository each, so they go before the new one is
	// published. A guest that looks the seed up in between gets a miss and
	// checks out from GitHub alone, which is the fail-open path anyway; a guest
	// already downloading an old one keeps its bytes for the blob grace period.
	//
	// Every seed in the scope goes, whatever its version: one saved for an
	// earlier repository of the same name, or before seeds were keyed by
	// repository ID, is never read again.
	scope := claims.WriteScope()
	if err := s.removeGitSeeds(ctx, claims, scope); err != nil {
		s.logger.Warn("older git seeds could not be removed; idle eviction will",
			"repository", claims.Repository, "ref", scope, "error", err)
	}
	key := gitSeedKeyPrefix + strconv.FormatInt(s.now().UnixMilli(), 10)
	if err := s.index.Commit(ctx, cacheindex.Entry{
		Key: key, Version: gitSeedVersionFor(claims), Repository: claims.Repository, RepositoryID: claims.RepositoryID,
		Ref: scope, Blob: blob, Size: size,
	}); err != nil {
		s.logger.Error("git seed could not be published", "repository", claims.Repository, "error", err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"message": "git seed could not be published"})
		return
	}
	s.clearGitSeedRefusal(ctx, claims)
	s.logger.Info("git seed saved", "repository", claims.Repository, "ref", scope, "bytes", size)
	w.Header().Set(headerGitSeedRepository, claims.Repository)
	w.WriteHeader(http.StatusCreated)
}
