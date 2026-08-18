package server

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Fanzzzd/erainfra/apps/cache-service/cachetoken"
	"github.com/Fanzzzd/erainfra/apps/cache-service/internal/config"
	"github.com/Fanzzzd/erainfra/apps/cache-service/internal/objectstore"
	"github.com/Fanzzzd/erainfra/apps/cache-service/internal/objectstore/fakes3"
)

// signingKey is long enough to be a secret and fixed so a test can forge with
// the wrong one on purpose.
var signingKey = []byte("erainfra-cache-service-test-signing-key-0123456789")

// startedAt pins the clock. "Newest wins" is a real ordering rule, so the tests
// that depend on it advance a clock rather than race the wall.
var startedAt = time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC)

type harness struct {
	t      *testing.T
	server *Server
	http   *httptest.Server
	store  *fakes3.Server
	issuer *cachetoken.Issuer

	mu    sync.Mutex
	clock time.Time
}

func newHarness(t *testing.T, mutate func(*config.Config)) *harness {
	t.Helper()
	store := fakes3.New()
	t.Cleanup(store.Close)
	return newHarnessWithEndpoint(t, store, store.URL, mutate)
}

func newHarnessWithEndpoint(t *testing.T, store *fakes3.Server, endpoint string, mutate func(*config.Config)) *harness {
	t.Helper()
	cfg := config.Config{
		SigningKey:      signingKey,
		DownloadMode:    config.DownloadPresign,
		DownloadTTL:     5 * time.Minute,
		UploadTTL:       time.Hour,
		LookupTimeout:   5 * time.Second,
		ReserveTimeout:  10 * time.Second,
		TransferTimeout: 2 * time.Minute,
		MaxEntryBytes:   1 << 30,
		SpoolDir:        t.TempDir(),
		Store: objectstore.S3Config{
			Endpoint:  endpoint,
			Bucket:    store.Bucket,
			AccessKey: store.AccessKey,
			Secret:    store.Secret,
			Region:    "us-east-1",
			Prefix:    "erainfra-cache/v1/",
			PathStyle: true,
			// Small on purpose: a 5 MiB part size means a test-sized entry
			// still exercises the multipart path rather than the single-object
			// shortcut.
			PartBytes: 5 << 20,
		},
	}
	if mutate != nil {
		mutate(&cfg)
	}

	backing, err := objectstore.NewS3(cfg.Store)
	if err != nil {
		t.Fatal(err)
	}
	h := &harness{t: t, store: store, clock: startedAt}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	server, err := New(cfg, backing, logger)
	if err != nil {
		t.Fatal(err)
	}
	server.Now = h.now
	server.index.Now = h.now
	t.Cleanup(server.Close)

	issuer, err := cachetoken.NewIssuer(cfg.SigningKey, 30*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	issuer.Now = h.now

	h.server = server
	h.issuer = issuer
	h.http = httptest.NewServer(server)
	t.Cleanup(h.http.Close)
	return h
}

func (h *harness) now() time.Time {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.clock
}

// advance moves the clock. Entry recency is encoded in the entry's own object
// name at millisecond resolution, so a test that writes twice must say which
// write is later.
func (h *harness) advance(by time.Duration) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.clock = h.clock.Add(by)
}

func (h *harness) token(facts cachetoken.JobFacts) string {
	h.t.Helper()
	token, _, err := h.issuer.Issue(facts)
	if err != nil {
		h.t.Fatal(err)
	}
	return token
}

// pushToken is the ordinary case: a branch push, which the issuer grants write.
func (h *harness) pushToken(repository, ref string) string {
	return h.token(cachetoken.JobFacts{
		Repository: repository, Event: "push", Ref: ref, DefaultBranch: "refs/heads/main",
	})
}

func (h *harness) do(method, path, token string, body io.Reader, headers map[string]string) *http.Response {
	h.t.Helper()
	request, err := http.NewRequest(method, h.http.URL+path, body)
	if err != nil {
		h.t.Fatal(err)
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	response, err := h.http.Client().Do(request)
	if err != nil {
		h.t.Fatal(err)
	}
	return response
}

func (h *harness) postJSON(path, token, body string) *http.Response {
	return h.do(http.MethodPost, path, token, strings.NewReader(body),
		map[string]string{"Content-Type": "application/json"})
}

func (h *harness) getURL(url string) *http.Response {
	h.t.Helper()
	response, err := h.http.Client().Get(url)
	if err != nil {
		h.t.Fatal(err)
	}
	return response
}

func readAll(t *testing.T, response *http.Response) []byte {
	t.Helper()
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func decodeInto(t *testing.T, response *http.Response, target any) {
	t.Helper()
	body := readAll(t, response)
	if err := json.Unmarshal(body, target); err != nil {
		t.Fatalf("response %d body %q does not decode: %v", response.StatusCode, body, err)
	}
}

// payload builds a deterministic body of the requested size.
func payload(size int) []byte {
	body := make([]byte, size)
	for i := range body {
		body[i] = byte('a' + i%26)
	}
	return body
}

// saveV1 runs the whole legacy save: reserve, one PATCH per chunk, commit.
// Chunks are delivered in the order given, which is how the capture's traffic
// arrives (L021-L027 sends the final short chunk fifth of seven).
func (h *harness) saveV1(token, key, version string, body []byte, chunks []chunk) {
	h.t.Helper()
	reserve := h.postJSON(v1Path("caches"), token,
		jsonBody(map[string]any{"key": key, "version": version, "cacheSize": len(body)}))
	if reserve.StatusCode != http.StatusCreated {
		h.t.Fatalf("reserve = %d %s", reserve.StatusCode, readAll(h.t, reserve))
	}
	var reserved struct {
		CacheID int64 `json:"cacheId"`
	}
	decodeInto(h.t, reserve, &reserved)

	for _, part := range chunks {
		response := h.do(http.MethodPatch, v1Path("caches/")+itoa(reserved.CacheID), token,
			bytes.NewReader(body[part.start:part.start+part.length]),
			map[string]string{"Content-Range": contentRange(part)})
		if response.StatusCode != http.StatusNoContent {
			h.t.Fatalf("PATCH at %d = %d %s", part.start, response.StatusCode, readAll(h.t, response))
		}
		response.Body.Close()
	}

	commit := h.postJSON(v1Path("caches/")+itoa(reserved.CacheID), token,
		jsonBody(map[string]any{"size": len(body)}))
	if commit.StatusCode != http.StatusNoContent {
		h.t.Fatalf("commit = %d %s", commit.StatusCode, readAll(h.t, commit))
	}
	commit.Body.Close()
}

type chunk struct {
	start  int
	length int
}

func wholeBody(body []byte) []chunk { return []chunk{{start: 0, length: len(body)}} }

func contentRange(part chunk) string {
	return "bytes " + itoa(int64(part.start)) + "-" + itoa(int64(part.start+part.length-1)) + "/*"
}

func itoa(value int64) string { return strconv.FormatInt(value, 10) }

func jsonBody(fields map[string]any) string {
	body, err := json.Marshal(fields)
	if err != nil {
		panic(err)
	}
	return string(body)
}

// v1Path and v2Path mount the protocol under a per-job path prefix, which is
// what ACTIONS_CACHE_URL actually carries — the capture writes it as
// {ACTIONS_CACHE_URL} for that reason. Routing that only worked at the root
// would pass every test here and fail against a real runner environment.
func v1Path(route string) string {
	return "/job/8f21c0a" + v1Marker + route
}

func v2Path(method string) string {
	return "/job/8f21c0a" + v2Marker + method
}

// restoreV1 does a legacy restore and returns the bytes it got, failing the
// test on a miss.
func (h *harness) restoreV1(token, key, version string) []byte {
	h.t.Helper()
	response := h.do(http.MethodGet, v1Path("cache")+"?keys="+key+"&version="+version, token, nil, nil)
	if response.StatusCode != http.StatusOK {
		h.t.Fatalf("restore %q = %d, want a hit", key, response.StatusCode)
	}
	var hit v1RestoreResponse
	decodeInto(h.t, response, &hit)
	return readAll(h.t, h.getURL(hit.ArchiveLocation))
}
