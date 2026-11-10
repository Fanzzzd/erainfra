package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"testing"
	"time"
)

func (h *harness) postHint(token, body string) int {
	h.t.Helper()
	response := h.postJSON(jobHintMarker, token, body)
	_ = readAll(h.t, response)
	return response.StatusCode
}

func (h *harness) listHints(prefixes []string, nowUnix int64, sign bool) (int, []JobHint) {
	h.t.Helper()
	raw, err := json.Marshal(map[string]any{"nowUnix": nowUnix, "runnerPrefixes": prefixes})
	if err != nil {
		h.t.Fatal(err)
	}
	headers := map[string]string{"Content-Type": "application/json"}
	if sign {
		headers["X-Erainfra-Cache-Admin"] = adminSign(string(raw))
	}
	response := h.do(http.MethodPost, adminJobHintsMarker, "", bytes.NewReader(raw), headers)
	var out struct {
		Hints []JobHint `json:"hints"`
	}
	if response.StatusCode == http.StatusOK {
		decodeInto(h.t, response, &out)
	} else {
		_ = readAll(h.t, response)
	}
	return response.StatusCode, out.Hints
}

const hintBody = `{"repository":"Fanzzzd/erainfra","runID":42820231088,"runAttempt":1}`

// A runner tells the service which run it executes; the controller that owns
// the runner lists the hint, verifies it against GitHub and pushes the facts.
func TestJobHintIsListedToTheOwningControllerUntilFactsArrive(t *testing.T) {
	h := newHarness(t, nil)
	token := h.runnerToken("rc-rc-e2e-abc")
	if status := h.postHint(token, hintBody); status != http.StatusNoContent {
		t.Fatalf("hint = %d, want 204", status)
	}
	now := time.Now().Unix()
	status, hints := h.listHints([]string{"rc-rc-e2e-"}, now, true)
	if status != http.StatusOK || len(hints) != 1 || hints[0] != (JobHint{
		Runner: "rc-rc-e2e-abc", Repository: "Fanzzzd/erainfra", RunID: 42820231088, RunAttempt: 1,
	}) {
		t.Fatalf("list = %d %#v", status, hints)
	}
	if _, other := h.listHints([]string{"rc-rc-linux-js-"}, now, true); len(other) != 0 {
		t.Fatalf("another controller's prefix listed %#v", other)
	}
	h.pushRunnerFacts("rc-rc-e2e-abc", h.now().Add(time.Hour))
	if _, after := h.listHints([]string{"rc-rc-e2e-"}, now, true); len(after) != 0 {
		t.Fatalf("hint still listed after its facts arrived: %#v", after)
	}
}

func TestJobHintRequiresARunnerToken(t *testing.T) {
	h := newHarness(t, nil)
	if status := h.postHint("", hintBody); status != http.StatusUnauthorized {
		t.Fatalf("no token = %d, want 401", status)
	}
	if status := h.postHint("forged", hintBody); status != http.StatusUnauthorized {
		t.Fatalf("forged token = %d, want 401", status)
	}
}

func TestJobHintRejectsNonsense(t *testing.T) {
	h := newHarness(t, nil)
	token := h.runnerToken("rc-rc-e2e-abc")
	for _, body := range []string{
		`{"repository":"no-owner","runID":1,"runAttempt":1}`,
		`{"repository":"a/b","runID":0,"runAttempt":1}`,
		`{"repository":"a/b","runID":-4,"runAttempt":1}`,
		`not json`,
	} {
		if status := h.postHint(token, body); status != http.StatusBadRequest {
			t.Errorf("%s = %d, want 400", body, status)
		}
	}
}

// Listing is admin-only: it names repositories, and only a holder of the
// signing key may read it. A stale timestamp is refused so a captured listing
// request cannot be replayed indefinitely.
func TestJobHintListingIsSignedAndFresh(t *testing.T) {
	h := newHarness(t, nil)
	h.postHint(h.runnerToken("rc-rc-e2e-abc"), hintBody)
	if status, _ := h.listHints([]string{"rc-"}, time.Now().Unix(), false); status != http.StatusUnauthorized {
		t.Fatalf("unsigned list = %d, want 401", status)
	}
	if status, _ := h.listHints([]string{"rc-"}, time.Now().Add(-10*time.Minute).Unix(), true); status != http.StatusUnauthorized {
		t.Fatalf("stale list = %d, want 401", status)
	}
}

// A runner that already has facts gains nothing from a hint, so none is kept.
func TestJobHintForARunnerWithFactsIsIgnored(t *testing.T) {
	h := newHarness(t, nil)
	h.pushRunnerFacts("rc-rc-e2e-abc", h.now().Add(time.Hour))
	h.postHint(h.runnerToken("rc-rc-e2e-abc"), hintBody)
	if _, hints := h.listHints([]string{"rc-"}, time.Now().Unix(), true); len(hints) != 0 {
		t.Fatalf("listed %#v for a runner that has facts", hints)
	}
}
