package server

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/Fanzzzd/erainfra/apps/cache-service/cachetoken"
)

// adminFactsMarker is the path the controller pushes job facts to. It is not a
// cache endpoint: a job's cache traffic never routes here (the interceptor only
// forwards the CacheService path to this service), and a job that reaches the
// address directly still cannot use it without the shared signing key.
const adminFactsMarker = "/_erainfra-cache-admin/facts"

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

func (s *Server) registerFacts(runner string, facts cachetoken.JobFacts, expires time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.facts[runner] = factsEntry{facts: facts, expires: expires}
}

// lookupFacts returns a runner's facts, or false if none were pushed or they have
// expired. A missing entry is not an error here — it means the controller has not
// pushed yet (or the job outlived its window), and the caller turns it into an
// unauthorized answer the client reads as a miss.
func (s *Server) lookupFacts(runner string, now time.Time) (cachetoken.JobFacts, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.facts[runner]
	if !ok || now.After(entry.expires) {
		return cachetoken.JobFacts{}, false
	}
	return entry.facts, true
}

// serveRegisterFacts records the facts the controller pushes for a runner. It is
// authenticated by the shared signing key, not a job token: the controller proves
// it holds the key by signing the request body, which a job — which never has the
// key — cannot forge.
func (s *Server) serveRegisterFacts(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"message": "method not allowed"})
		return
	}
	s.socketDeadline(w, s.config.ReserveTimeout)
	body, err := io.ReadAll(io.LimitReader(r.Body, maxRequestJSON))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "unreadable body"})
		return
	}
	if !s.adminAuthenticated(r, body) {
		s.logger.Warn("cache facts push rejected", "path", r.URL.Path)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"message": "unauthorized"})
		return
	}

	var req registerFactsRequest
	if err := json.Unmarshal(body, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "malformed body"})
		return
	}
	runner := strings.TrimSpace(req.Runner)
	if err := cachetoken.ValidateRunner(runner); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "invalid runner"})
		return
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
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "facts do not scope a cache"})
		return
	}
	if req.ExpiresUnix <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "an expiry is required"})
		return
	}

	s.registerFacts(runner, facts, time.Unix(req.ExpiresUnix, 0))
	w.WriteHeader(http.StatusNoContent)
}

// adminAuthenticated proves the caller holds the shared signing key by checking
// an HMAC of the exact request body. Replay is harmless: the push is idempotent
// and the facts carry their own expiry.
func (s *Server) adminAuthenticated(r *http.Request, body []byte) bool {
	got := r.Header.Get("X-Erainfra-Cache-Admin")
	if got == "" {
		return false
	}
	mac := hmac.New(sha256.New, s.config.SigningKey)
	mac.Write(body)
	want := hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(got), []byte(want))
}
