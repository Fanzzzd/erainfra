package server

import (
	"context"
	"encoding/hex"
	"net/http"
	"strings"

	"github.com/Fanzzzd/erainfra/apps/cache-service/internal/cacheindex"
	"github.com/Fanzzzd/erainfra/apps/cache-service/internal/config"
)

// Cache Service v2, the twirp API under ACTIONS_RESULTS_URL.
//
// Everything about the response shapes here is measured. In particular a miss
// is 200 with {"ok": false} and never a twirp 404: a 404 costs a warning and a
// lost cache (capture L123), and a 500 costs five attempts and about 30 seconds
// of backoff per restore step before the same lost cache (capture L124-L128).

type v2DownloadRequest struct {
	Key         string   `json:"key"`
	RestoreKeys []string `json:"restore_keys"`
	Version     string   `json:"version"`
}

// v2DownloadResponse carries every field on a miss as well as on a hit, empty,
// exactly as the service answered in capture L007.
type v2DownloadResponse struct {
	OK                bool   `json:"ok"`
	SignedDownloadURL string `json:"signed_download_url"`
	MatchedKey        string `json:"matched_key"`
}

type v2CreateRequest struct {
	Key     string `json:"key"`
	Version string `json:"version"`
}

type v2CreateResponse struct {
	OK              bool   `json:"ok"`
	SignedUploadURL string `json:"signed_upload_url"`
}

type v2FinalizeRequest struct {
	Key       string    `json:"key"`
	SizeBytes flexInt64 `json:"size_bytes"`
	Version   string    `json:"version"`
}

type v2FinalizeResponse struct {
	OK      bool   `json:"ok"`
	EntryID string `json:"entry_id"`
}

func (s *Server) serveV2(w http.ResponseWriter, r *http.Request, method string) {
	if r.Method != http.MethodPost {
		writeTwirpError(w, http.StatusNotFound, "bad_route", "cache service methods are POST")
		return
	}
	switch method {
	case "GetCacheEntryDownloadURL":
		s.v2Download(w, r)
	case "CreateCacheEntry":
		s.v2Create(w, r)
	case "FinalizeCacheEntryUpload":
		s.v2Finalize(w, r)
	default:
		// The capture drove exactly three methods (L007, L008, L010). Anything
		// else is unmeasured, so it is refused loudly here rather than
		// answered with a guess.
		s.logger.Warn("unimplemented cache service v2 method", "method", method)
		writeTwirpError(w, http.StatusNotFound, "bad_route", "no such method: "+method)
	}
}

func writeTwirpError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]string{"code": code, "msg": message})
}

func (s *Server) v2Download(w http.ResponseWriter, r *http.Request) {
	claims, ok := s.require(w, r, false)
	if !ok {
		return
	}
	var request v2DownloadRequest
	if err := s.decodeControl(w, r, &request); err != nil {
		writeJSON(w, http.StatusOK, v2DownloadResponse{})
		return
	}
	if err := validateVersion(request.Version); err != nil {
		writeJSON(w, http.StatusOK, v2DownloadResponse{})
		return
	}

	// The primary key first, then the restore keys in order. BuildKit repeats
	// the primary key inside restore_keys (capture L078), so duplicates are
	// dropped rather than searched twice.
	keys := make([]string, 0, len(request.RestoreKeys)+1)
	for _, key := range append([]string{request.Key}, request.RestoreKeys...) {
		key = strings.TrimSpace(key)
		if key == "" || containsString(keys, key) {
			continue
		}
		keys = append(keys, key)
	}

	ctx, cancel := s.deadline(w, r, s.config.LookupTimeout)
	defer cancel()

	entry, err := s.index.Lookup(ctx, claims, keys, request.Version)
	if err != nil {
		s.logger.Error("v2 restore degraded to a miss", "repository", claims.Repository,
			"ref", claims.Ref, "error", err)
		writeJSON(w, http.StatusOK, v2DownloadResponse{})
		return
	}
	if entry == nil {
		writeJSON(w, http.StatusOK, v2DownloadResponse{})
		return
	}
	location, err := s.downloadURL(ctx, r, entry)
	if err != nil {
		s.logger.Error("v2 restore could not mint a download URL", "error", err)
		writeJSON(w, http.StatusOK, v2DownloadResponse{})
		return
	}
	writeJSON(w, http.StatusOK, v2DownloadResponse{
		OK: true, SignedDownloadURL: location, MatchedKey: entry.Key,
	})
}

// v2Create answers CreateCacheEntry (capture L008).
//
// The signed_upload_url it hands back points at this service, not at the store.
// It has to: the URL is consumed by an Azure Blob client that stages blocks and
// commits an XML block list, and a presigned S3 PUT can neither accept
// ?comp=block nor return the x-ms-request-id the client dereferences without a
// nil check. ADR 0007 named the two ways out and this is the translate one.
func (s *Server) v2Create(w http.ResponseWriter, r *http.Request) {
	claims, ok := s.require(w, r, true)
	if !ok {
		return
	}
	var request v2CreateRequest
	if err := s.decodeControl(w, r, &request); err != nil {
		writeJSON(w, http.StatusOK, v2CreateResponse{})
		return
	}
	if err := validateKey(request.Key); err != nil {
		s.logger.Warn("refused a v2 reservation", "reason", err)
		writeJSON(w, http.StatusOK, v2CreateResponse{})
		return
	}
	if err := validateVersion(request.Version); err != nil {
		writeJSON(w, http.StatusOK, v2CreateResponse{})
		return
	}

	ctx, cancel := s.deadline(w, r, s.config.ReserveTimeout)
	defer cancel()

	exists, err := s.index.Exists(ctx, claims.Repository, claims.WriteScope(), request.Key, request.Version)
	if err != nil {
		// Refusing the reservation costs the job a save and a warning. It does
		// not cost it retries, which is why this is 200 {"ok": false} rather
		// than a twirp error.
		s.logger.Error("v2 reserve could not read the index", "error", err)
		writeJSON(w, http.StatusOK, v2CreateResponse{})
		return
	}
	if exists {
		s.logger.Info("refused a v2 reservation for an existing entry",
			"repository", claims.Repository, "ref", claims.WriteScope(), "key", request.Key)
		writeJSON(w, http.StatusOK, v2CreateResponse{})
		return
	}

	id, err := randomHex(16)
	if err != nil {
		writeJSON(w, http.StatusOK, v2CreateResponse{})
		return
	}
	expires := s.now().Add(s.config.UploadTTL)
	held, err := newSession(id, s.spoolPath("v2-"+id), s.config.MaxEntryBytes, expires)
	if err != nil {
		s.logger.Error("v2 reserve could not open a spool directory", "error", err)
		writeJSON(w, http.StatusOK, v2CreateResponse{})
		return
	}
	held.repository, held.ref = claims.Repository, claims.WriteScope()
	held.key, held.version = request.Key, request.Version

	s.mu.Lock()
	s.sessions[id] = held
	s.mu.Unlock()

	writeJSON(w, http.StatusOK, v2CreateResponse{
		OK: true,
		// The credential is in the path rather than the query string. The
		// capture renders every signed URL with its query elided — L008 mints
		// one with ?sig=&se= and L009 shows the client's PUT to "{signed url}"
		// with no query at all — so it does not establish that an Azure client
		// preserves query parameters when it appends ?comp=block. Putting the
		// authority in the path removes the question.
		SignedUploadURL: s.publicBase(r) + blobMarker + s.signName("upload", id, expires) + ".tzst",
	})
}

// v2Finalize answers FinalizeCacheEntryUpload (capture L010, L038, L086).
func (s *Server) v2Finalize(w http.ResponseWriter, r *http.Request) {
	claims, ok := s.require(w, r, true)
	if !ok {
		return
	}
	var request v2FinalizeRequest
	if err := s.decodeControl(w, r, &request); err != nil {
		writeJSON(w, http.StatusOK, v2FinalizeResponse{})
		return
	}

	held := s.sessionForEntry(claims.Repository, claims.WriteScope(), request.Key, request.Version)
	if held == nil {
		s.logger.Warn("v2 finalize named an upload this service does not hold",
			"repository", claims.Repository, "key", request.Key)
		writeJSON(w, http.StatusOK, v2FinalizeResponse{})
		return
	}
	blob, size, committed := held.state()
	if !committed {
		s.logger.Warn("v2 finalize arrived before the block list was committed",
			"repository", claims.Repository, "key", request.Key)
		writeJSON(w, http.StatusOK, v2FinalizeResponse{})
		return
	}
	if int64(request.SizeBytes) != size {
		// The bytes are the ones this service assembled from the committed
		// block list, so the entry is intact either way; the client's own count
		// is a cross-check, not the source of truth. Both measured clients
		// agree with it exactly (capture L038, L086), so a disagreement is
		// worth a log line and not worth discarding a completed upload over.
		s.logger.Warn("v2 finalize disagrees about the entry size",
			"key", request.Key, "claimed", int64(request.SizeBytes), "stored", size)
	}

	ctx, cancel := s.deadline(w, r, s.config.ReserveTimeout)
	defer cancel()

	if err := s.index.Commit(ctx, cacheindex.Entry{
		Key: held.key, Version: held.version, Repository: held.repository,
		Ref: held.ref, Blob: blob, Size: size,
	}); err != nil {
		s.logger.Error("v2 finalize could not publish the entry", "error", err)
		writeJSON(w, http.StatusOK, v2FinalizeResponse{})
		return
	}
	s.dropSession(held.id)
	s.logger.Info("cache entry saved", "generation", "v2", "repository", held.repository,
		"ref", held.ref, "key", held.key, "bytes", size)
	writeJSON(w, http.StatusOK, v2FinalizeResponse{OK: true, EntryID: held.id})
}

// downloadURL is what a job is given to fetch an entry's bytes with. Presigned
// is the default and is ADR 0007 rule 4's shape: one object, GET only, and it
// expires. Proxy exists for a store the jobs cannot route to — the presigned
// URL is resolved by the job, so an endpoint reachable only from this service
// has to be streamed instead.
func (s *Server) downloadURL(ctx context.Context, r *http.Request, entry *cacheindex.Entry) (string, error) {
	if s.config.DownloadMode == config.DownloadProxy {
		expires := s.now().Add(s.config.DownloadTTL)
		return s.publicBase(r) + downloadMarker +
			s.signName("download", hex.EncodeToString([]byte(entry.Blob)), expires) + "/cache.tzst", nil
	}
	return s.index.PresignBlob(ctx, entry.Blob, s.config.DownloadTTL)
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

// sessionForEntry finds the upload a FinalizeCacheEntryUpload is talking about.
//
// There can be more than one. CreateCacheEntry is refused only when the entry
// already exists in the index, so a client that reserves the same key twice —
// a retry, or a step that runs again — gets a second session, and Go's map
// iteration order is deliberately random. Returning whichever came first would
// answer {"ok":false} for an upload that had already put every byte in the
// store. Prefer the one that is committed; otherwise the newest, which is the
// one the client most recently reserved.
func (s *Server) sessionForEntry(repository, ref, key, version string) *session {
	s.mu.Lock()
	defer s.mu.Unlock()
	var newest *session
	for _, held := range s.sessions {
		if !strings.EqualFold(held.repository, repository) || held.ref != ref ||
			held.key != key || held.version != version {
			continue
		}
		// state takes the session's own mutex, which is not this one.
		if _, _, committed := held.state(); committed {
			return held
		}
		if newest == nil || held.expires.After(newest.expires) {
			newest = held
		}
	}
	return newest
}

func (s *Server) dropSession(id string) {
	s.mu.Lock()
	held, ok := s.sessions[id]
	delete(s.sessions, id)
	s.mu.Unlock()
	if ok {
		held.discard()
	}
}
