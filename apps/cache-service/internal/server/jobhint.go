package server

import (
	"encoding/json"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/Fanzzzd/erainfra/apps/cache-service/cachetoken"
)

// Job hints. GitHub's JobStarted message, which the controller derives a job's
// facts from, reaches it 7 to 38 seconds after the job starts. The guest learns
// its run the moment the runner writes the job message, and tells this service
// with its runner token. The hint is only where to look: the controller that
// owns the runner lists it, checks with GitHub that this runner is assigned to a
// job of that run, and only then pushes facts. Nothing here scopes a request.
const (
	jobHintMarker       = "/_erainfra-cache-job-hint"
	adminJobHintsMarker = "/_erainfra-cache-admin/job-hints"
	// jobHintTTL bounds how long an unanswered hint is kept. The controller
	// polls every second or so; a hint it has not acted on in this long is for
	// a run it cannot read, and JobStarted will cover the job.
	jobHintTTL  = 10 * time.Minute
	maxJobHints = 10000
	// adminListSkew bounds the timestamp a listing request carries, so a
	// captured request cannot be replayed indefinitely.
	adminListSkew = 5 * time.Minute
)

// JobHint is one runner's claim about the run it executes.
type JobHint struct {
	Runner     string `json:"runner"`
	Repository string `json:"repository"`
	RunID      int64  `json:"runID"`
	RunAttempt int64  `json:"runAttempt"`
}

type jobHintEntry struct {
	hint    JobHint
	expires time.Time
}

func (s *Server) serveJobHint(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"message": "method not allowed"})
		return
	}
	s.socketDeadline(w, s.config.ReserveTimeout+socketSlack)
	raw, found := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !found || strings.TrimSpace(raw) == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"message": "unauthorized"})
		return
	}
	runner, err := s.verify.VerifyRunner(strings.TrimSpace(raw), s.now())
	if err != nil {
		s.logger.Warn("job hint runner token rejected", "reason", err)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"message": "unauthorized"})
		return
	}
	var body struct {
		Repository string `json:"repository"`
		RunID      int64  `json:"runID"`
		RunAttempt int64  `json:"runAttempt"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4<<10)).Decode(&body); err != nil ||
		cachetoken.ValidateRepository(body.Repository) != nil || body.RunID <= 0 || body.RunAttempt < 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "a hint is a repository owner/name, a positive runID and a runAttempt"})
		return
	}
	if body.RunAttempt == 0 {
		body.RunAttempt = 1
	}
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	if entry, known := s.facts[runner.Runner]; known && !now.After(entry.expires) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if len(s.hints) >= maxJobHints {
		for name, entry := range s.hints {
			if now.After(entry.expires) {
				delete(s.hints, name)
			}
		}
	}
	if len(s.hints) >= maxJobHints {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"message": "too many pending hints"})
		return
	}
	s.hints[runner.Runner] = jobHintEntry{
		hint:    JobHint{Runner: runner.Runner, Repository: body.Repository, RunID: body.RunID, RunAttempt: body.RunAttempt},
		expires: now.Add(jobHintTTL),
	}
	s.logger.Info("job hint received", "runner", runner.Runner, "repository", body.Repository, "runID", body.RunID)
	w.WriteHeader(http.StatusNoContent)
}

// serveAdminJobHints lists the pending hints of the runners whose names start
// with one of the caller's prefixes. It is signed like the facts push.
func (s *Server) serveAdminJobHints(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"message": "method not allowed"})
		return
	}
	s.socketDeadline(w, s.config.ReserveTimeout+socketSlack)
	body, err := io.ReadAll(io.LimitReader(r.Body, maxRequestJSON))
	if err != nil || !s.validAdminSignature(body, r.Header.Get("X-Erainfra-Cache-Admin")) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"message": "unauthorized"})
		return
	}
	var request struct {
		NowUnix        int64    `json:"nowUnix"`
		RunnerPrefixes []string `json:"runnerPrefixes"`
	}
	if err := json.Unmarshal(body, &request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "unreadable body"})
		return
	}
	// Wall clock, like a socket deadline: this is about a request in flight,
	// not about what "expired" means for an entry.
	if skew := time.Since(time.Unix(request.NowUnix, 0)); skew > adminListSkew || skew < -adminListSkew {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"message": "stale request"})
		return
	}
	now := s.now()
	hints := []JobHint{}
	s.mu.Lock()
	for name, entry := range s.hints {
		if now.After(entry.expires) {
			delete(s.hints, name)
			continue
		}
		for _, prefix := range request.RunnerPrefixes {
			if prefix != "" && strings.HasPrefix(name, prefix) {
				hints = append(hints, entry.hint)
				break
			}
		}
	}
	s.mu.Unlock()
	sort.Slice(hints, func(i, j int) bool { return hints[i].Runner < hints[j].Runner })
	writeJSON(w, http.StatusOK, map[string]any{"hints": hints})
}
