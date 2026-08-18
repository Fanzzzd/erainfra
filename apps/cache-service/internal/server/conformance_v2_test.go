package server

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

// Cache Service v2 conformance, including the Azure-shaped upload path that
// ADR 0007 left stage B to answer.

// blockID builds an Azure block id the way a client does: a fixed-width
// identifier, base64 encoded (capture L033 shows a 64-character base64 id).
func blockID(index int) string {
	return base64.StdEncoding.EncodeToString([]byte(fmt.Sprintf("%048d", index)))
}

// stageBlocks runs a full v2 save through the translated Azure block protocol
// and returns the signed upload URL it used.
func (h *harness) saveV2Blocks(token, key, version string, blocks [][]byte) string {
	h.t.Helper()
	uploadURL := h.createV2(token, key, version)

	var list strings.Builder
	list.WriteString(`<?xml version="1.0" encoding="utf-8"?><BlockList>`)
	total := 0
	for index, block := range blocks {
		id := blockID(index)
		response := h.do(http.MethodPut, blobPathOf(h.t, uploadURL)+"?comp=block&blockid="+
			urlEscape(id), "", bytes.NewReader(block),
			map[string]string{"x-ms-version": "2024-11-04"})
		body := readAll(h.t, response)
		if response.StatusCode != http.StatusCreated {
			h.t.Fatalf("stage block %d = %d %s", index, response.StatusCode, body)
		}
		if response.Header.Get("x-ms-request-id") == "" {
			h.t.Fatalf("staged block %d answered without x-ms-request-id", index)
		}
		list.WriteString("<Latest>" + id + "</Latest>")
		total += len(block)
	}
	list.WriteString("</BlockList>")

	commit := h.do(http.MethodPut, blobPathOf(h.t, uploadURL)+"?comp=blocklist", "",
		strings.NewReader(list.String()), map[string]string{"x-ms-version": "2024-11-04"})
	commitBody := readAll(h.t, commit)
	if commit.StatusCode != http.StatusCreated {
		h.t.Fatalf("blocklist commit = %d %s", commit.StatusCode, commitBody)
	}
	// The one header that is not optional.
	if commit.Header.Get("x-ms-request-id") == "" {
		h.t.Fatal("the blocklist commit answered without x-ms-request-id")
	}
	return uploadURL
}

func (h *harness) createV2(token, key, version string) string {
	h.t.Helper()
	response := h.postJSON(v2Path("CreateCacheEntry"), token,
		jsonBody(map[string]any{"key": key, "version": version}))
	var created v2CreateResponse
	decodeInto(h.t, response, &created)
	if !created.OK || created.SignedUploadURL == "" {
		h.t.Fatalf("CreateCacheEntry = %+v", created)
	}
	return created.SignedUploadURL
}

func (h *harness) finalizeV2(token, key, version string, sizeBytes any) v2FinalizeResponse {
	h.t.Helper()
	body, err := json.Marshal(map[string]any{"key": key, "size_bytes": sizeBytes, "version": version})
	if err != nil {
		h.t.Fatal(err)
	}
	response := h.postJSON(v2Path("FinalizeCacheEntryUpload"), token, string(body))
	var finalized v2FinalizeResponse
	decodeInto(h.t, response, &finalized)
	return finalized
}

func blobPathOf(t *testing.T, uploadURL string) string {
	t.Helper()
	index := strings.Index(uploadURL, blobMarker)
	if index < 0 {
		t.Fatalf("signed upload URL %q does not point at this service", uploadURL)
	}
	return uploadURL[index:]
}

func urlEscape(value string) string {
	var out strings.Builder
	for i := 0; i < len(value); i++ {
		switch c := value[i]; {
		case (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
			c == '-' || c == '_' || c == '.' || c == '~':
			out.WriteByte(c)
		default:
			out.WriteString(fmt.Sprintf("%%%02X", c))
		}
	}
	return out.String()
}

// L007: a v2 miss is 200 with {"ok": false} and both other fields empty. It is
// never a twirp 404 (which costs a warning and a lost cache, L123) and never a
// 500 (five attempts and about 30 seconds of backoff per restore step,
// L124-L128).
func TestV2MissIs200WithOKFalse(t *testing.T) {
	h := newHarness(t, nil)
	token := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")

	response := h.postJSON(v2Path("GetCacheEntryDownloadURL"), token,
		`{"key":"key-A2","version":"b34e6f1cc07875b8b978f21e92cbe8337fea885819e74e1d75a2c78c7a523960"}`)
	body := readAll(t, response)

	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.StatusCode)
	}
	var miss v2DownloadResponse
	if err := json.Unmarshal(body, &miss); err != nil {
		t.Fatal(err)
	}
	if miss.OK || miss.SignedDownloadURL != "" || miss.MatchedKey != "" {
		t.Fatalf("miss = %+v, want the L007 shape", miss)
	}
	// The captured miss carries all three fields, so a client reading
	// signed_download_url unconditionally finds a string rather than null.
	for _, field := range []string{`"ok":false`, `"signed_download_url":""`, `"matched_key":""`} {
		if !strings.Contains(string(body), field) {
			t.Errorf("body %s is missing %s", body, field)
		}
	}
}

// L008-L012: the A2 round trip. size_bytes arrives as a JSON string here, which
// is what @actions/cache sends (L010, L038).
func TestV2RoundTripFollowsTheA2Capture(t *testing.T) {
	h := newHarness(t, nil)
	token := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")
	body := payload(8010403)

	// L009: a single PUT with no comp parameter — Azure's Put Blob.
	uploadURL := h.createV2(token, "key-A2", versionA)
	put := h.do(http.MethodPut, blobPathOf(t, uploadURL), "", bytes.NewReader(body),
		map[string]string{"x-ms-blob-type": "BlockBlob"})
	readAll(t, put)
	if put.StatusCode != http.StatusCreated {
		t.Fatalf("whole-blob PUT = %d", put.StatusCode)
	}
	if put.Header.Get("x-ms-request-id") == "" {
		t.Fatal("the whole-blob PUT answered without x-ms-request-id")
	}

	finalized := h.finalizeV2(token, "key-A2", versionA, "8010403")
	if !finalized.OK || finalized.EntryID == "" {
		t.Fatalf("FinalizeCacheEntryUpload = %+v", finalized)
	}

	response := h.postJSON(v2Path("GetCacheEntryDownloadURL"), token,
		jsonBody(map[string]any{"key": "key-A2", "version": versionA}))
	var hit v2DownloadResponse
	decodeInto(t, response, &hit)
	if !hit.OK || hit.MatchedKey != "key-A2" {
		t.Fatalf("hit = %+v", hit)
	}
	got := readAll(t, h.getURL(hit.SignedDownloadURL))
	if !bytes.Equal(got, body) {
		t.Fatalf("downloaded %d bytes, want %d", len(got), len(body))
	}
}

// L033-L038: the staged-block path. Four blocks then an XML block list, which
// is what @actions/cache does for anything past one block and what BuildKit
// does from 1 MiB up.
func TestV2BlockUploadAssemblesInBlockListOrder(t *testing.T) {
	h := newHarness(t, nil)
	token := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")

	// BuildKit's block size is 1 MiB (L081-L084), which is below S3's 5 MiB
	// minimum part size — the case a one-block-one-part translation gets wrong.
	blocks := [][]byte{payload(1 << 20), payload(1 << 20), payload(1 << 20), payload(946591)}
	var want []byte
	for _, block := range blocks {
		want = append(want, block...)
	}

	h.saveV2Blocks(token, keySetupNode, versionSetupNode, blocks)
	finalized := h.finalizeV2(token, keySetupNode, versionSetupNode, len(want))
	if !finalized.OK {
		t.Fatalf("finalize = %+v", finalized)
	}

	response := h.postJSON(v2Path("GetCacheEntryDownloadURL"), token,
		jsonBody(map[string]any{"key": keySetupNode, "version": versionSetupNode}))
	var hit v2DownloadResponse
	decodeInto(t, response, &hit)
	if !hit.OK {
		t.Fatal("the entry did not come back")
	}
	got := readAll(t, h.getURL(hit.SignedDownloadURL))
	if !bytes.Equal(got, want) {
		t.Fatalf("assembled %d bytes, want %d", len(got), len(want))
	}
}

// The block-list commit is where BuildKit segfaults if x-ms-request-id is
// missing: go-actions-cache logs *resp.RequestID without a nil check, so the
// build dies after every byte is already uploaded, with a message that names
// nothing about the cache. This test is the whole reason the header is set on
// every blob response rather than only where it is needed.
func TestV2BlobCommitCarriesXMSRequestID(t *testing.T) {
	h := newHarness(t, nil)
	token := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")

	uploadURL := h.createV2(token, "index-D2-1-f921bd05#1", versionBuildKit)
	blobPath := blobPathOf(t, uploadURL)

	id := blockID(0)
	staged := h.do(http.MethodPut, blobPath+"?comp=block&blockid="+urlEscape(id), "",
		bytes.NewReader(payload(2305)), nil)
	readAll(t, staged)

	commit := h.do(http.MethodPut, blobPath+"?comp=blocklist", "",
		strings.NewReader(`<?xml version="1.0" encoding="utf-8"?><BlockList><Latest>`+id+`</Latest></BlockList>`),
		nil)
	readAll(t, commit)

	for name, response := range map[string]*http.Response{"staged block": staged, "block list commit": commit} {
		if got := response.Header.Get("x-ms-request-id"); got == "" {
			t.Errorf("%s answered without x-ms-request-id", name)
		}
	}
	if commit.Header.Get("ETag") == "" {
		t.Error("the block list commit answered without an ETag")
	}
}

// L038 sends size_bytes as a JSON string and L086 sends it as a JSON number.
// Both are real clients and both have to work; picking one loses half the
// population on the last call of an already-completed upload.
func TestV2FinalizeAcceptsSizeBytesAsStringOrNumber(t *testing.T) {
	for name, size := range map[string]any{
		"L038 @actions/cache sends a string": "2305",
		"L086 BuildKit sends a number":       2305,
	} {
		t.Run(name, func(t *testing.T) {
			h := newHarness(t, nil)
			token := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")
			h.saveV2Blocks(token, "index-D2-1-f921bd05#1", versionBuildKit, [][]byte{payload(2305)})

			finalized := h.finalizeV2(token, "index-D2-1-f921bd05#1", versionBuildKit, size)
			if !finalized.OK {
				t.Fatalf("finalize = %+v", finalized)
			}
		})
	}
}

// L111 and L115: BuildKit writes index-D2-1-f921bd05#1 and reads back both
// index-D2-1-f921bd05# and the bare index-D2-1-f921bd05, and expects
// matched_key to name the entry that was found. It also repeats the primary key
// inside restore_keys (L078), which must not be searched twice.
func TestV2MatchesAPrefixAndReportsTheFullKey(t *testing.T) {
	h := newHarness(t, nil)
	token := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")

	h.saveV2Blocks(token, "index-D2-1-f921bd05#1", versionBuildKit, [][]byte{payload(2305)})
	if !h.finalizeV2(token, "index-D2-1-f921bd05#1", versionBuildKit, 2305).OK {
		t.Fatal("finalize failed")
	}

	response := h.postJSON(v2Path("GetCacheEntryDownloadURL"), token,
		`{"key":"index-D2-1-f921bd05","restore_keys":["index-D2-1-f921bd05"],"version":"693bb7016429d80366022f036f84856888c9f13e00145f5f6f4dce303a38d6f2"}`)
	var hit v2DownloadResponse
	decodeInto(t, response, &hit)
	if !hit.OK || hit.MatchedKey != "index-D2-1-f921bd05#1" {
		t.Fatalf("hit = %+v, want matched_key to name the stored key", hit)
	}
}

// A store fault on the restore path is a miss, never a twirp error: a twirp 404
// costs a warning and a lost cache (L123), and a 500 costs five attempts and
// about 30 seconds of backoff per restore step before the same lost cache
// (L124-L128).
func TestV2StoreFaultsDegradeToAMiss(t *testing.T) {
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

			response := h.postJSON(v2Path("GetCacheEntryDownloadURL"), token,
				jsonBody(map[string]any{"key": "key-A2", "version": versionA}))
			if response.StatusCode != http.StatusOK {
				t.Fatalf("status = %d, want 200 even while the store is broken", response.StatusCode)
			}
			var miss v2DownloadResponse
			decodeInto(t, response, &miss)
			if miss.OK {
				t.Fatalf("miss = %+v", miss)
			}
		})
	}
}

// An unmeasured method is refused with a twirp bad_route rather than answered
// with a guess. The capture drove exactly three (L007, L008, L010).
func TestV2UnknownMethodIsBadRoute(t *testing.T) {
	h := newHarness(t, nil)
	token := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")

	response := h.postJSON(v2Path("DeleteCacheEntry"), token, `{}`)
	body := readAll(t, response)
	if response.StatusCode != http.StatusNotFound || !strings.Contains(string(body), "bad_route") {
		t.Fatalf("status = %d body = %s", response.StatusCode, body)
	}
}
