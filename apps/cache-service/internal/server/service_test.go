package server

import (
	"bytes"
	"io/fs"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Fanzzzd/erainfra/apps/cache-service/internal/config"
)

func TestHealthNeedsNoToken(t *testing.T) {
	h := newHarness(t, nil)
	response := h.do(http.MethodGet, healthPath, "", nil, nil)
	body := readAll(t, response)
	if response.StatusCode != http.StatusOK || !strings.Contains(string(body), `"ok":true`) {
		t.Fatalf("health = %d %s", response.StatusCode, body)
	}
}

// BuildKit sends the whole blob in a single PATCH (capture L054) and the
// capture does not record whether it carries a Content-Range. An absent header
// therefore has to mean "all of it, from zero" rather than a rejection.
func TestV1AcceptsAPatchWithNoContentRange(t *testing.T) {
	h := newHarness(t, nil)
	token := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")
	body := payload(4195736)

	reserve := h.postJSON(v1Path("caches"), token,
		jsonBody(map[string]any{"key": "buildkit-blob-1-sha256:0af15d9d", "version": versionBuildKit}))
	var reserved struct {
		CacheID int64 `json:"cacheId"`
	}
	decodeInto(t, reserve, &reserved)

	patch := h.do(http.MethodPatch, v1Path("caches/")+itoa(reserved.CacheID), token,
		bytes.NewReader(body), nil)
	readAll(t, patch)
	if patch.StatusCode != http.StatusNoContent {
		t.Fatalf("PATCH without Content-Range = %d", patch.StatusCode)
	}

	commit := h.postJSON(v1Path("caches/")+itoa(reserved.CacheID), token,
		jsonBody(map[string]any{"size": len(body)}))
	readAll(t, commit)
	if commit.StatusCode != http.StatusNoContent {
		t.Fatalf("commit = %d", commit.StatusCode)
	}
	if got := h.restoreV1(token, "buildkit-blob-1-sha256:0af15d9d", versionBuildKit); !bytes.Equal(got, body) {
		t.Fatal("the single-PATCH upload did not round-trip")
	}
}

// The proxy download mode exists for a store the jobs cannot route to. It has
// to serve the same bytes the presigned URL would, from this service's own
// host.
func TestProxyDownloadModeServesTheEntryFromThisService(t *testing.T) {
	h := newHarness(t, func(cfg *config.Config) { cfg.DownloadMode = config.DownloadProxy })
	token := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")
	body := payload(9000)
	h.saveV1(token, "key-A1", versionA, body, wholeBody(body))

	response := h.do(http.MethodGet, v1Path("cache")+"?keys=key-A1&version="+versionA, token, nil, nil)
	var hit v1RestoreResponse
	decodeInto(t, response, &hit)

	parsed, err := url.Parse(hit.ArchiveLocation)
	if err != nil {
		t.Fatal(err)
	}
	service, _ := url.Parse(h.http.URL)
	if parsed.Host != service.Host {
		t.Fatalf("archiveLocation host = %q, want this service", parsed.Host)
	}
	if strings.Contains(hit.ArchiveLocation, h.store.Secret) {
		t.Fatal("the proxied download URL leaked the store secret")
	}
	if got := readAll(t, h.getURL(hit.ArchiveLocation)); !bytes.Equal(got, body) {
		t.Fatal("the proxied download served different bytes")
	}
}

// A download URL expires. The capture is silent on how long a client holds one,
// so the lifetime is a service-side decision and is enforced rather than
// advertised.
func TestProxyDownloadURLExpires(t *testing.T) {
	h := newHarness(t, func(cfg *config.Config) {
		cfg.DownloadMode = config.DownloadProxy
		cfg.DownloadTTL = time.Minute
	})
	token := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")
	body := payload(64)
	h.saveV1(token, "key-A1", versionA, body, wholeBody(body))

	response := h.do(http.MethodGet, v1Path("cache")+"?keys=key-A1&version="+versionA, token, nil, nil)
	var hit v1RestoreResponse
	decodeInto(t, response, &hit)

	h.advance(2 * time.Minute)
	stale := h.getURL(hit.ArchiveLocation)
	readAll(t, stale)
	if stale.StatusCode != http.StatusForbidden {
		t.Fatalf("expired download = %d, want 403", stale.StatusCode)
	}
}

// The same for the v2 upload URL, which is the one an untrusted job holds for
// the whole of its run.
func TestUploadURLExpires(t *testing.T) {
	h := newHarness(t, func(cfg *config.Config) { cfg.UploadTTL = time.Minute })
	token := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")
	uploadURL := h.createV2(token, "key-A2", versionA)

	h.advance(2 * time.Minute)
	response := h.do(http.MethodPut, blobPathOf(t, uploadURL), "", strings.NewReader("late"), nil)
	readAll(t, response)
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("expired upload = %d, want 403", response.StatusCode)
	}
	// Even the refusal carries the header a client may dereference.
	if response.Header.Get("x-ms-request-id") == "" {
		t.Fatal("the refusal answered without x-ms-request-id")
	}
}

// An upload URL is a bearer credential for one session. Tampering with any part
// of it invalidates the signature.
func TestATamperedUploadURLIsRefused(t *testing.T) {
	h := newHarness(t, nil)
	token := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")
	first := blobPathOf(t, h.createV2(token, "key-A2", versionA))
	second := blobPathOf(t, h.createV2(token, "key-A3", versionA))

	// Splice the first session's id onto the second's signature.
	firstID := strings.SplitN(strings.TrimPrefix(first, blobMarker), "-", 2)[0]
	spliced := blobMarker + firstID + "-" + strings.SplitN(strings.TrimPrefix(second, blobMarker), "-", 2)[1]

	response := h.do(http.MethodPut, spliced, "", strings.NewReader("x"), nil)
	readAll(t, response)
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("spliced upload URL = %d, want 403", response.StatusCode)
	}
}

// One job must not be able to write into another job's reservation, even inside
// the same repository.
func TestAReservationBelongsToOneScope(t *testing.T) {
	h := newHarness(t, nil)
	owner := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")
	other := h.pushToken("attacker/erainfra", "refs/heads/main")

	reserve := h.postJSON(v1Path("caches"), owner,
		jsonBody(map[string]any{"key": "key-A1", "version": versionA}))
	var reserved struct {
		CacheID int64 `json:"cacheId"`
	}
	decodeInto(t, reserve, &reserved)

	response := h.do(http.MethodPatch, v1Path("caches/")+itoa(reserved.CacheID), other,
		strings.NewReader("poison"), map[string]string{"Content-Range": "bytes 0-5/*"})
	readAll(t, response)
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("PATCH from another repository = %d, want 403", response.StatusCode)
	}
}

// The per-entry ceiling is enforced on the bytes, not only on the hint the
// client sends.
func TestEntriesLargerThanTheCeilingAreRefused(t *testing.T) {
	h := newHarness(t, func(cfg *config.Config) { cfg.MaxEntryBytes = 1024 })
	token := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")

	// The hint alone is enough to refuse before any bytes arrive.
	declared := h.postJSON(v1Path("caches"), token,
		jsonBody(map[string]any{"key": "key-A1", "version": versionA, "cacheSize": 4096}))
	readAll(t, declared)
	if declared.StatusCode != http.StatusBadRequest {
		t.Fatalf("oversized reserve = %d, want 400", declared.StatusCode)
	}

	// And a client that lies about it is refused on the bytes.
	reserve := h.postJSON(v1Path("caches"), token,
		jsonBody(map[string]any{"key": "key-A2", "version": versionA}))
	var reserved struct {
		CacheID int64 `json:"cacheId"`
	}
	decodeInto(t, reserve, &reserved)

	response := h.do(http.MethodPatch, v1Path("caches/")+itoa(reserved.CacheID), token,
		bytes.NewReader(payload(4096)), map[string]string{"Content-Range": "bytes 0-4095/*"})
	readAll(t, response)
	if response.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized PATCH = %d, want 413", response.StatusCode)
	}
}

// A key this service cannot round-trip is refused at the door: v1 packs restore
// keys into one comma-separated parameter, so a key with a comma in it could
// never be asked for again.
func TestKeysThatCannotRoundTripAreRefused(t *testing.T) {
	h := newHarness(t, nil)
	token := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")

	for name, key := range map[string]string{
		"empty":          "",
		"with a comma":   "node-cache,linux",
		"with a newline": "node-cache\nlinux",
		"too long":       strings.Repeat("k", maxCacheKeyBytes+1),
	} {
		t.Run(name, func(t *testing.T) {
			response := h.postJSON(v1Path("caches"), token,
				jsonBody(map[string]any{"key": key, "version": versionA}))
			readAll(t, response)
			if response.StatusCode != http.StatusBadRequest {
				t.Fatalf("reserve %q = %d, want 400", key, response.StatusCode)
			}
		})
	}
}

// Content-Range parsing, including the shape that is absent.
func TestParseContentRange(t *testing.T) {
	for value, want := range map[string][2]int64{
		"":                                  {0, -1},
		"bytes 0-33554431/*":                {0, 33554431},
		"bytes 33554432-67108863/203848100": {33554432, 67108863},
		"  bytes 0-0/*  ":                   {0, 0},
	} {
		start, end, err := parseContentRange(value)
		if err != nil {
			t.Errorf("parseContentRange(%q) = %v", value, err)
			continue
		}
		if start != want[0] || end != want[1] {
			t.Errorf("parseContentRange(%q) = %d,%d want %d,%d", value, start, end, want[0], want[1])
		}
	}
	for _, bad := range []string{"items 0-1/*", "bytes 0/*", "bytes a-b/*", "bytes 5-1/*", "bytes -1-5/*"} {
		if _, _, err := parseContentRange(bad); err == nil {
			t.Errorf("parseContentRange(%q) accepted it", bad)
		}
	}
}

// @actions/cache uploads up to four chunks at a time (capture L021-L027 is one
// step's traffic, not one connection's). Sequential delivery would pass a test
// that a concurrent one fails, so the concurrent case is its own test and the
// suite runs under -race in CI.
func TestV1AcceptsConcurrentOutOfOrderChunks(t *testing.T) {
	h := newHarness(t, nil)
	token := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")

	const chunkSize = 256 << 10
	const chunks = 9
	const tail = 1234
	body := payload(chunks*chunkSize + tail)

	reserve := h.postJSON(v1Path("caches"), token,
		jsonBody(map[string]any{"key": keySetupNode, "version": versionSetupNode, "cacheSize": len(body)}))
	var reserved struct {
		CacheID int64 `json:"cacheId"`
	}
	decodeInto(t, reserve, &reserved)

	ranges := make([]chunk, 0, chunks+1)
	for i := 0; i < chunks; i++ {
		ranges = append(ranges, chunk{start: i * chunkSize, length: chunkSize})
	}
	ranges = append(ranges, chunk{start: chunks * chunkSize, length: tail})

	var wait sync.WaitGroup
	for _, part := range ranges {
		wait.Add(1)
		go func(part chunk) {
			defer wait.Done()
			response := h.do(http.MethodPatch, v1Path("caches/")+itoa(reserved.CacheID), token,
				bytes.NewReader(body[part.start:part.start+part.length]),
				map[string]string{"Content-Range": contentRange(part)})
			readAll(t, response)
			if response.StatusCode != http.StatusNoContent {
				t.Errorf("PATCH at %d = %d", part.start, response.StatusCode)
			}
		}(part)
	}
	wait.Wait()

	commit := h.postJSON(v1Path("caches/")+itoa(reserved.CacheID), token,
		jsonBody(map[string]any{"size": len(body)}))
	readAll(t, commit)
	if commit.StatusCode != http.StatusNoContent {
		t.Fatalf("commit = %d", commit.StatusCode)
	}
	if got := h.restoreV1(token, keySetupNode, versionSetupNode); !bytes.Equal(got, body) {
		t.Fatal("concurrent chunks did not reassemble")
	}
}

// spooledBytes is what this session has actually put on disk, which is the
// number the per-entry ceiling is supposed to bound.
func spooledBytes(t *testing.T, root string) int64 {
	t.Helper()
	var total int64
	if err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		total += info.Size()
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return total
}

// Azure clients stage blocks concurrently. Checking the remaining budget and
// recording the block afterwards would let every one of them read the same
// remaining capacity, be allowed all of it, and together put several times the
// ceiling on disk — so the claim and the check are one operation.
func TestConcurrentBlocksCannotOvershootTheEntryCeiling(t *testing.T) {
	const ceiling = 64 << 10
	h := newHarness(t, func(cfg *config.Config) { cfg.MaxEntryBytes = ceiling })
	token := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")
	blobPath := blobPathOf(t, h.createV2(token, keySetupNode, versionSetupNode))

	const blocks = 8
	var accepted, refused atomic.Int64
	var wait sync.WaitGroup
	for i := 0; i < blocks; i++ {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			response := h.do(http.MethodPut,
				blobPath+"?comp=block&blockid="+urlEscape(blockID(index)), "",
				bytes.NewReader(payload(ceiling)), nil)
			readAll(t, response)
			switch response.StatusCode {
			case http.StatusCreated:
				accepted.Add(1)
			case http.StatusRequestEntityTooLarge:
				refused.Add(1)
			default:
				t.Errorf("block %d = %d", index, response.StatusCode)
			}
		}(i)
	}
	wait.Wait()

	if accepted.Load()+refused.Load() != blocks {
		t.Fatalf("accepted %d refused %d of %d", accepted.Load(), refused.Load(), blocks)
	}
	if accepted.Load() != 1 {
		t.Errorf("accepted %d blocks of %d bytes against a %d byte ceiling, want 1",
			accepted.Load(), ceiling, ceiling)
	}
	if spooled := spooledBytes(t, h.server.config.SpoolDir); spooled > ceiling {
		t.Fatalf("%d bytes are on disk against a %d byte ceiling", spooled, ceiling)
	}
}

// CreateCacheEntry is refused only when the entry already exists in the index,
// so a client that reserves the same key twice — a retry, or a step that runs
// again — leaves more than one session behind. Map iteration order is random,
// so picking whichever came first would answer {"ok":false} for an upload that
// had already put every byte in the store.
func TestFinalizeFindsTheSessionThatActuallyUploaded(t *testing.T) {
	h := newHarness(t, nil)
	token := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")
	body := payload(2305)

	// Four reservations for one key, and the bytes go through the last of them.
	var uploadURL string
	for i := 0; i < 4; i++ {
		uploadURL = h.createV2(token, "index-D2-1-f921bd05#1", versionBuildKit)
	}
	put := h.do(http.MethodPut, blobPathOf(t, uploadURL), "", bytes.NewReader(body), nil)
	readAll(t, put)
	if put.StatusCode != http.StatusCreated {
		t.Fatalf("upload = %d", put.StatusCode)
	}

	finalized := h.finalizeV2(token, "index-D2-1-f921bd05#1", versionBuildKit, len(body))
	if !finalized.OK {
		t.Fatalf("finalize = %+v, want the committed session to have been found", finalized)
	}

	response := h.postJSON(v2Path("GetCacheEntryDownloadURL"), token,
		jsonBody(map[string]any{"key": "index-D2-1-f921bd05#1", "version": versionBuildKit}))
	var hit v2DownloadResponse
	decodeInto(t, response, &hit)
	if !hit.OK {
		t.Fatal("the entry did not come back")
	}
	if got := readAll(t, h.getURL(hit.SignedDownloadURL)); !bytes.Equal(got, body) {
		t.Fatal("the entry does not hold the bytes that were uploaded")
	}
}
