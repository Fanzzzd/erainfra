package server

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"testing"
	"time"
)

// adminSign computes the controller's push signature the way the service checks
// it: an HMAC of the exact body under the shared signing key.
func adminSign(body string) string {
	mac := hmac.New(sha256.New, signingKey)
	mac.Write([]byte(body))
	return hex.EncodeToString(mac.Sum(nil))
}

func (h *harness) pushFacts(body, signature string) *http.Response {
	headers := map[string]string{"Content-Type": "application/json"}
	if signature != "" {
		headers["X-Erainfra-Cache-Admin"] = signature
	}
	return h.do(http.MethodPost, adminFactsMarker, "", bytes.NewReader([]byte(body)), headers)
}

// runnerToken mints a runner token directly, bypassing the harness's fact
// registration, so a test can present a valid identity for which no facts exist.
func (h *harness) runnerToken(runner string) string {
	h.t.Helper()
	token, _, err := h.issuer.IssueRunner(runner)
	if err != nil {
		h.t.Fatal(err)
	}
	return token
}

// A runner whose facts were never pushed is unauthorized, not a silent miss: the
// service cannot know its repository, so it must not serve any repository's cache.
func TestUnknownRunnerIsUnauthorized(t *testing.T) {
	h := newHarness(t, nil)
	token := h.runnerToken("rc-orphan")

	response := h.postJSON(v2Path("GetCacheEntryDownloadURL"), token,
		jsonBody(map[string]any{"key": "k", "version": "v"}))
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unknown runner = %d, want 401", response.StatusCode)
	}
}

// The facts push is authenticated by the shared signing key, not a job token: a
// missing or forged signature is refused, and only a correct one is stored.
func TestFactsPushRequiresTheSigningKey(t *testing.T) {
	h := newHarness(t, nil)
	body := jsonBody(map[string]any{
		"runner": "rc-linux-js-a", "repository": "Fanzzzd/erainfra",
		"event": "push", "ref": "refs/heads/main", "expiresUnix": h.now().Add(time.Hour).Unix(),
	})

	for name, sig := range map[string]string{
		"no signature":     "",
		"forged signature": adminSign(body + "tampered"),
	} {
		response := h.pushFacts(body, sig)
		_ = response.Body.Close()
		if response.StatusCode != http.StatusUnauthorized {
			t.Errorf("%s: push = %d, want 401", name, response.StatusCode)
		}
	}

	accepted := h.pushFacts(body, adminSign(body))
	_ = accepted.Body.Close()
	if accepted.StatusCode != http.StatusNoContent {
		t.Fatalf("signed push = %d, want 204", accepted.StatusCode)
	}
}

func TestFactsPushRejectsUnusableInput(t *testing.T) {
	h := newHarness(t, nil)
	expires := h.now().Add(time.Hour).Unix()

	for name, body := range map[string]string{
		"no repository": jsonBody(map[string]any{
			"runner": "rc-a", "event": "push", "ref": "refs/heads/main", "expiresUnix": expires}),
		"no ref": jsonBody(map[string]any{
			"runner": "rc-a", "repository": "Fanzzzd/erainfra", "event": "push", "expiresUnix": expires}),
		"invalid runner": jsonBody(map[string]any{
			"runner": "../escape", "repository": "Fanzzzd/erainfra", "ref": "refs/heads/main", "expiresUnix": expires}),
		"no expiry": jsonBody(map[string]any{
			"runner": "rc-a", "repository": "Fanzzzd/erainfra", "event": "push", "ref": "refs/heads/main"}),
	} {
		response := h.pushFacts(body, adminSign(body))
		_ = response.Body.Close()
		if response.StatusCode != http.StatusBadRequest {
			t.Errorf("%s: push = %d, want 400", name, response.StatusCode)
		}
	}
}

func TestFactsPushRejectsWrongMethod(t *testing.T) {
	h := newHarness(t, nil)
	response := h.do(http.MethodGet, adminFactsMarker, "", nil, nil)
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("GET push = %d, want 405", response.StatusCode)
	}
}

// End to end over the real endpoint: facts pushed for a runner, then that
// runner's token both writes and restores its repository's cache — the same
// scope the pushed facts describe.
func TestScopedAccessAfterEndpointPush(t *testing.T) {
	h := newHarness(t, nil)
	body := jsonBody(map[string]any{
		"runner": "rc-linux-js-a", "repository": "Fanzzzd/erainfra",
		"event": "push", "ref": "refs/heads/main", "defaultBranch": "refs/heads/main",
		"expiresUnix": h.now().Add(time.Hour).Unix(),
	})
	pushed := h.pushFacts(body, adminSign(body))
	_ = pushed.Body.Close()
	if pushed.StatusCode != http.StatusNoContent {
		t.Fatalf("push = %d, want 204", pushed.StatusCode)
	}

	token := h.runnerToken("rc-linux-js-a")
	want := payload(4096)
	h.saveV1(token, "build-cache", "v1", want, wholeBody(want))
	got := h.restoreV1(token, "build-cache", "v1")
	if !bytes.Equal(got, want) {
		t.Fatalf("restored %d bytes, want %d", len(got), len(want))
	}
}
