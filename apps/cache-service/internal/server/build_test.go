package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Fanzzzd/erainfra/apps/cache-service/cachetoken"
	"github.com/Fanzzzd/erainfra/apps/cache-service/internal/adminapi"
	"github.com/Fanzzzd/erainfra/apps/cache-service/internal/config"
)

// turboPath and goPath are where the guest proxy forwards turbo's
// /v8/artifacts/... and the GOCACHEPROG helper's /go/... requests.
func turboPath(route string) string { return buildMarker + "turbo/v8/artifacts" + route }

func goPath(actionID string) string { return buildMarker + "go/" + actionID }

// goID is a deterministic action or output ID for a label.
func goID(label string) string {
	sum := sha256.Sum256([]byte(label))
	return hex.EncodeToString(sum[:])
}

func (h *harness) turboPut(token, hash string, body []byte, headers map[string]string) *http.Response {
	h.t.Helper()
	all := map[string]string{"Content-Type": "application/octet-stream"}
	for name, value := range headers {
		all[name] = value
	}
	return h.do(http.MethodPut, turboPath("/"+hash)+"?slug=team", token, bytes.NewReader(body), all)
}

func (h *harness) turboGet(token, hash string, headers map[string]string) (int, []byte, http.Header) {
	h.t.Helper()
	response := h.do(http.MethodGet, turboPath("/"+hash)+"?slug=team", token, nil, headers)
	body := readAll(h.t, response)
	return response.StatusCode, body, response.Header
}

func (h *harness) goPut(token, actionID string, body []byte, headers map[string]string) int {
	h.t.Helper()
	all := map[string]string{GoOutputIDHeader: outputIDOf(body)}
	for name, value := range headers {
		all[name] = value
	}
	response := h.do(http.MethodPut, goPath(actionID), token, bytes.NewReader(body), all)
	_ = readAll(h.t, response)
	return response.StatusCode
}

func (h *harness) goGet(token, actionID string, headers map[string]string) (int, []byte, string) {
	h.t.Helper()
	response := h.do(http.MethodGet, goPath(actionID), token, nil, headers)
	body := readAll(h.t, response)
	return response.StatusCode, body, response.Header.Get(GoOutputIDHeader)
}

// outputIDOf is what cmd/go sends as the output ID: the SHA-256 of the body.
func outputIDOf(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

// The spec is walked operation by operation, so a server that drops one, or a
// spec that grows one this service has never answered, fails here. Every
// answer must be a status the spec documents for that operation, and the
// bodies must have the shapes the spec's schemas give them.
func TestTurboConformsToTheRemoteCacheSpec(t *testing.T) {
	raw, err := os.ReadFile("testdata/turborepo-remote-cache-spec.json")
	if err != nil {
		t.Fatal(err)
	}
	var spec struct {
		Paths map[string]map[string]json.RawMessage `json:"paths"`
	}
	if err := json.Unmarshal(raw, &spec); err != nil {
		t.Fatal(err)
	}

	h := newHarness(t, nil)
	token := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")
	const hash = "a6e66d849fb597c4"
	artifact := payload(4096)
	documented := func(operation json.RawMessage) map[int]bool {
		var parsed struct {
			Responses map[string]json.RawMessage `json:"responses"`
		}
		if err := json.Unmarshal(operation, &parsed); err != nil {
			t.Fatal(err)
		}
		codes := map[int]bool{}
		for code := range parsed.Responses {
			number, err := strconv.Atoi(code)
			if err != nil {
				t.Fatalf("spec response code %q", code)
			}
			codes[number] = true
		}
		return codes
	}

	// The upload runs first so the reads below have something to find.
	checks := map[string]func(json.RawMessage){
		"uploadArtifact": func(operation json.RawMessage) {
			response := h.turboPut(token, hash, artifact, map[string]string{"x-artifact-duration": "218"})
			assertDocumented(t, "uploadArtifact", documented(operation), response.StatusCode)
			var body struct {
				URLs []string `json:"urls"`
			}
			decodeInto(t, response, &body)
			if body.URLs == nil {
				t.Error("uploadArtifact: the response has no urls array (ArtifactUploadResponse requires it)")
			}
		},
		"artifactExists": func(operation json.RawMessage) {
			response := h.do(http.MethodHead, turboPath("/"+hash)+"?slug=team", token, nil, nil)
			_ = readAll(t, response)
			assertDocumented(t, "artifactExists", documented(operation), response.StatusCode)
			if response.StatusCode != http.StatusOK || response.ContentLength != int64(len(artifact)) {
				t.Errorf("artifactExists = %d with Content-Length %d, want 200 and %d",
					response.StatusCode, response.ContentLength, len(artifact))
			}
			missing := h.do(http.MethodHead, turboPath("/0123abcd")+"?slug=team", token, nil, nil)
			_ = readAll(t, missing)
			if missing.StatusCode != http.StatusNotFound {
				t.Errorf("artifactExists for an absent hash = %d, want 404", missing.StatusCode)
			}
		},
		"downloadArtifact": func(operation json.RawMessage) {
			status, body, headers := h.turboGet(token, hash, nil)
			assertDocumented(t, "downloadArtifact", documented(operation), status)
			if status != http.StatusOK || !bytes.Equal(body, artifact) {
				t.Errorf("downloadArtifact = %d with %d bytes, want 200 and the uploaded %d", status, len(body), len(artifact))
			}
			if headers.Get("Content-Type") != "application/octet-stream" || headers.Get("x-artifact-duration") != "218" {
				t.Errorf("downloadArtifact headers = %v", headers)
			}
		},
		"getArtifactStatus": func(operation json.RawMessage) {
			response := h.do(http.MethodGet, turboPath("/status")+"?slug=team", token, nil, nil)
			assertDocumented(t, "getArtifactStatus", documented(operation), response.StatusCode)
			var body struct {
				Status string `json:"status"`
			}
			decodeInto(t, response, &body)
			if body.Status != "enabled" {
				t.Errorf("getArtifactStatus = %q, want enabled", body.Status)
			}
		},
		"recordCacheEvents": func(operation json.RawMessage) {
			response := h.postJSON(turboPath("/events")+"?slug=team", token,
				`[{"sessionId":"6f1b3e4e-1111-4c4c-9d9d-123456789abc","source":"REMOTE","event":"HIT","hash":"`+hash+`","duration":218}]`)
			_ = readAll(t, response)
			assertDocumented(t, "recordCacheEvents", documented(operation), response.StatusCode)
		},
		"queryArtifacts": func(operation json.RawMessage) {
			response := h.postJSON(turboPath("")+"?slug=team", token, `{"hashes":["`+hash+`","0123abcd","not-hex"]}`)
			assertDocumented(t, "queryArtifacts", documented(operation), response.StatusCode)
			var body map[string]json.RawMessage
			decodeInto(t, response, &body)
			var info struct {
				Size           *int64 `json:"size"`
				TaskDurationMs *int64 `json:"taskDurationMs"`
			}
			if err := json.Unmarshal(body[hash], &info); err != nil || info.Size == nil || *info.Size != int64(len(artifact)) ||
				info.TaskDurationMs == nil || *info.TaskDurationMs != 218 {
				t.Errorf("queryArtifacts[%s] = %s, want size %d and taskDurationMs 218", hash, body[hash], len(artifact))
			}
			if string(body["0123abcd"]) != "null" {
				t.Errorf("queryArtifacts for an absent hash = %s, want null", body["0123abcd"])
			}
			var failed struct {
				Error struct {
					Message string `json:"message"`
				} `json:"error"`
			}
			if err := json.Unmarshal(body["not-hex"], &failed); err != nil || failed.Error.Message == "" {
				t.Errorf("queryArtifacts for a malformed hash = %s, want an ArtifactError", body["not-hex"])
			}
		},
	}

	order := []string{"uploadArtifact", "artifactExists", "downloadArtifact", "getArtifactStatus", "recordCacheEvents", "queryArtifacts"}
	operations := map[string]json.RawMessage{}
	for path, methods := range spec.Paths {
		for method, operation := range methods {
			if method == "parameters" {
				continue
			}
			var named struct {
				OperationID string `json:"operationId"`
			}
			if err := json.Unmarshal(operation, &named); err != nil {
				t.Fatal(err)
			}
			if _, known := checks[named.OperationID]; !known {
				t.Errorf("the spec's %s %s (%s) has no conformance check", strings.ToUpper(method), path, named.OperationID)
			}
			operations[named.OperationID] = operation
		}
	}
	for _, id := range order {
		operation, inSpec := operations[id]
		if !inSpec {
			t.Errorf("%s is checked here but is not in the spec", id)
			continue
		}
		checks[id](operation)
	}
}

func assertDocumented(t *testing.T, operation string, codes map[int]bool, status int) {
	t.Helper()
	if !codes[status] {
		documented := make([]int, 0, len(codes))
		for code := range codes {
			documented = append(documented, code)
		}
		sort.Ints(documented)
		t.Errorf("%s answered %d, which the spec does not document (it documents %v)", operation, status, documented)
	}
}

// Everything turbo stores beside the bytes comes back with them, and a second
// upload of the same hash leaves the first in place, as GitHub's entries are
// immutable.
func TestTurboArtifactKeepsItsMetadataAndIsImmutable(t *testing.T) {
	h := newHarness(t, nil)
	token := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")
	first := payload(1500)
	response := h.turboPut(token, "ABCDEF0123", first, map[string]string{
		"x-artifact-duration":   "4321",
		"x-artifact-tag":        "c2lnbmF0dXJl",
		"x-artifact-sha":        "3f2a9c1",
		"x-artifact-dirty-hash": "d1r7y",
	})
	if response.StatusCode != http.StatusAccepted {
		t.Fatalf("upload = %d %s", response.StatusCode, readAll(t, response))
	}
	_ = readAll(t, response)

	second := h.turboPut(token, "abcdef0123", []byte("a different body"), nil)
	if second.StatusCode != http.StatusAccepted {
		t.Fatalf("second upload = %d, want 202 for an entry that already exists", second.StatusCode)
	}
	_ = readAll(t, second)

	status, body, headers := h.turboGet(token, "abcdef0123", nil)
	if status != http.StatusOK || !bytes.Equal(body, first) {
		t.Fatalf("download = %d with %q, want the first upload", status, body)
	}
	for name, want := range map[string]string{
		"x-artifact-duration": "4321", "x-artifact-tag": "c2lnbmF0dXJl",
		"x-artifact-sha": "3f2a9c1", "x-artifact-dirty-hash": "d1r7y",
		"Content-Length": "1500",
	} {
		if got := headers.Get(name); got != want {
			t.Errorf("%s = %q, want %q", name, got, want)
		}
	}
}

func TestTurboRefusesMalformedUploads(t *testing.T) {
	h := newHarness(t, func(cfg *config.Config) { cfg.MaxEntryBytes = 1000 })
	token := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")
	cases := []struct {
		name    string
		hash    string
		body    io.Reader
		headers map[string]string
		want    int
	}{
		{"not hex", "xyz", bytes.NewReader([]byte("x")), nil, http.StatusBadRequest},
		{"over the entry ceiling", "aa", bytes.NewReader(payload(1001)), nil, http.StatusRequestEntityTooLarge},
		// io.MultiReader hides the length, so the client sends it chunked.
		{"no Content-Length", "bb", io.MultiReader(bytes.NewReader([]byte("x"))), nil, http.StatusLengthRequired},
		{"duration not a number", "cc", bytes.NewReader([]byte("x")), map[string]string{"x-artifact-duration": "soon"}, http.StatusBadRequest},
		{"tag over the spec's 600", "dd", bytes.NewReader([]byte("x")), map[string]string{"x-artifact-tag": strings.Repeat("A", 601)}, http.StatusBadRequest},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			response := h.do(http.MethodPut, turboPath("/"+tc.hash), token, tc.body, tc.headers)
			body := readAll(t, response)
			if response.StatusCode != tc.want {
				t.Fatalf("upload = %d %s, want %d", response.StatusCode, body, tc.want)
			}
		})
	}
	if status, _, _ := h.turboGet(token, "aa", nil); status != http.StatusNotFound {
		t.Fatalf("an oversized upload left an entry: %d", status)
	}
}

func TestGoBuildCacheRoundTrip(t *testing.T) {
	h := newHarness(t, nil)
	token := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")
	for name, body := range map[string][]byte{"object file": payload(70000), "empty output": {}} {
		t.Run(name, func(t *testing.T) {
			action := goID(name)
			if status, _, _ := h.goGet(token, action, nil); status != http.StatusNotFound {
				t.Fatalf("get before put = %d, want 404", status)
			}
			if status := h.goPut(token, action, body, nil); status != http.StatusNoContent {
				t.Fatalf("put = %d", status)
			}
			status, got, outputID := h.goGet(token, action, nil)
			if status != http.StatusOK || !bytes.Equal(got, body) || outputID != outputIDOf(body) {
				t.Fatalf("get = %d, %d bytes, output %s; want 200, %d bytes, %s",
					status, len(got), outputID, len(body), outputIDOf(body))
			}
		})
	}
}

func TestGoBuildCacheRefusesMalformedRequests(t *testing.T) {
	h := newHarness(t, nil)
	token := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")
	if status := h.goPut(token, "short", []byte("x"), nil); status != http.StatusBadRequest {
		t.Errorf("put with a malformed action ID = %d, want 400", status)
	}
	if status := h.goPut(token, goID("a"), []byte("x"), map[string]string{GoOutputIDHeader: "nope"}); status != http.StatusBadRequest {
		t.Errorf("put with a malformed output ID = %d, want 400", status)
	}
	response := h.do(http.MethodPost, goPath(goID("a")), token, nil, nil)
	_ = readAll(t, response)
	if response.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("POST = %d, want 405", response.StatusCode)
	}
	response = h.do(http.MethodGet, goPath(goID("a")), token, nil, map[string]string{BuildArchHeader: "../amd64"})
	_ = readAll(t, response)
	if response.StatusCode != http.StatusBadRequest {
		t.Errorf("a malformed architecture = %d, want 400", response.StatusCode)
	}
}

// Repository B can never read what repository A saved, through either
// protocol, and neither can a repository whose name only differs in owner.
func TestBuildCacheIsIsolatedPerRepository(t *testing.T) {
	h := newHarness(t, nil)
	ownerA := h.pushToken("acme/web", "refs/heads/main")
	otherRepo := h.pushToken("acme/api", "refs/heads/main")
	otherOwner := h.pushToken("evil/web", "refs/heads/main")

	response := h.turboPut(ownerA, "feedface", []byte("turbo output"), nil)
	_ = readAll(t, response)
	if response.StatusCode != http.StatusAccepted {
		t.Fatalf("upload = %d", response.StatusCode)
	}
	if status := h.goPut(ownerA, goID("pkg"), []byte("go output"), nil); status != http.StatusNoContent {
		t.Fatalf("go put = %d", status)
	}

	for name, token := range map[string]string{"another repository": otherRepo, "another owner": otherOwner} {
		if status, body, _ := h.turboGet(token, "feedface", nil); status != http.StatusNotFound {
			t.Errorf("%s read repository A's turbo artifact: %d %q", name, status, body)
		}
		head := h.do(http.MethodHead, turboPath("/feedface"), token, nil, nil)
		_ = readAll(t, head)
		if head.StatusCode != http.StatusNotFound {
			t.Errorf("%s saw repository A's turbo artifact exist: %d", name, head.StatusCode)
		}
		if status, body, _ := h.goGet(token, goID("pkg"), nil); status != http.StatusNotFound {
			t.Errorf("%s read repository A's Go output: %d %q", name, status, body)
		}
		query := h.postJSON(turboPath(""), token, `{"hashes":["feedface"]}`)
		if body := readAll(t, query); !strings.Contains(string(body), `"feedface":null`) {
			t.Errorf("%s learned about repository A's artifact through a query: %s", name, body)
		}
	}
	// And the owner still can.
	if status, _, _ := h.turboGet(ownerA, "feedface", nil); status != http.StatusOK {
		t.Fatalf("the owning repository's own read = %d", status)
	}
}

// Build entries follow ADR 0007 rule 3 exactly as actions/cache entries do: a
// branch reads its own scope, its pull request's base and the default branch,
// and never a sibling branch.
func TestBuildCacheFollowsBranchScoping(t *testing.T) {
	h := newHarness(t, nil)
	main := h.pushToken("acme/web", "refs/heads/main")
	feature := h.pushToken("acme/web", "refs/heads/feature")
	sibling := h.pushToken("acme/web", "refs/heads/sibling")
	pullRequest := h.token(cachetoken.JobFacts{
		Repository: "acme/web", HeadRepository: "acme/web", Event: "pull_request",
		Ref: "refs/pull/7/merge", BaseRef: "refs/heads/release", DefaultBranch: "refs/heads/main",
	})
	release := h.pushToken("acme/web", "refs/heads/release")

	for token, hash := range map[string]string{main: "aa01", feature: "bb02", release: "cc03"} {
		response := h.turboPut(token, hash, []byte(hash), nil)
		_ = readAll(t, response)
		if response.StatusCode != http.StatusAccepted {
			t.Fatalf("upload %s = %d", hash, response.StatusCode)
		}
	}
	cases := []struct {
		reader string
		token  string
		hash   string
		want   int
	}{
		{"feature reads main", feature, "aa01", http.StatusOK},
		{"main does not read feature", main, "bb02", http.StatusNotFound},
		{"a sibling does not read feature", sibling, "bb02", http.StatusNotFound},
		{"a pull request reads its base", pullRequest, "cc03", http.StatusOK},
		{"a pull request reads the default branch", pullRequest, "aa01", http.StatusOK},
		{"a pull request does not read another branch", pullRequest, "bb02", http.StatusNotFound},
	}
	for _, tc := range cases {
		if status, _, _ := h.turboGet(tc.token, tc.hash, nil); status != tc.want {
			t.Errorf("%s: %d, want %d", tc.reader, status, tc.want)
		}
	}
}

// A fork's pull request runs code the repository does not control. It reads
// the base branch's build outputs and cannot write any, the same rule 2 that
// governs its actions/cache saves.
func TestForkPullRequestReadsButCannotWriteBuildCache(t *testing.T) {
	h := newHarness(t, nil)
	main := h.pushToken("acme/web", "refs/heads/main")
	fork := h.token(cachetoken.JobFacts{
		Repository: "acme/web", HeadRepository: "stranger/web", Event: "pull_request",
		Ref: "refs/pull/9/merge", BaseRef: "refs/heads/main", DefaultBranch: "refs/heads/main",
	})
	response := h.turboPut(main, "0a0b", []byte("trusted output"), nil)
	_ = readAll(t, response)
	if status := h.goPut(main, goID("trusted"), []byte("trusted go output"), nil); status != http.StatusNoContent {
		t.Fatalf("go put = %d", status)
	}

	if status, body, _ := h.turboGet(fork, "0a0b", nil); status != http.StatusOK || string(body) != "trusted output" {
		t.Fatalf("fork read of the base branch = %d %q", status, body)
	}
	if status, _, _ := h.goGet(fork, goID("trusted"), nil); status != http.StatusOK {
		t.Fatalf("fork Go read of the base branch = %d", status)
	}

	refused := h.turboPut(fork, "0c0d", []byte("poison"), nil)
	var body struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
		Code string `json:"code"`
	}
	decodeInto(t, refused, &body)
	if refused.StatusCode != http.StatusForbidden || body.Error.Code != "forbidden" || body.Code != "forbidden" {
		t.Fatalf("fork upload = %d %+v, want 403 forbidden in both the spec's and turbo's error shape", refused.StatusCode, body)
	}
	if status := h.goPut(fork, goID("poison"), []byte("poison"), nil); status != http.StatusForbidden {
		t.Fatalf("fork Go put = %d, want 403", status)
	}
	// Nothing landed anywhere, including the base branch the fork reads.
	if status, _, _ := h.turboGet(main, "0c0d", nil); status != http.StatusNotFound {
		t.Fatalf("the fork's refused upload is readable: %d", status)
	}
	if status, _, _ := h.goGet(main, goID("poison"), nil); status != http.StatusNotFound {
		t.Fatalf("the fork's refused Go put is readable: %d", status)
	}
}

func TestBuildCacheRequiresARunnerToken(t *testing.T) {
	h := newHarness(t, nil)
	for name, token := range map[string]string{"no token": "", "forged token": "erainfra-cache-runner-v1.e30.AAAA"} {
		for _, path := range []string{turboPath("/status"), turboPath("/abcd"), goPath(goID("x"))} {
			response := h.do(http.MethodGet, path, token, nil, nil)
			_ = readAll(t, response)
			if response.StatusCode != http.StatusUnauthorized {
				t.Errorf("%s GET %s = %d, want 401", name, path, response.StatusCode)
			}
		}
	}
}

// An arm64 job never restores an amd64 job's outputs: a turbo task's outputs
// can hold native binaries its hash does not cover.
func TestBuildCacheIsSeparatedByArchitecture(t *testing.T) {
	h := newHarness(t, nil)
	token := h.pushToken("acme/web", "refs/heads/main")
	amd64 := map[string]string{BuildArchHeader: "amd64"}
	arm64 := map[string]string{BuildArchHeader: "arm64"}
	response := h.turboPut(token, "ab12", []byte("x86 binary"), amd64)
	_ = readAll(t, response)
	if status := h.goPut(token, goID("arch"), []byte("x86 object"), amd64); status != http.StatusNoContent {
		t.Fatalf("go put = %d", status)
	}
	if status, _, _ := h.turboGet(token, "ab12", arm64); status != http.StatusNotFound {
		t.Errorf("arm64 read amd64's turbo artifact: %d", status)
	}
	if status, _, _ := h.goGet(token, goID("arch"), arm64); status != http.StatusNotFound {
		t.Errorf("arm64 read amd64's Go output: %d", status)
	}
	if status, _, _ := h.turboGet(token, "ab12", amd64); status != http.StatusOK {
		t.Errorf("amd64 read of its own artifact = %d", status)
	}
}

// Build entries are cache entries: they count against the same per-repository
// quota as actions/cache entries, compete with them in one LRU order, and are
// listed and deleted by the admin API under their key.
func TestBuildEntriesShareTheRepositoryQuotaAndLRU(t *testing.T) {
	h := newHarness(t, func(cfg *config.Config) { cfg.RepoQuotaBytes = 2500 })
	token := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")

	response := h.turboPut(token, "0001", payload(1000), nil)
	_ = readAll(t, response)
	h.advance(time.Minute)
	if status := h.goPut(token, goID("second"), payload(1000), nil); status != http.StatusNoContent {
		t.Fatalf("go put = %d", status)
	}
	h.advance(15 * time.Minute)
	// The turbo artifact is used again, so the Go entry is now the least
	// recently used.
	if status, _, _ := h.turboGet(token, "0001", nil); status != http.StatusOK {
		t.Fatalf("turbo read = %d", status)
	}
	h.advance(time.Minute)
	body := payload(1000)
	h.saveV1(token, "actions-cache-entry", "v1", body, wholeBody(body))

	h.server.retainTickOnce(context.Background())

	if status, _, _ := h.turboGet(token, "0001", nil); status != http.StatusOK {
		t.Errorf("the recently used turbo artifact was evicted: %d", status)
	}
	if status, _, _ := h.goGet(token, goID("second"), nil); status != http.StatusNotFound {
		t.Errorf("the least recently used Go entry survived the quota pass: %d", status)
	}
	if status := h.restoreStatus(token, "actions-cache-entry", "v1"); status != http.StatusOK {
		t.Errorf("the newest actions/cache entry was evicted: %d", status)
	}

	listed, err := h.adminClient().List(context.Background(), adminapi.ListQuery{Repository: "Fanzzzd/erainfra"})
	if err != nil {
		t.Fatal(err)
	}
	if listed.TotalBytes > 2500 {
		t.Fatalf("repository holds %d bytes after the quota pass, quota 2500", listed.TotalBytes)
	}
	keys := map[string]bool{}
	for _, entry := range listed.Entries {
		keys[entry.Key] = true
	}
	if !keys["turbo/0001"] || !keys["actions-cache-entry"] || keys["go/"+goID("second")] {
		t.Fatalf("admin list = %v, want the turbo artifact and the actions/cache entry", keys)
	}

	// An operator clears one build system's entries by key prefix.
	deleted, err := h.adminClient().Delete(context.Background(), adminapi.DeleteQuery{
		Repository: "Fanzzzd/erainfra", Prefix: "turbo/",
	})
	if err != nil {
		t.Fatal(err)
	}
	if deleted.DeletedCount != 1 {
		t.Fatalf("delete by the turbo/ prefix removed %d entries, want 1", deleted.DeletedCount)
	}
	if status, _, _ := h.turboGet(token, "0001", nil); status != http.StatusNotFound {
		t.Fatalf("a deleted turbo artifact is still served: %d", status)
	}
}

func TestIdleBuildEntriesAreEvicted(t *testing.T) {
	h := newHarness(t, func(cfg *config.Config) { cfg.IdleTTL = 24 * time.Hour })
	token := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")
	if status := h.goPut(token, goID("idle"), payload(10), nil); status != http.StatusNoContent {
		t.Fatalf("go put = %d", status)
	}
	// The first sweep adopts the entry; the idle clock runs from then.
	if _, err := h.server.index.Sweep(context.Background()); err != nil {
		t.Fatal(err)
	}
	h.advance(25 * time.Hour)
	report, err := h.server.index.Sweep(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if report.EvictedIdle != 1 {
		t.Fatalf("sweep = %+v, want the idle Go entry evicted", report)
	}
	token = h.pushToken("Fanzzzd/erainfra", "refs/heads/main")
	if status, _, _ := h.goGet(token, goID("idle"), nil); status != http.StatusNotFound {
		t.Fatalf("an evicted entry is still served: %d", status)
	}
}

func TestBuildCacheMetricsCountHitsMissesAndSaves(t *testing.T) {
	h := newHarness(t, nil)
	token := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")
	response := h.turboPut(token, "77", []byte("x"), nil)
	_ = readAll(t, response)
	h.turboGet(token, "77", nil)
	h.turboGet(token, "78", nil)
	h.goGet(token, goID("m"), nil)

	scrape := string(readAll(t, h.do(http.MethodGet, metricsPath, "", nil, nil)))
	for _, line := range []string{
		`erainfra_cache_build_requests_total{system="turbo",outcome="saved"} 1`,
		`erainfra_cache_build_requests_total{system="turbo",outcome="hit"} 1`,
		`erainfra_cache_build_requests_total{system="turbo",outcome="miss"} 1`,
		`erainfra_cache_build_requests_total{system="go",outcome="miss"} 1`,
		`erainfra_cache_build_requests_total{system="go",outcome="saved"} 0`,
	} {
		if !strings.Contains(scrape, line+"\n") {
			t.Errorf("metrics lack %q", line)
		}
	}
}
