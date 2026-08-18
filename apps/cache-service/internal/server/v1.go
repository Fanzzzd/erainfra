package server

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strconv"
	"strings"

	"github.com/Fanzzzd/erainfra/apps/cache-service/internal/cacheindex"
)

// Legacy v1, the REST API under ACTIONS_CACHE_URL.
//
// ADR 0007 calls this "the path that has to work with no assumptions at all",
// because it is what every client the capture drove falls back to when
// ACTIONS_CACHE_SERVICE_V2 is absent — and that flag is GitHub's to set, not
// EraInfra's.

// v1RestoreResponse is the hit shape, field for field from capture L005 and
// L029.
type v1RestoreResponse struct {
	CacheKey        string `json:"cacheKey"`
	Scope           string `json:"scope"`
	ArchiveLocation string `json:"archiveLocation"`
}

type v1ReserveRequest struct {
	Key     string    `json:"key"`
	Version string    `json:"version"`
	Size    flexInt64 `json:"cacheSize"`
}

type v1CommitRequest struct {
	Size flexInt64 `json:"size"`
}

func (s *Server) serveV1(w http.ResponseWriter, r *http.Request, route string) {
	switch {
	case route == "cache" && r.Method == http.MethodGet:
		s.v1Restore(w, r)
	case route == "caches" && r.Method == http.MethodPost:
		s.v1Reserve(w, r)
	case strings.HasPrefix(route, "caches/") && r.Method == http.MethodPatch:
		s.v1Upload(w, r, strings.TrimPrefix(route, "caches/"))
	case strings.HasPrefix(route, "caches/") && r.Method == http.MethodPost:
		s.v1Commit(w, r, strings.TrimPrefix(route, "caches/"))
	default:
		http.NotFound(w, r)
	}
}

// v1Restore answers GET _apis/artifactcache/cache.
//
// A miss is 204 with no body (capture L001). It is never a 404: answering 404
// costs "::warning::Failed to restore: Cache service responded with 404" and a
// lost cache (capture L121), and the same is true of every other error shape,
// so a store that is down or slow gets the same 204 a cold key does, with the
// truth in the log rather than in the job.
func (s *Server) v1Restore(w http.ResponseWriter, r *http.Request) {
	claims, ok := s.require(w, r, false)
	if !ok {
		return
	}
	// The budget is taken before anything is validated, so the early misses
	// below are written under a deadline too.
	ctx, cancel := s.deadline(w, r, s.config.LookupTimeout)
	defer cancel()

	query := r.URL.Query()
	version := query.Get("version")
	if err := validateVersion(version); err != nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	// `keys` is one comma-separated parameter: the primary key first, then the
	// restore keys in the client's own order (capture L001).
	keys := strings.Split(query.Get("keys"), ",")

	entry, err := s.index.Lookup(ctx, claims, keys, version)
	if err != nil {
		s.logger.Error("v1 restore degraded to a miss", "repository", claims.Repository,
			"ref", claims.Ref, "error", err)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if entry == nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	location, err := s.downloadURL(ctx, r, entry)
	if err != nil {
		s.logger.Error("v1 restore could not mint a download URL", "error", err)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	writeJSON(w, http.StatusOK, v1RestoreResponse{
		CacheKey: entry.Key,
		// `scope` is the ref the matched entry belongs to, which is how a
		// client reports "restored from main" on a feature branch.
		Scope:           entry.Ref,
		ArchiveLocation: location,
	})
}

// v1Reserve answers POST _apis/artifactcache/caches (capture L020).
func (s *Server) v1Reserve(w http.ResponseWriter, r *http.Request) {
	claims, ok := s.require(w, r, true)
	if !ok {
		return
	}
	var request v1ReserveRequest
	if err := s.decodeControl(w, r, &request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "malformed reserve request"})
		return
	}
	if err := validateKey(request.Key); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": err.Error()})
		return
	}
	if err := validateVersion(request.Version); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": err.Error()})
		return
	}
	// cacheSize is sent by @actions/cache (capture L020) and omitted by
	// BuildKit (capture L053), so it is a hint rather than a contract — but a
	// hint that already exceeds the ceiling is worth refusing before the bytes
	// arrive.
	if int64(request.Size) > s.config.MaxEntryBytes {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": ErrEntryTooLarge.Error()})
		return
	}

	ctx, cancel := s.deadline(w, r, s.config.ReserveTimeout)
	defer cancel()

	// Entries are immutable, as GitHub's are. A second save of a key that has
	// already been written is refused rather than allowed to replace bytes an
	// earlier job has already restored.
	exists, err := s.index.Exists(ctx, claims.Repository, claims.WriteScope(), request.Key, request.Version)
	if err != nil {
		s.logger.Error("v1 reserve could not read the index", "error", err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"message": "cache store unavailable"})
		return
	}
	if exists {
		writeJSON(w, http.StatusConflict, map[string]string{
			"message": fmt.Sprintf("cache entry %q already exists for this ref and version", request.Key)})
		return
	}

	id, err := reservationID()
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"message": "cache store unavailable"})
		return
	}
	held, err := newReservation(id, s.spoolPath(fmt.Sprintf("v1-%d", id)), s.config.MaxEntryBytes,
		s.now().Add(s.config.UploadTTL))
	if err != nil {
		s.logger.Error("v1 reserve could not open a spool file", "error", err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"message": "cache store unavailable"})
		return
	}
	held.repository, held.ref = claims.Repository, claims.WriteScope()
	held.key, held.version = request.Key, request.Version

	s.mu.Lock()
	s.reservations[id] = held
	s.mu.Unlock()

	writeJSON(w, http.StatusCreated, map[string]int64{"cacheId": id})
}

// v1Upload answers PATCH _apis/artifactcache/caches/<id> (capture L021-L027).
//
// This is the path ADR 0007 warns puts the full cache byte volume through the
// control path, and it is also the one that does not care about ordering:
// chunks arrive concurrently and out of order, each naming its own byte range.
func (s *Server) v1Upload(w http.ResponseWriter, r *http.Request, rawID string) {
	claims, ok := s.require(w, r, true)
	if !ok {
		return
	}
	held, ok := s.reservationFor(w, rawID, claims.Repository, claims.WriteScope())
	if !ok {
		return
	}
	s.readBodyDeadline(w)

	start, end, err := parseContentRange(r.Header.Get("Content-Range"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": err.Error()})
		return
	}

	written, err := held.writeAt(r.Body, start)
	if errors.Is(err, ErrEntryTooLarge) {
		s.dropReservation(held.id)
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"message": err.Error()})
		return
	}
	if err != nil {
		s.logger.Error("v1 chunk did not land", "cacheId", held.id, "error", err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"message": "cache store unavailable"})
		return
	}
	if end >= 0 && written != end-start+1 {
		s.dropReservation(held.id)
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"message": fmt.Sprintf("Content-Range promised %d bytes and %d arrived", end-start+1, written)})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// v1Commit answers POST _apis/artifactcache/caches/<id> (capture L028), which
// is where the spooled bytes become an entry.
func (s *Server) v1Commit(w http.ResponseWriter, r *http.Request, rawID string) {
	claims, ok := s.require(w, r, true)
	if !ok {
		return
	}
	held, ok := s.reservationFor(w, rawID, claims.Repository, claims.WriteScope())
	if !ok {
		return
	}
	var request v1CommitRequest
	if err := s.decodeControl(w, r, &request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "malformed commit request"})
		return
	}
	if got := held.size(); int64(request.Size) != got {
		// The client is asserting how many bytes it sent. A mismatch means a
		// chunk was lost, and committing it would publish a truncated archive
		// that every later job would restore and fail to unpack.
		s.dropReservation(held.id)
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"message": fmt.Sprintf("commit claims %d bytes and %d arrived", int64(request.Size), got)})
		return
	}

	ctx, cancel := s.deadline(w, r, s.config.TransferTimeout)
	defer cancel()

	spool, err := held.open()
	if err != nil {
		s.dropReservation(held.id)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"message": "cache store unavailable"})
		return
	}
	blob, upload, err := s.index.NewBlob(ctx, claims.Repository)
	if err != nil {
		s.logger.Error("v1 commit could not start a store upload", "error", err)
		s.dropReservation(held.id)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"message": "cache store unavailable"})
		return
	}
	size := held.size()
	part := s.config.Store.PartBytes
	if part <= 0 {
		part = 32 << 20
	}
	for offset := int64(0); offset < size; offset += part {
		length := part
		if remaining := size - offset; remaining < length {
			length = remaining
		}
		if err := upload.AddPart(ctx, io.NewSectionReader(spool, offset, length), length); err != nil {
			s.failCommit(ctx, w, upload, held.id, "v1 commit could not write a part", err)
			return
		}
	}
	if err := upload.Complete(ctx); err != nil {
		s.failCommit(ctx, w, upload, held.id, "v1 commit could not finish the object", err)
		return
	}
	if err := s.index.Commit(ctx, cacheindex.Entry{
		Key: held.key, Version: held.version, Repository: held.repository,
		Ref: held.ref, Blob: blob, Size: size,
	}); err != nil {
		s.failCommit(ctx, w, upload, held.id, "v1 commit could not publish the entry", err)
		return
	}

	s.dropReservation(held.id)
	s.logger.Info("cache entry saved", "generation", "v1", "repository", held.repository,
		"ref", held.ref, "key", held.key, "bytes", size)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) failCommit(ctx context.Context, w http.ResponseWriter, upload interface {
	Abort(context.Context) error
}, id int64, message string, cause error) {
	s.logger.Error(message, "cacheId", id, "error", cause)
	_ = upload.Abort(ctx)
	s.dropReservation(id)
	writeJSON(w, http.StatusServiceUnavailable, map[string]string{"message": "cache store unavailable"})
}

// reservationFor resolves a cache id and proves the caller owns it. A
// reservation belongs to one repository and one ref; anything else is a
// different job asking to write into this upload.
func (s *Server) reservationFor(w http.ResponseWriter, rawID, repository, ref string) (*reservation, bool) {
	id, err := strconv.ParseInt(rawID, 10, 64)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"message": "no such cache reservation"})
		return nil, false
	}
	s.mu.Lock()
	held, ok := s.reservations[id]
	s.mu.Unlock()
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"message": "no such cache reservation"})
		return nil, false
	}
	if !strings.EqualFold(held.repository, repository) || held.ref != ref {
		s.logger.Warn("a cache reservation was claimed by another scope",
			"cacheId", id, "reserved", held.repository, "asked", repository)
		writeJSON(w, http.StatusForbidden, map[string]string{"message": "this token does not own that reservation"})
		return nil, false
	}
	return held, true
}

func (s *Server) dropReservation(id int64) {
	s.mu.Lock()
	held, ok := s.reservations[id]
	delete(s.reservations, id)
	s.mu.Unlock()
	if ok {
		held.discard()
	}
}

// parseContentRange reads "bytes <start>-<end>/*". @actions/cache sends one per
// chunk; BuildKit sends the whole blob in a single PATCH (capture L054). An
// absent header therefore means "this is the whole thing, from zero".
func parseContentRange(value string) (int64, int64, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0, -1, nil
	}
	spec, found := strings.CutPrefix(value, "bytes ")
	if !found {
		return 0, 0, fmt.Errorf("Content-Range must be in bytes, got %q", value)
	}
	rangeSpec, _, _ := strings.Cut(spec, "/")
	rawStart, rawEnd, found := strings.Cut(rangeSpec, "-")
	if !found {
		return 0, 0, fmt.Errorf("Content-Range %q has no range", value)
	}
	start, err := strconv.ParseInt(strings.TrimSpace(rawStart), 10, 64)
	if err != nil || start < 0 {
		return 0, 0, fmt.Errorf("Content-Range %q has no start offset", value)
	}
	end, err := strconv.ParseInt(strings.TrimSpace(rawEnd), 10, 64)
	if err != nil || end < start {
		return 0, 0, fmt.Errorf("Content-Range %q has no end offset", value)
	}
	return start, end, nil
}

// reservationID is the number a client echoes back in its upload and commit
// URLs. It is random rather than sequential so one job cannot address another
// job's reservation by counting, and it stays inside the range a JSON number
// represents exactly.
func reservationID() (int64, error) {
	id, err := rand.Int(rand.Reader, big.NewInt(1<<40))
	if err != nil {
		return 0, err
	}
	return id.Int64() + 1, nil
}
