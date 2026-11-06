package server

import (
	"errors"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/Fanzzzd/erainfra/apps/cache-service/cachetoken"
	"github.com/Fanzzzd/erainfra/apps/cache-service/internal/cacheindex"
	"github.com/Fanzzzd/erainfra/apps/cache-service/internal/objectstore"
)

// Build-system caches: the Turborepo Remote Cache API and the Go build cache.
//
// Both are stored as ordinary index entries, so they are scoped, counted
// against the repository quota, evicted by the same idle and LRU rules, and
// listed and deleted by the same admin API as actions/cache entries. What sets
// them apart is only the key and version they are filed under (buildKey and
// buildVersion), and that a lookup is exact: their keys are content hashes, so
// a hash that merely starts with the one asked for is another build's output.
//
// A job does not call these endpoints with a bearer of its own. The guest's
// build cache proxy (apps/runtime/internal/guestcache) presents the runner
// bearer the host minted, the same one the actions/cache interceptor presents,
// and the repository and permission come from the facts the controller pushed
// for that runner. A fork pull request therefore reads and does not write here
// exactly as it does through actions/cache.
const buildMarker = "/_erainfra-build/"

// BuildArchHeader names the CPU architecture the requesting guest runs on. Build
// outputs are filed per architecture, as Blacksmith does, because a Turborepo
// task's outputs can hold native binaries its hash does not account for. The
// guest proxy sets it from its own GOARCH; a request without it is filed under
// "any".
const BuildArchHeader = "X-Erainfra-Build-Arch"

// GoOutputIDHeader carries the output ID cmd/go stored with a build cache
// entry, in hex. cmd/go computes it as the SHA-256 of the body, which is what
// lets the helper check a download before handing it to the compiler.
const GoOutputIDHeader = "X-Erainfra-Go-Output-Id"

var (
	buildArchPattern = regexp.MustCompile(`^[a-z0-9_]{1,16}$`)
	// turboHashPattern is the spec's ^[a-fA-F0-9]+$ with a length bound, so a
	// key stays well inside maxCacheKeyBytes.
	turboHashPattern = regexp.MustCompile(`^[a-fA-F0-9]{1,128}$`)
	// goIDPattern is a cmd/go action or output ID: a SHA-256 in hex.
	goIDPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
)

// Build systems, as they appear in the route, the key and the metrics.
const (
	buildTurbo = "turbo"
	buildGo    = "go"
)

var buildSystems = [...]string{buildTurbo, buildGo}

// buildKey and buildVersion file a build-system entry in the index. The
// version can never equal an actions/cache version, which is always a SHA-256
// hex digest, so the two kinds of entry never answer each other's lookups.
func buildKey(system, id string) string { return system + "/" + id }

func buildVersion(system, arch string) string { return "erainfra-build:" + system + ":" + arch }

func (s *Server) serveBuild(w http.ResponseWriter, r *http.Request, route string) {
	system, rest, _ := strings.Cut(route, "/")
	arch := r.Header.Get(BuildArchHeader)
	if arch == "" {
		arch = "any"
	}
	if !buildArchPattern.MatchString(arch) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "invalid " + BuildArchHeader})
		return
	}
	switch system {
	case buildTurbo:
		s.serveTurbo(w, r, rest, arch)
	case buildGo:
		s.serveGo(w, r, rest, arch)
	default:
		http.NotFound(w, r)
	}
}

// buildClaims authenticates a build-cache request with the same rules as every
// other cache request, and refuses a write from a read-only token. refuse
// writes the protocol's own error shape.
func (s *Server) buildClaims(r *http.Request, write bool, refuse func(status int, code, message string)) (cachetoken.Claims, bool) {
	claims, ok := s.authenticate(r)
	if !ok {
		refuse(http.StatusUnauthorized, "unauthorized", "unauthorized")
		return cachetoken.Claims{}, false
	}
	if write && !claims.CanWrite() {
		s.logger.Info("refused a build cache write to a read-only token",
			"repository", claims.Repository, "ref", claims.Ref, "path", r.URL.Path)
		refuse(http.StatusForbidden, "forbidden", "this job may read the cache but not write to it")
		return cachetoken.Claims{}, false
	}
	return claims, true
}

// findBuildEntry is a build-cache lookup. A store that fails or is slow is
// answered as a miss, as a v1 restore is: the build runs, which is the cost of
// a miss, and the log says why. The error it returns with a nil entry is only
// for the caller's metric (missOrError).
func (s *Server) findBuildEntry(w http.ResponseWriter, r *http.Request, claims cachetoken.Claims, key, version string) (*cacheindex.Entry, error) {
	ctx, cancel := s.deadline(w, r, s.config.LookupTimeout)
	defer cancel()
	entry, err := s.index.LookupExact(ctx, claims, key, version)
	if err != nil {
		s.logger.Error("build cache lookup degraded to a miss", "repository", claims.Repository,
			"key", key, "error", err)
		return nil, err
	}
	return entry, nil
}

// errBlobMismatch is a blob whose size is not its entry's.
var errBlobMismatch = errors.New("build cache blob does not match its entry")

// streamBuildEntry sends an entry's bytes. Build-system entries are always
// streamed through this service, in presign mode too: they are many and small,
// so a redirect would add a round trip to every hit, and neither client
// documents following one. Headers are set by the caller before this runs.
//
// It reports whether it sent the entry. When it did not, the error is nil for
// a blob evicted since the lookup, a plain miss, and the store's failure
// otherwise.
func (s *Server) streamBuildEntry(w http.ResponseWriter, r *http.Request, entry *cacheindex.Entry) (bool, error) {
	ctx, cancel := s.deadline(w, r, s.config.TransferTimeout)
	defer cancel()
	body, size, err := s.index.OpenBlob(ctx, entry.Blob)
	if err != nil {
		if errors.Is(err, objectstore.ErrNotFound) {
			return false, nil
		}
		s.logger.Error("build cache download degraded to a miss", "blob", entry.Blob, "error", err)
		return false, err
	}
	defer body.Close() //nolint:errcheck // read-only body; a close error loses nothing
	if size >= 0 && size != entry.Size {
		s.logger.Error("build cache blob does not match its entry; answering a miss",
			"blob", entry.Blob, "entry", entry.Size, "blob_size", size)
		return false, errBlobMismatch
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.FormatInt(entry.Size, 10))
	w.WriteHeader(http.StatusOK)
	if _, err := io.Copy(w, body); err != nil {
		s.logger.Warn("build cache download stopped early", "error", err)
	}
	return true, nil
}

// saveResult is how a build-cache upload ended. Each protocol turns it into
// its own status.
type saveResult int

const (
	saveStored saveResult = iota
	// saveExisted is a key already saved in this ref's scope. Entries are
	// immutable, as actions/cache entries are, and a content-hashed key names
	// the same output, so the upload is answered as a success and not stored.
	saveExisted
	saveNeedLength
	saveTooLarge
	saveShortBody
	saveUnavailable
)

// saveBuildEntry spools a request body and publishes it as an entry in the
// token's write scope. The body is spooled rather than streamed into the store
// so a client that disconnects halfway leaves nothing behind, the same reason
// v1 spools.
func (s *Server) saveBuildEntry(w http.ResponseWriter, r *http.Request, claims cachetoken.Claims, key, version string, attributes map[string]string) saveResult {
	size := r.ContentLength
	switch {
	case size < 0:
		return saveNeedLength
	case size > s.config.MaxEntryBytes:
		return saveTooLarge
	}
	ctx, cancel := s.deadline(w, r, s.config.TransferTimeout)
	defer cancel()

	exists, err := s.index.Exists(ctx, claims, key, version)
	if err != nil {
		s.logger.Error("build cache save could not read the index", "error", err)
		return saveUnavailable
	}
	if exists {
		return saveExisted
	}

	name, err := randomHex(16)
	if err != nil {
		return saveUnavailable
	}
	held, err := newReservation(0, s.spoolPath("build-"+name), size, s.now().Add(s.config.TransferTimeout))
	if err != nil {
		s.logger.Error("build cache save could not open a spool file", "error", err)
		return saveUnavailable
	}
	defer held.discard()
	written, err := held.writeAt(r.Body, 0)
	if errors.Is(err, ErrEntryTooLarge) {
		return saveTooLarge
	}
	if err != nil || written != size {
		return saveShortBody
	}
	spool, err := held.open()
	if err != nil {
		return saveUnavailable
	}

	blob, upload, err := s.index.NewBlob(ctx, claims.Repository)
	if err != nil {
		s.logger.Error("build cache save could not start a store upload", "error", err)
		return saveUnavailable
	}
	part := s.config.Store.PartBytes
	if part <= 0 {
		part = 32 << 20
	}
	for offset := int64(0); offset < size; offset += part {
		length := min(part, size-offset)
		if err := upload.AddPart(ctx, io.NewSectionReader(spool, offset, length), length); err != nil {
			s.logger.Error("build cache save could not write a part", "error", err)
			_ = upload.Abort(ctx)
			return saveUnavailable
		}
	}
	if err := upload.Complete(ctx); err != nil {
		s.logger.Error("build cache save could not finish the object", "error", err)
		_ = upload.Abort(ctx)
		return saveUnavailable
	}
	if err := s.index.Commit(ctx, cacheindex.Entry{
		Key: key, Version: version, Repository: claims.Repository, RepositoryID: claims.RepositoryID,
		Ref: claims.WriteScope(), Blob: blob, Size: size, Attributes: attributes,
	}); err != nil {
		s.logger.Error("build cache save could not publish the entry", "error", err)
		_ = upload.Abort(ctx)
		return saveUnavailable
	}
	// Debug, not Info: one Go build saves an entry per package it compiles.
	s.logger.Debug("build cache entry saved", "repository", claims.Repository,
		"ref", claims.WriteScope(), "key", key, "bytes", size)
	return saveStored
}

// headerValue reads an optional metadata header a client asks to have stored
// and echoed. It refuses anything that could not be echoed back verbatim.
func headerValue(r *http.Request, name string, limit int) (string, bool) {
	value := r.Header.Get(name)
	if len(value) > limit {
		return "", false
	}
	for i := 0; i < len(value); i++ {
		if value[i] < 0x20 || value[i] >= 0x7f {
			return "", false
		}
	}
	return value, true
}
