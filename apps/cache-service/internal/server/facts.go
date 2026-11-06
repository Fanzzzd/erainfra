package server

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/Fanzzzd/erainfra/apps/cache-service/cachetoken"
	"github.com/Fanzzzd/erainfra/apps/cache-service/internal/objectstore"
)

// adminFactsMarker is the path the controller pushes job facts to. It is not a
// cache endpoint: a job's cache traffic never routes here (the interceptor only
// forwards the CacheService path to this service), and a job that reaches the
// address directly still cannot use it without the shared signing key.
const adminFactsMarker = "/_erainfra-cache-admin/facts"

// factsRoot is where pushed job facts are kept in the bucket, one object per
// runner, beside the index's entries/, blobs/, access/ and tombstones/. No
// eviction walk lists it, so a facts object is never mistaken for cache data.
//
// The bucket and not this process's memory is the copy of record because the
// controller pushes a runner's facts exactly once, at JobStarted. A service that
// kept them only in memory forgot every running job on a deploy, a crash or a
// host reboot, and each of those jobs then had every restore refused and every
// save skipped until it ended, with nothing that would ever push again. Keeping
// them in the store already configured adds no dependency, survives the
// controller failing over (the facts are already here; no controller has to
// remember them), and lets more than one replica serve the same runner.
const factsRoot = "facts/"

// maxFactsRecordBytes bounds a stored facts record. A real one is a few hundred
// bytes: the push body is capped by the field validation that precedes it.
const maxFactsRecordBytes = 16 << 10

// unknownFactsMemo is how long a runner the bucket had no facts for is answered
// from memory. A push to this process replaces the memo at once; a push that
// landed on another replica is seen at most this late.
const unknownFactsMemo = 10 * time.Second

// factsEntry is one runner's job facts and the moment they stop being usable.
// The controller pushes them at JobStarted; every request that runner makes is
// scoped from them until they expire.
type factsEntry struct {
	facts   cachetoken.JobFacts
	expires time.Time
}

// registerFactsRequest is the controller's JobStarted push: which runner, the
// GitHub facts that scope its cache, and when they expire. The repository is not
// known when the runner's VM boots, so this is how it — and the read/write
// decision that depends on the event and head repository — reaches the service.
type registerFactsRequest struct {
	Runner         string `json:"runner"`
	Repository     string `json:"repository"`
	HeadRepository string `json:"headRepository,omitempty"`
	Event          string `json:"event,omitempty"`
	Ref            string `json:"ref"`
	BaseRef        string `json:"baseRef,omitempty"`
	DefaultBranch  string `json:"defaultBranch,omitempty"`
	Attempt        string `json:"attempt,omitempty"`
	ExpiresUnix    int64  `json:"expiresUnix"`
}

// factsRecord is a push as it is kept in the bucket: the controller's body byte
// for byte and the signature it arrived with. Loading it re-verifies that
// signature, so whoever can write to the bucket still cannot grant a runner a
// repository's cache without the signing key. The body is bytes (base64 in JSON)
// rather than a json.RawMessage because encoding/json compacts a RawMessage on
// the way out, which would change the bytes the signature covers.
type factsRecord struct {
	Body      []byte `json:"body"`
	Signature string `json:"signature"`
}

// factsLookup is what a facts lookup found. Unreadable is told apart from
// unknown because they send an operator to different places: the store, or the
// controller.
type factsLookup int

const (
	factsUnknown factsLookup = iota
	factsFound
	factsUnreadable
)

// errFactsUnusable is a push body that names no usable runner or scope; the
// message is what the controller is told.
type errFactsUnusable string

func (e errFactsUnusable) Error() string { return string(e) }

// parseFactsPush validates a push body. The push handler and the bucket loader
// both go through it, so a stored record is held to exactly the rule a fresh
// push is.
func parseFactsPush(body []byte) (string, cachetoken.JobFacts, time.Time, error) {
	var req registerFactsRequest
	if err := json.Unmarshal(body, &req); err != nil {
		return "", cachetoken.JobFacts{}, time.Time{}, errFactsUnusable("malformed body")
	}
	runner := strings.TrimSpace(req.Runner)
	if err := cachetoken.ValidateRunner(runner); err != nil {
		return "", cachetoken.JobFacts{}, time.Time{}, errFactsUnusable("invalid runner")
	}
	facts := cachetoken.JobFacts{
		Repository:     req.Repository,
		HeadRepository: req.HeadRepository,
		Event:          req.Event,
		Ref:            req.Ref,
		BaseRef:        req.BaseRef,
		DefaultBranch:  req.DefaultBranch,
		Attempt:        req.Attempt,
	}
	// Reject facts that could never authorize anything rather than store a runner
	// entry that would fail every request it scopes.
	if _, err := cachetoken.Scope(facts); err != nil {
		return "", cachetoken.JobFacts{}, time.Time{}, errFactsUnusable("facts do not scope a cache")
	}
	if req.ExpiresUnix <= 0 {
		return "", cachetoken.JobFacts{}, time.Time{}, errFactsUnusable("an expiry is required")
	}
	return runner, facts, time.Unix(req.ExpiresUnix, 0), nil
}

func (s *Server) registerFacts(runner string, facts cachetoken.JobFacts, expires time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.facts[runner] = factsEntry{facts: facts, expires: expires}
	delete(s.unknown, runner)
}

// lookupFacts returns a runner's facts: from memory, or else from the bucket,
// which is how a restarted service picks up the jobs that were running before
// it. A missing entry is not an error here — the controller has not pushed yet,
// or the job outlived its window — and the caller turns it into an unauthorized
// answer.
func (s *Server) lookupFacts(ctx context.Context, runner string, now time.Time) (cachetoken.JobFacts, factsLookup) {
	s.mu.Lock()
	entry, known := s.facts[runner]
	unknownUntil, memoized := s.unknown[runner]
	s.mu.Unlock()
	switch {
	case known && now.After(entry.expires):
		return cachetoken.JobFacts{}, factsUnknown
	case known:
		return entry.facts, factsFound
	case memoized && !now.After(unknownUntil):
		return cachetoken.JobFacts{}, factsUnknown
	}

	load, cancel := context.WithTimeout(ctx, s.config.LookupTimeout)
	defer cancel()
	facts, expires, err := s.loadFacts(load, runner)
	switch {
	case errors.Is(err, objectstore.ErrNotFound):
		s.mu.Lock()
		s.unknown[runner] = now.Add(unknownFactsMemo)
		s.mu.Unlock()
		return cachetoken.JobFacts{}, factsUnknown
	case err != nil:
		s.logger.Warn("job facts could not be loaded from the store", "runner", runner, "error", err)
		return cachetoken.JobFacts{}, factsUnreadable
	case now.After(expires):
		return cachetoken.JobFacts{}, factsUnknown
	}
	s.registerFacts(runner, facts, expires)
	s.metrics.factsLoaded.Add(1)
	s.logger.Info("job facts loaded from the store", "runner", runner, "repository", facts.Repository)
	return facts, factsFound
}

// persistFacts writes a verified push to the bucket.
func (s *Server) persistFacts(ctx context.Context, runner string, body []byte, signature string) error {
	record, err := json.Marshal(factsRecord{Body: body, Signature: signature})
	if err != nil {
		return err
	}
	return s.store.PutBytes(ctx, factsRoot+runner, "application/json", record)
}

// loadFacts reads a runner's record from the bucket and holds it to the same
// signature and validation a push is. A record that fails either is refused, and
// the next facts sweep deletes it.
func (s *Server) loadFacts(ctx context.Context, runner string) (cachetoken.JobFacts, time.Time, error) {
	raw, err := s.store.GetBytes(ctx, factsRoot+runner, maxFactsRecordBytes)
	if err != nil {
		return cachetoken.JobFacts{}, time.Time{}, err
	}
	return s.decodeFactsRecord(runner, raw)
}

func (s *Server) decodeFactsRecord(runner string, raw []byte) (cachetoken.JobFacts, time.Time, error) {
	var record factsRecord
	if err := json.Unmarshal(raw, &record); err != nil {
		return cachetoken.JobFacts{}, time.Time{}, errors.New("stored job facts are not a facts record")
	}
	if !s.validAdminSignature(record.Body, record.Signature) {
		return cachetoken.JobFacts{}, time.Time{}, errors.New("stored job facts do not carry a valid signature")
	}
	named, facts, expires, err := parseFactsPush(record.Body)
	if err != nil {
		return cachetoken.JobFacts{}, time.Time{}, err
	}
	if named != runner {
		return cachetoken.JobFacts{}, time.Time{}, errors.New("stored job facts name a different runner")
	}
	return facts, expires, nil
}

// sweepStoredFacts deletes facts records whose job window has closed, and records
// that could never be used. It is what bounds facts/ to the jobs started within
// one facts lifetime (the controller's six hours) plus one sweep interval. Every
// step is safe to repeat, so replicas sweeping at once cost duplicate reads only.
func (s *Server) sweepStoredFacts(ctx context.Context) (deleted int, err error) {
	now := s.now()
	after := ""
	for {
		page, truncated, err := s.store.ListAfter(ctx, factsRoot, after, 1000)
		if err != nil {
			return deleted, err
		}
		for _, object := range page {
			after = object.Key
			runner := strings.TrimPrefix(object.Key, factsRoot)
			raw, err := s.store.GetBytes(ctx, object.Key, maxFactsRecordBytes)
			if errors.Is(err, objectstore.ErrNotFound) {
				continue
			}
			if err != nil {
				return deleted, err
			}
			_, expires, err := s.decodeFactsRecord(runner, raw)
			if err == nil && !now.After(expires) {
				continue
			}
			if err := s.store.Delete(ctx, object.Key); err != nil {
				return deleted, err
			}
			deleted++
		}
		if !truncated || len(page) == 0 {
			return deleted, nil
		}
	}
}

// serveRegisterFacts records the facts the controller pushes for a runner. It is
// authenticated by the shared signing key, not a job token: the controller proves
// it holds the key by signing the request body, which a job — which never has the
// key — cannot forge.
//
// It answers 204 only once the facts are in the bucket. A store that refuses the
// write gets a 503, which the controller retries; the facts are served from this
// process's memory meanwhile, so the job is not made to wait on the store.
func (s *Server) serveRegisterFacts(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"message": "method not allowed"})
		return
	}
	s.socketDeadline(w, s.config.ReserveTimeout+socketSlack)
	body, err := io.ReadAll(io.LimitReader(r.Body, maxRequestJSON))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "unreadable body"})
		return
	}
	signature := r.Header.Get("X-Erainfra-Cache-Admin")
	if !s.validAdminSignature(body, signature) {
		s.logger.Warn("cache facts push rejected", "path", r.URL.Path)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"message": "unauthorized"})
		return
	}

	runner, facts, expires, err := parseFactsPush(body)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": err.Error()})
		return
	}

	s.registerFacts(runner, facts, expires)
	persist, cancel := context.WithTimeout(r.Context(), s.config.ReserveTimeout)
	defer cancel()
	if err := s.persistFacts(persist, runner, body, signature); err != nil {
		s.metrics.factsPersistFailures.Add(1)
		s.logger.Error("job facts not written to the store; a restart before the controller retries forgets them",
			"runner", runner, "error", err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"message": "facts not persisted"})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// validAdminSignature proves the caller holds the shared signing key by checking
// an HMAC of the exact request body. Replay is harmless: the push is idempotent
// and the facts carry their own expiry.
func (s *Server) validAdminSignature(body []byte, got string) bool {
	if got == "" {
		return false
	}
	mac := hmac.New(sha256.New, s.config.SigningKey)
	mac.Write(body)
	want := hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(got), []byte(want))
}
