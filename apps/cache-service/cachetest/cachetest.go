// Package cachetest runs a real cache service over an in-memory S3 for tests
// outside apps/cache-service: the guest's build cache proxy and the Go
// GOCACHEPROG helper test against the service they talk to in production, not
// a stub of it.
//
// A job is authorized the way production authorizes it: the job facts are
// pushed to the signed admin endpoint the controller uses, and the request
// carries a runner token minted with the shared key, as the host mints one at
// claim.
package cachetest

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Fanzzzd/erainfra/apps/cache-service/internal/config"
	"github.com/Fanzzzd/erainfra/apps/cache-service/internal/objectstore"
	"github.com/Fanzzzd/erainfra/apps/cache-service/internal/objectstore/fakes3"
	"github.com/Fanzzzd/erainfra/apps/cache-service/internal/server"
	"github.com/Fanzzzd/erainfra/internal/cachetoken"
)

// signingKey is fixed: nothing outside the test process ever holds it.
var signingKey = []byte("erainfra-cachetest-signing-key-0123456789abcdef")

// Service is a running cache service.
type Service struct {
	// URL is the service's base URL, what a guest receives as its cache
	// service URL.
	URL string

	t      testing.TB
	http   *httptest.Server
	issuer *cachetoken.Issuer

	mu  sync.Mutex
	seq int
}

// Options adjust the service's configuration. A zero field keeps the default.
type Options struct {
	// RepoQuotaBytes is the per-repository quota.
	RepoQuotaBytes int64
	// MaxEntryBytes is the per-entry ceiling.
	MaxEntryBytes int64
	// Logger receives the service's log. Nil discards it.
	Logger *slog.Logger
}

// Start runs a cache service until the test ends.
func Start(t testing.TB, options Options) *Service {
	t.Helper()
	store := fakes3.New()
	t.Cleanup(store.Close)
	cfg := config.Config{
		SigningKey:      signingKey,
		DownloadMode:    config.DownloadProxy,
		DownloadTTL:     5 * time.Minute,
		UploadTTL:       time.Hour,
		LookupTimeout:   5 * time.Second,
		ReserveTimeout:  10 * time.Second,
		TransferTimeout: 2 * time.Minute,
		MaxEntryBytes:   1 << 30,
		RepoQuotaBytes:  options.RepoQuotaBytes,
		SpoolDir:        t.TempDir(),
		Store: objectstore.S3Config{
			Endpoint:  store.URL,
			Bucket:    store.Bucket,
			AccessKey: store.AccessKey,
			Secret:    store.Secret,
			Region:    "us-east-1",
			Prefix:    "erainfra-cache/v1/",
			PathStyle: true,
			PartBytes: 5 << 20,
		},
	}
	if options.MaxEntryBytes > 0 {
		cfg.MaxEntryBytes = options.MaxEntryBytes
	}
	backing, err := objectstore.NewS3(cfg.Store)
	if err != nil {
		t.Fatal(err)
	}
	logger := options.Logger
	if logger == nil {
		logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	srv, err := server.New(cfg, backing, logger)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(srv.Close)
	httpServer := httptest.NewServer(srv)
	t.Cleanup(httpServer.Close)
	issuer, err := cachetoken.NewIssuer(signingKey, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	return &Service{URL: httpServer.URL, t: t, http: httpServer, issuer: issuer}
}

// PushJob is the ordinary case: a push to a branch of repository, which may
// read and write that branch's cache. It returns the runner token for it.
func (s *Service) PushJob(repository, ref string) string {
	return s.RunnerToken(cachetoken.JobFacts{
		Repository: repository, Event: "push", Ref: ref, DefaultBranch: "refs/heads/main",
	})
}

// RunnerToken registers facts for a fresh runner, exactly as the controller
// does at JobStarted, and returns the bearer the host would mint for that
// runner at claim. Facts without a repository ID get a stable one derived from
// the name, as the controller always pushes one.
func (s *Service) RunnerToken(facts cachetoken.JobFacts) string {
	s.t.Helper()
	s.mu.Lock()
	s.seq++
	runner := fmt.Sprintf("cachetest-runner-%d", s.seq)
	s.mu.Unlock()

	repositoryID := facts.RepositoryID
	if repositoryID == 0 {
		sum := fnv.New32a()
		_, _ = sum.Write([]byte(strings.ToLower(facts.Repository)))
		repositoryID = int64(sum.Sum32()) + 1
	}
	body, err := json.Marshal(map[string]any{
		"runner":         runner,
		"repository":     facts.Repository,
		"repositoryId":   repositoryID,
		"headRepository": facts.HeadRepository,
		"event":          facts.Event,
		"ref":            facts.Ref,
		"baseRef":        facts.BaseRef,
		"defaultBranch":  facts.DefaultBranch,
		"expiresUnix":    time.Now().Add(time.Hour).Unix(),
	})
	if err != nil {
		s.t.Fatal(err)
	}
	mac := hmac.New(sha256.New, signingKey)
	mac.Write(body)
	request, err := http.NewRequestWithContext(s.t.Context(), http.MethodPost, s.URL+"/_erainfra-cache-admin/facts", bytes.NewReader(body))
	if err != nil {
		s.t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Erainfra-Cache-Admin", hex.EncodeToString(mac.Sum(nil)))
	response, err := s.http.Client().Do(request)
	if err != nil {
		s.t.Fatal(err)
	}
	defer response.Body.Close() //nolint:errcheck // read-only body
	if response.StatusCode != http.StatusNoContent {
		detail, _ := io.ReadAll(response.Body)
		s.t.Fatalf("facts push = %d %s", response.StatusCode, detail)
	}
	token, _, err := s.issuer.IssueRunner(runner)
	if err != nil {
		s.t.Fatal(err)
	}
	return token
}

// Metric reads one sample from the service's /metrics, or -1 when the series
// is not there. series is the full name with labels, as it is printed.
func (s *Service) Metric(series string) int64 {
	s.t.Helper()
	request, err := http.NewRequestWithContext(s.t.Context(), http.MethodGet, s.URL+"/metrics", nil)
	if err != nil {
		s.t.Fatal(err)
	}
	response, err := s.http.Client().Do(request)
	if err != nil {
		s.t.Fatal(err)
	}
	defer response.Body.Close() //nolint:errcheck // read-only body
	text, err := io.ReadAll(response.Body)
	if err != nil {
		s.t.Fatal(err)
	}
	for _, line := range bytes.Split(text, []byte("\n")) {
		name, value, found := bytes.Cut(line, []byte(" "))
		if !found || string(name) != series {
			continue
		}
		var count int64
		if _, err := fmt.Sscan(string(value), &count); err != nil {
			s.t.Fatalf("metric %s = %q: %v", series, value, err)
		}
		return count
	}
	return -1
}
