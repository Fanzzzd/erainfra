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

	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	_, _ = w.Write([]byte(out.String()))
}
