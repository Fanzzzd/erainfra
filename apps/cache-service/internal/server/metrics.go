package server

import (
	"fmt"
	"net/http"
	"strings"
	"sync/atomic"
)

// Refusal reasons. Each is a distinct log line too; the counter is what an alert
// can be written against, because a refused request is the one cache failure the
// job does not report loudly: actions/cache warns and carries on.
const (
	refusedNoToken         = "no_token"
	refusedBadToken        = "bad_token"
	refusedUnknownFacts    = "unknown_facts"
	refusedFactsUnreadable = "facts_unreadable"
	refusedUnscopable      = "unscopable"
)

var refusalReasons = [...]string{
	refusedNoToken, refusedBadToken, refusedUnknownFacts, refusedFactsUnreadable, refusedUnscopable,
}

// metrics are the service's counters since it started. They are plain atomics
// rendered in the Prometheus text format by hand: five counters do not justify a
// client library, and every series is emitted from the first scrape (at zero) so
// a rate() over a fresh process is defined.
type metrics struct {
	refused              [len(refusalReasons)]atomic.Int64
	factsLoaded          atomic.Int64
	factsPersistFailures atomic.Int64
	// builds counts build-system cache outcomes, by system and outcome.
	builds [len(buildSystems)][len(buildOutcomes)]atomic.Int64
	// stalePurgesRefused counts newer repositories' git seeds a save left in
	// place (removeGitSeeds). The saves refused are counted by the index.
	stalePurgesRefused atomic.Int64
}

// Build-system cache outcomes. A write refused to a read-only token is not one
// of them: that is a fork pull request doing what it may, not a fault. error
// is the store failing a request: a lookup or download the job was answered as
// a miss, or an upload that was not saved. It is counted apart from miss so a
// store outage does not read as a cold cache.
const (
	buildHit   = "hit"
	buildMiss  = "miss"
	buildSaved = "saved"
	buildError = "error"
)

var buildOutcomes = [...]string{buildHit, buildMiss, buildSaved, buildError}

// missOrError is the outcome of a lookup that found nothing: a miss, or an
// error when the store did not answer.
func missOrError(err error) string {
	if err != nil {
		return buildError
	}
	return buildMiss
}

func (m *metrics) build(system, outcome string) {
	for i, knownSystem := range buildSystems {
		if knownSystem != system {
			continue
		}
		for j, knownOutcome := range buildOutcomes {
			if knownOutcome == outcome {
				m.builds[i][j].Add(1)
				return
			}
		}
	}
}

func (m *metrics) refuse(reason string) {
	for i, known := range refusalReasons {
		if known == reason {
			m.refused[i].Add(1)
			return
		}
	}
}

// serveMetrics answers a Prometheus scrape. It carries counts only, no
// repository, runner or key, so it is served without authentication like
// /healthz.
func (s *Server) serveMetrics(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"message": "method not allowed"})
		return
	}
	var out strings.Builder
	out.WriteString("# HELP erainfra_cache_requests_refused_total Cache requests answered 401, by reason. unknown_facts means the controller's job facts for the runner never arrived or have expired.\n")
	out.WriteString("# TYPE erainfra_cache_requests_refused_total counter\n")
	for i, reason := range refusalReasons {
		fmt.Fprintf(&out, "erainfra_cache_requests_refused_total{reason=%q} %d\n", reason, s.metrics.refused[i].Load())
	}
	out.WriteString("# HELP erainfra_cache_job_facts_loaded_total Job facts read back from the store, as a restarted service does for the jobs running before it.\n")
	out.WriteString("# TYPE erainfra_cache_job_facts_loaded_total counter\n")
	fmt.Fprintf(&out, "erainfra_cache_job_facts_loaded_total %d\n", s.metrics.factsLoaded.Load())
	out.WriteString("# HELP erainfra_cache_job_facts_persist_failures_total Facts pushes answered 503 because the store refused the write.\n")
	out.WriteString("# TYPE erainfra_cache_job_facts_persist_failures_total counter\n")
	fmt.Fprintf(&out, "erainfra_cache_job_facts_persist_failures_total %d\n", s.metrics.factsPersistFailures.Load())
	out.WriteString("# HELP erainfra_cache_build_requests_total Build-system cache requests (Turborepo remote cache, Go build cache), by system and outcome.\n")
	out.WriteString("# TYPE erainfra_cache_build_requests_total counter\n")
	for i, system := range buildSystems {
		for j, outcome := range buildOutcomes {
			fmt.Fprintf(&out, "erainfra_cache_build_requests_total{system=%q,outcome=%q} %d\n",
				system, outcome, s.metrics.builds[i][j].Load())
		}
	}
	out.WriteString("# HELP erainfra_cache_stale_repository_writes_refused_total Writes refused because the repository name now belongs to a newer repository: a save (kind=save), or a removal of the newer repository's git seed (kind=purge). The writer is a job of the repository that gave the name up.\n")
	out.WriteString("# TYPE erainfra_cache_stale_repository_writes_refused_total counter\n")
	fmt.Fprintf(&out, "erainfra_cache_stale_repository_writes_refused_total{kind=\"save\"} %d\n", s.index.StaleSavesRefused())
	fmt.Fprintf(&out, "erainfra_cache_stale_repository_writes_refused_total{kind=\"purge\"} %d\n", s.metrics.stalePurgesRefused.Load())

	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	_, _ = w.Write([]byte(out.String()))
}
