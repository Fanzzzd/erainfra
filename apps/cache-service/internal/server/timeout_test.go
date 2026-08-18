package server

import (
	"bytes"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Fanzzzd/erainfra/apps/cache-service/internal/config"
	"github.com/Fanzzzd/erainfra/apps/cache-service/internal/objectstore/fakes3"
)

// The outage that has to be designed against is not an error, it is silence.
//
// ADR 0007 is explicit: every wrong-shaped restore response in the capture
// produced a warning and a slower job, but DNS failure, connection refusal, a
// TLS error and "a service that accepts the connection and never answers" are
// unmeasured, and the last one is the dangerous shape, "because a client with
// no deadline turns a cache outage into a job that hangs rather than one that
// misses". The budgets are therefore service-side, and these are the tests that
// hold them.
//
// The budget per fault class, as configured in internal/config:
//
//	lookup   5s  -> answered as a miss
//	reserve  10s -> answered as a refusal to save
//	transfer 30m -> answered as a store error on the upload path
//
// They are shortened here so the tests are fast; what is under test is that a
// hung store is answered inside the budget rather than waited on.

const testBudget = 150 * time.Millisecond

// answersWithin fails the test if the call takes materially longer than the
// budget. The slack is generous on purpose: this is asserting that a deadline
// exists, not measuring scheduler latency.
func answersWithin(t *testing.T, budget time.Duration, call func()) {
	t.Helper()
	start := time.Now()
	call()
	if elapsed := time.Since(start); elapsed > budget*10+2*time.Second {
		t.Fatalf("answered in %s, want the %s budget to have fired", elapsed, budget)
	}
}

func newStalledHarness(t *testing.T) *harness {
	t.Helper()
	store := fakes3.New()
	blocked := make(chan struct{})
	store.SetStall(func(string, string) <-chan struct{} { return blocked })
	t.Cleanup(func() {
		close(blocked)
		store.Close()
	})
	return newHarnessWithEndpoint(t, store, store.URL, func(cfg *config.Config) {
		cfg.LookupTimeout = testBudget
		cfg.ReserveTimeout = testBudget
		cfg.TransferTimeout = testBudget
	})
}

// A hung store must not turn a restore into a hung job. It comes out as the
// protocol's own miss on both generations.
func TestHungStoreAnswersRestoresAsAMiss(t *testing.T) {
	h := newStalledHarness(t)
	token := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")

	answersWithin(t, testBudget, func() {
		response := h.do(http.MethodGet,
			v1Path("cache")+"?keys=key-A1&version="+versionA, token, nil, nil)
		body := readAll(t, response)
		if response.StatusCode != http.StatusNoContent || len(body) != 0 {
			t.Fatalf("v1 restore = %d %q, want a 204 miss", response.StatusCode, body)
		}
	})

	answersWithin(t, testBudget, func() {
		response := h.postJSON(v2Path("GetCacheEntryDownloadURL"), token,
			jsonBody(map[string]any{"key": "key-A2", "version": versionA}))
		if response.StatusCode != http.StatusOK {
			t.Fatalf("v2 restore = %d, want 200", response.StatusCode)
		}
		var miss v2DownloadResponse
		decodeInto(t, response, &miss)
		if miss.OK {
			t.Fatalf("v2 restore = %+v, want a miss", miss)
		}
	})
}

// A hung store on the reserve path costs the job its save and nothing else.
func TestHungStoreAnswersReservationsAsARefusal(t *testing.T) {
	h := newStalledHarness(t)
	token := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")

	answersWithin(t, testBudget, func() {
		response := h.postJSON(v1Path("caches"), token,
			jsonBody(map[string]any{"key": "key-A1", "version": versionA}))
		readAll(t, response)
		if response.StatusCode != http.StatusServiceUnavailable {
			t.Fatalf("v1 reserve = %d, want 503", response.StatusCode)
		}
	})

	answersWithin(t, testBudget, func() {
		response := h.postJSON(v2Path("CreateCacheEntry"), token,
			jsonBody(map[string]any{"key": "key-A2", "version": versionA}))
		var created v2CreateResponse
		decodeInto(t, response, &created)
		// 200 {"ok": false} rather than a twirp error: an error here would cost
		// the client five attempts and about 30 seconds of backoff
		// (capture L124-L128) to reach the same outcome.
		if response.StatusCode != http.StatusOK || created.OK {
			t.Fatalf("v2 create = %d %+v, want a 200 refusal", response.StatusCode, created)
		}
	})
}

// The upload paths are bounded too. The store is reachable for the reservation
// and hangs once the bytes have to land, which is where a naive implementation
// blocks forever holding a spool file.
func TestHungStoreAnswersUploadsWithinTheTransferBudget(t *testing.T) {
	store := fakes3.New()
	blocked := make(chan struct{})
	t.Cleanup(func() {
		close(blocked)
		store.Close()
	})
	h := newHarnessWithEndpoint(t, store, store.URL, func(cfg *config.Config) {
		cfg.LookupTimeout = testBudget
		cfg.ReserveTimeout = testBudget
		cfg.TransferTimeout = testBudget
	})
	token := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")

	// v1: reserve and upload succeed, then the store stops answering writes.
	reserve := h.postJSON(v1Path("caches"), token,
		jsonBody(map[string]any{"key": "key-A1", "version": versionA}))
	var reserved struct {
		CacheID int64 `json:"cacheId"`
	}
	decodeInto(t, reserve, &reserved)

	body := payload(4096)
	patch := h.do(http.MethodPatch, v1Path("caches/")+itoa(reserved.CacheID), token,
		bytes.NewReader(body), map[string]string{"Content-Range": "bytes 0-4095/*"})
	readAll(t, patch)

	store.SetStall(func(method string, _ string) <-chan struct{} {
		if method == http.MethodPut || method == http.MethodPost {
			return blocked
		}
		return nil
	})
	answersWithin(t, testBudget, func() {
		commit := h.postJSON(v1Path("caches/")+itoa(reserved.CacheID), token,
			jsonBody(map[string]any{"size": len(body)}))
		readAll(t, commit)
		if commit.StatusCode != http.StatusServiceUnavailable {
			t.Fatalf("v1 commit = %d, want 503", commit.StatusCode)
		}
	})

	// v2: the block list commit is the call that writes to the store, and it
	// still has to answer — with x-ms-request-id, because a client that
	// dereferences it does so on every reply it reads.
	store.SetStall(nil)
	uploadURL := h.createV2(token, "key-A2", versionA)
	blobPath := blobPathOf(t, uploadURL)
	id := blockID(0)
	staged := h.do(http.MethodPut, blobPath+"?comp=block&blockid="+urlEscape(id), "",
		bytes.NewReader(body), nil)
	readAll(t, staged)

	store.SetStall(func(method string, _ string) <-chan struct{} {
		if method == http.MethodPut || method == http.MethodPost {
			return blocked
		}
		return nil
	})
	answersWithin(t, testBudget, func() {
		commit := h.do(http.MethodPut, blobPath+"?comp=blocklist", "",
			strings.NewReader(`<BlockList><Latest>`+id+`</Latest></BlockList>`), nil)
		readAll(t, commit)
		if commit.StatusCode/100 != 5 {
			t.Fatalf("blocklist commit = %d, want a 5xx once the store stopped answering", commit.StatusCode)
		}
		if commit.Header.Get("x-ms-request-id") == "" {
			t.Fatal("even the failure answered without x-ms-request-id")
		}
	})
}

// Connection refusal is one of the fault classes ADR 0007 lists as unmeasured
// against real clients. It is bounded here for the same reason as the hang: a
// restore that cannot reach the store is a miss.
func TestUnreachableStoreAnswersRestoresAsAMiss(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	// Close it again: nothing is listening on that port now, so a connection is
	// refused rather than accepted.
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}

	store := fakes3.New()
	t.Cleanup(store.Close)
	h := newHarnessWithEndpoint(t, store, "http://"+address, func(cfg *config.Config) {
		cfg.LookupTimeout = testBudget
	})
	token := h.pushToken("Fanzzzd/erainfra", "refs/heads/main")

	answersWithin(t, testBudget, func() {
		response := h.do(http.MethodGet,
			v1Path("cache")+"?keys=key-A1&version="+versionA, token, nil, nil)
		readAll(t, response)
		if response.StatusCode != http.StatusNoContent {
			t.Fatalf("v1 restore = %d, want a 204 miss", response.StatusCode)
		}
	})
}
