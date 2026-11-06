package cli

import (
	"strings"
	"testing"
)

const testRunJSON = `{
  "attemptId": "j57abc",
  "repository": "acme/web",
  "branch": "main",
  "job": "unit",
  "workflowRunId": 42,
  "commit": "` + "0123456789abcdef0123456789abcdef01234567" + `",
  "recordedAt": "2026-11-05T11:00:00.000Z",
  "profile": "erainfra-4vcpu-ubuntu-2404",
  "runner": "runner-1",
  "result": "failed",
  "files": 2,
  "truncated": false,
  "totals": {"tests": 120, "passed": 115, "failed": 2, "errored": 0, "skipped": 2, "flaky": 1, "durationMs": 41200},
  "failures": [
    {"id": "pkg::TestRace", "suite": "pkg", "name": "TestRace", "file": null, "status": "failed",
     "durationMs": 1200, "message": "lost update", "retries": 0},
    {"id": "evil", "suite": null, "name": "evil\u001b]0;pwned\u0007name", "file": null, "status": "failed",
     "durationMs": 5, "message": null, "retries": 0}
  ]
}`

func TestTestsListSendsFiltersAndRendersRunsWithFailures(t *testing.T) {
	h := newHarness(t).loggedIn()
	h.api.on("GET /api/v1/tests", 200, `{"runs":[`+testRunJSON+`]}`)
	h.expect(ExitOK, "tests", "list", "--repo", "acme/web", "--since", "7d", "--limit", "5", "--failed")
	query := h.api.requests[0].URL.Query()
	for key, want := range map[string]string{"repo": "acme/web", "since": "7d", "limit": "5", "failed": "true"} {
		if query.Get(key) != want {
			t.Errorf("query %s = %q, want %q", key, query.Get(key), want)
		}
	}
	out := h.stdout.String()
	for _, want := range []string{"j57abc", "acme/web", "unit", "120", "41s", "1h ago", "pkg › TestRace", "1s"} {
		if !strings.Contains(out, want) {
			t.Errorf("table lacks %q:\n%s", want, out)
		}
	}
	if strings.ContainsAny(out, "\x1b\x07") {
		t.Errorf("a control character from a test name reached the terminal: %q", out)
	}

	h.expect(ExitOK, "tests", "list", "--json")
	if !strings.Contains(h.stdout.String(), `"attemptId": "j57abc"`) ||
		!strings.Contains(h.stdout.String(), `\u001b`) {
		t.Errorf("json should pass the body through as JSON text, got:\n%s", h.stdout.String())
	}
	if h.api.requests[1].URL.Query().Has("failed") {
		t.Error("--failed was not given, so the filter must not be sent")
	}
}

func TestTestsFlakyRendersEvidence(t *testing.T) {
	h := newHarness(t).loggedIn()
	h.api.on("GET /api/v1/tests/flaky", 200, `{"flakyTests":[
	  {"repository":"acme/web","id":"pkg::TestRace","suite":"pkg","name":"TestRace","file":null,
	   "firstSeenAt":"2026-11-01T00:00:00.000Z","lastSeenAt":"2026-11-05T10:00:00.000Z","occurrences":3,
	   "evidence":"rerun","branch":"main","commit":null,"message":"lost update","attemptIds":["a","b","c"]},
	  {"repository":"acme/api","id":"x::y","suite":"x","name":"y","file":null,
	   "firstSeenAt":"2026-11-05T11:59:00.000Z","lastSeenAt":"2026-11-05T11:59:00.000Z","occurrences":1,
	   "evidence":"retried","branch":null,"commit":null,"message":null,"attemptIds":["d"]}]}`)
	h.expect(ExitOK, "tests", "flaky", "--repo", "acme/web")
	want := "" +
		"REPO      TEST            SEEN  EVIDENCE             BRANCH  LAST SEEN\n" +
		"acme/web  pkg › TestRace  3     failed, then passed  main    2h ago\n" +
		"acme/api  x › y           1     retried into a pass  -       1m ago\n"
	if h.stdout.String() != want {
		t.Errorf("table:\n%s\nwant:\n%s", h.stdout.String(), want)
	}
	if got := h.api.requests[0].URL.Query().Get("repo"); got != "acme/web" {
		t.Errorf("repo = %q", got)
	}

	h.api.on("GET /api/v1/tests/flaky", 200, `{"flakyTests":[]}`)
	h.expect(ExitOK, "tests", "flaky")
	if h.stdout.Len() != 0 || h.stderr.String() != "No flaky tests match.\n" {
		t.Errorf("stdout = %q stderr = %q", h.stdout.String(), h.stderr.String())
	}
	h.expect(ExitUsage, "tests", "flaky", "--limit", "0")
	h.expect(ExitUsage, "tests", "flaky", "--failed")
}
