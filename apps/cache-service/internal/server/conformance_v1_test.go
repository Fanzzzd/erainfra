package server

import (
	"bytes"
	"net/http"
	"strings"
	"testing"

	"github.com/Fanzzzd/erainfra/apps/cache-service/cachetoken"
)

// Legacy v1 conformance. Keys, versions and JSON bodies below are copied out of
// docs/research/actions-cache-protocol-capture.md verbatim; where a payload is
// scaled down from the captured size it says so and cites the line it stands
// for.

const (
	// The version @actions/cache computed for the A-series runs (capture L001).
	versionA = "b34e6f1cc07875b8b978f21e92cbe8337fea885819e74e1d75a2c78c7a523960"
	// setup-node's key and version for EraInfra's own pnpm store (capture
	// L019-L020). This is the key ADR 0007 rule 2 names as the poisoning
	// target.
	keySetupNode     = "node-cache-macOS-arm64-pnpm-2f99318bf4e73abd2b85871b240918321ce3d4cc13f099bec963093faf7a4154"
	versionSetupNode = "13b0cbcf39f1eacfbd22d7a93564786f34bf3f11397a4a1aa82ec6753d628f31"
	// BuildKit's version for the D-series runs (capture L051).
	versionBuildKit = "693bb7016429d80366022f036f84856888c9f13e00145f5f6f4dce303a38d6f2"
)

// L001: a v1 miss is 204 with an empty body. It is never a 404 — that costs
// "::warning::Failed to restore: Cache service responded with 404" and a lost
// cache (L121) — and never a 500 (L122).
func TestV1MissIs204WithNoBody(t *testing.T) {
	h := newHarness(t, nil)
	token := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")

	response := h.do(http.MethodGet,
		v1Path("cache")+"?keys=key-A1&version="+versionA, token, nil, nil)
	body := readAll(t, response)

	if response.StatusCode != http.StatusNoContent {
		t.Fatalf("status = %d, want 204 (a miss is never a 404 or a 500)", response.StatusCode)
	}
	if len(body) != 0 {
		t.Fatalf("body = %q, want empty", body)
	}
}

// L001-L006: the whole A1 round trip, with the captured 8,010,521-byte payload
// at its real size so the multipart path is the one under test.
func TestV1RoundTripFollowsTheA1Capture(t *testing.T) {
	h := newHarness(t, nil)
	token := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")
	body := payload(8010521)

	h.saveV1(token, "key-A1", versionA, body, wholeBody(body))

	response := h.do(http.MethodGet, v1Path("cache")+"?keys=key-A1&version="+versionA, token, nil, nil)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("restore = %d %s", response.StatusCode, readAll(t, response))
	}
	var hit v1RestoreResponse
	decodeInto(t, response, &hit)
	if hit.CacheKey != "key-A1" {
		t.Errorf("cacheKey = %q, want key-A1", hit.CacheKey)
	}
	if hit.Scope != "refs/heads/main" {
		t.Errorf("scope = %q, want the ref the entry belongs to", hit.Scope)
	}

	// L006: the archive is fetched with a plain GET and no Range header.
	download := h.getURL(hit.ArchiveLocation)
	got := readAll(t, download)
	if download.StatusCode != http.StatusOK {
		t.Fatalf("download = %d", download.StatusCode)
	}
	if !bytes.Equal(got, body) {
		t.Fatalf("downloaded %d bytes, want %d", len(got), len(body))
	}
}

// L020-L028: @actions/cache uploads in 32 MiB chunks, up to four at a time and
// out of order — L021-L027 delivers the final short chunk fifth of seven. The
// ordering and the short-chunk position are replayed exactly; the chunk size is
// scaled from 33,554,432 bytes to 1 MiB so this stays a unit test rather than a
// 194 MiB one.
func TestV1AcceptsChunksOutOfOrder(t *testing.T) {
	h := newHarness(t, nil)
	token := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")

	const full = 1 << 20
	const short = 76900
	body := payload(6*full + short)
	// The captured delivery order: four full chunks, then the tail, then the
	// two full chunks that sit before it in the file.
	chunks := []chunk{
		{start: 0, length: full},
		{start: 1 * full, length: full},
		{start: 2 * full, length: full},
		{start: 3 * full, length: full},
		{start: 6 * full, length: short},
		{start: 4 * full, length: full},
		{start: 5 * full, length: full},
	}
	h.saveV1(token, keySetupNode, versionSetupNode, body, chunks)

	response := h.do(http.MethodGet,
		v1Path("cache")+"?keys="+keySetupNode+"&version="+versionSetupNode, token, nil, nil)
	var hit v1RestoreResponse
	decodeInto(t, response, &hit)
	got := readAll(t, h.getURL(hit.ArchiveLocation))
	if !bytes.Equal(got, body) {
		t.Fatalf("out-of-order chunks reassembled wrong: got %d bytes, want %d", len(got), len(body))
	}
}

// L068-L072: v1 `keys` is a prefix match and BuildKit depends on it. It writes
// its index entry as index-D1-1-f921bd05#1 and reads it back as the bare
// index-D1-1-f921bd05. An exact-match-only service makes every buildx cache
// import a silent miss with no error anywhere.
func TestV1KeysIsAPrefixMatch(t *testing.T) {
	h := newHarness(t, nil)
	token := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")
	body := payload(2302)

	h.saveV1(token, "index-D1-1-f921bd05#1", versionBuildKit, body, wholeBody(body))

	response := h.do(http.MethodGet,
		v1Path("cache")+"?keys=index-D1-1-f921bd05&version="+versionBuildKit, token, nil, nil)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("prefix restore = %d, want a hit", response.StatusCode)
	}
	var hit v1RestoreResponse
	decodeInto(t, response, &hit)
	if hit.CacheKey != "index-D1-1-f921bd05#1" {
		t.Fatalf("cacheKey = %q, want the full key the entry was written under", hit.CacheKey)
	}
}

// Restore keys arrive as one comma-separated parameter, primary key first.
func TestV1TriesEveryRestoreKeyInOrder(t *testing.T) {
	h := newHarness(t, nil)
	token := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")
	body := payload(64)

	h.saveV1(token, "node-cache-linux-pnpm-old", versionSetupNode, body, wholeBody(body))

	response := h.do(http.MethodGet,
		v1Path("cache")+"?keys=node-cache-linux-pnpm-exact,node-cache-linux-pnpm-&version="+versionSetupNode,
		token, nil, nil)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("restore = %d, want the second key to prefix-match", response.StatusCode)
	}
	var hit v1RestoreResponse
	decodeInto(t, response, &hit)
	if hit.CacheKey != "node-cache-linux-pnpm-old" {
		t.Fatalf("cacheKey = %q", hit.CacheKey)
	}
}

// An exact match on a later key beats a prefix match on an earlier one, and a
// more specific key beats a nearer scope. The capture does not establish this
// (ADR 0007 lists multi-entry restore_keys as unmeasured); it is chosen here so
// that a stale prefix match on the current branch cannot shadow the exact
// lockfile hash the job asked for.
func TestV1ExactMatchWinsOverAPrefixMatchOnACloserScope(t *testing.T) {
	h := newHarness(t, nil)
	main := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")
	feature := h.token(cachetoken.JobFacts{
		Repository: "Fanzzzd/erainfra", Event: "push", Ref: "refs/heads/feature-x",
		BaseRef: "refs/heads/main", DefaultBranch: "refs/heads/main",
	})

	exact := payload(32)
	stale := payload(64)
	h.saveV1(main, "pnpm-lock-abc", versionSetupNode, exact, wholeBody(exact))
	h.saveV1(feature, "pnpm-lock-zzz", versionSetupNode, stale, wholeBody(stale))

	response := h.do(http.MethodGet,
		v1Path("cache")+"?keys=pnpm-lock-abc,pnpm-lock-&version="+versionSetupNode, feature, nil, nil)
	var hit v1RestoreResponse
	decodeInto(t, response, &hit)
	if hit.CacheKey != "pnpm-lock-abc" {
		t.Fatalf("cacheKey = %q, want the exact match on the default branch", hit.CacheKey)
	}
}

// L020 and L053, verbatim. cacheSize is sent by @actions/cache and omitted by
// BuildKit, and both have to reserve.
func TestV1ReserveAcceptsTheCapturedBodiesWithAndWithoutCacheSize(t *testing.T) {
	h := newHarness(t, nil)
	token := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")

	for name, body := range map[string]string{
		"L020 setup-node, with cacheSize": `{"key":"node-cache-macOS-arm64-pnpm-2f99318bf4e73abd2b85871b240918321ce3d4cc13f099bec963093faf7a4154","version":"13b0cbcf39f1eacfbd22d7a93564786f34bf3f11397a4a1aa82ec6753d628f31","cacheSize":203848100}`,
		"L053 BuildKit, no cacheSize":     `{"key":"buildkit-blob-1-sha256:0af15d9df66c1946af0aa6d95f6b501492e77a917f261a06d7986ecfe7a4895e","version":"693bb7016429d80366022f036f84856888c9f13e00145f5f6f4dce303a38d6f2"}`,
	} {
		response := h.postJSON(v1Path("caches"), token, body)
		var reserved struct {
			CacheID int64 `json:"cacheId"`
		}
		if response.StatusCode != http.StatusCreated {
			t.Fatalf("%s: status = %d", name, response.StatusCode)
		}
		decodeInto(t, response, &reserved)
		if reserved.CacheID <= 0 {
			t.Fatalf("%s: cacheId = %d, want a positive number", name, reserved.CacheID)
		}
	}
}

// A cache entry is immutable, as GitHub's is. The second reserve for a key that
// already exists in this ref and version is refused rather than allowed to
// replace bytes an earlier job has already restored.
func TestV1ReserveRefusesAnExistingEntry(t *testing.T) {
	h := newHarness(t, nil)
	token := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")
	body := payload(128)
	h.saveV1(token, "key-A1", versionA, body, wholeBody(body))

	response := h.postJSON(v1Path("caches"), token,
		jsonBody(map[string]any{"key": "key-A1", "version": versionA}))
	defer response.Body.Close()
	if response.StatusCode != http.StatusConflict {
		t.Fatalf("second reserve = %d, want 409", response.StatusCode)
	}
}

// A commit whose size disagrees with what arrived would publish a truncated
// archive that every later job restores and fails to unpack.
func TestV1CommitRefusesASizeMismatch(t *testing.T) {
	h := newHarness(t, nil)
	token := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")

	reserve := h.postJSON(v1Path("caches"), token,
		jsonBody(map[string]any{"key": "key-A1", "version": versionA}))
	var reserved struct {
		CacheID int64 `json:"cacheId"`
	}
	decodeInto(t, reserve, &reserved)

	body := payload(100)
	patch := h.do(http.MethodPatch, v1Path("caches/")+itoa(reserved.CacheID), token,
		bytes.NewReader(body), map[string]string{"Content-Range": "bytes 0-99/*"})
	patch.Body.Close()

	commit := h.postJSON(v1Path("caches/")+itoa(reserved.CacheID), token, `{"size":200}`)
	defer commit.Body.Close()
	if commit.StatusCode != http.StatusBadRequest {
		t.Fatalf("commit = %d, want 400", commit.StatusCode)
	}
}

// A chunk that does not deliver what its Content-Range promised is a lost
// chunk, and committing it would be a corrupt entry.
func TestV1UploadRefusesAShortChunk(t *testing.T) {
	h := newHarness(t, nil)
	token := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")

	reserve := h.postJSON(v1Path("caches"), token,
		jsonBody(map[string]any{"key": "key-A1", "version": versionA}))
	var reserved struct {
		CacheID int64 `json:"cacheId"`
	}
	decodeInto(t, reserve, &reserved)

	response := h.do(http.MethodPatch, v1Path("caches/")+itoa(reserved.CacheID), token,
		strings.NewReader("short"), map[string]string{"Content-Range": "bytes 0-99/*"})
	defer response.Body.Close()
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("PATCH = %d, want 400", response.StatusCode)
	}
}

// The fault matrix in the capture is about what a client does with a wrong
// answer; the requirement it produces is that this service never gives one. A
// store that answers 404 or 500 has to come out as the protocol's own miss,
// because the alternatives are measured: a v1 404 costs a warning and a lost
// cache (L121) and a v1 500 is not retried but warns too (L122).
func TestV1StoreFaultsDegradeToAMiss(t *testing.T) {
	for name, status := range map[string]int{"404 from the store": 404, "500 from the store": 500} {
		t.Run(name, func(t *testing.T) {
			h := newHarness(t, nil)
			token := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")
			h.store.SetFail(func(method, key string, query map[string][]string) int {
				if method == http.MethodGet {
					return status
				}
				return 0
			})

			response := h.do(http.MethodGet,
				v1Path("cache")+"?keys=key-A1&version="+versionA, token, nil, nil)
			body := readAll(t, response)
			if response.StatusCode != http.StatusNoContent || len(body) != 0 {
				t.Fatalf("status = %d body = %q, want a 204 miss", response.StatusCode, body)
			}
		})
	}
}
