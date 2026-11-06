package guestcache

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Fanzzzd/erainfra/apps/cache-service/cachetest"
	"github.com/Fanzzzd/erainfra/apps/cache-service/cachetoken"
)

// lines collects what the proxy logs.
type lines struct {
	mu  sync.Mutex
	all []string
}

func (l *lines) logf(format string, args ...any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.all = append(l.all, fmt.Sprintf(format, args...))
}

func (l *lines) snapshot() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.all...)
}

// countingTransport counts round trips to the cache service, so a test can
// tell a request the proxy forwarded from one it answered itself.
type countingTransport struct {
	next  http.RoundTripper
	count atomic.Int64
}

func (c *countingTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	c.count.Add(1)
	return c.next.RoundTrip(r)
}

func startProxy(t *testing.T, cfg BuildProxyConfig) *BuildProxy {
	t.Helper()
	proxy, err := StartBuildProxy(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = proxy.Close(t.Context()) })
	return proxy
}

func send(t *testing.T, method, url string, body []byte, headers map[string]string) (int, []byte, http.Header) {
	t.Helper()
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	request, err := http.NewRequestWithContext(t.Context(), method, url, reader)
	if err != nil {
		t.Fatal(err)
	}
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close() //nolint:errcheck // read-only body
	got, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response.StatusCode, got, response.Header
}

// turbo is how the job's turbo calls the proxy: the placeholder token from
// the environment the guest hands it.
var turbo = map[string]string{"Authorization": "Bearer " + TurboToken}

func TestBuildProxyEnvironmentCarriesNoCredential(t *testing.T) {
	service := cachetest.Start(t, cachetest.Options{})
	bearer := service.PushJob("acme/web", "refs/heads/main")
	proxy := startProxy(t, BuildProxyConfig{CacheServiceURL: service.URL, RunnerToken: bearer})
	env := strings.Join(proxy.Env(), "\n")
	for _, want := range []string{
		"TURBO_API=" + proxy.URL(), "TURBO_TOKEN=" + TurboToken, "TURBO_TEAM=" + TurboTeam,
		"ERAINFRA_BUILD_CACHE_URL=" + proxy.URL(),
	} {
		if !strings.Contains(env, want) {
			t.Errorf("Env() lacks %q:\n%s", want, env)
		}
	}
	if strings.Contains(env, bearer) {
		t.Fatal("the runner bearer is in the job's environment")
	}
	if !strings.HasPrefix(proxy.URL(), "http://127.0.0.1:") {
		t.Fatalf("the proxy listens on %s, want guest loopback", proxy.URL())
	}
}

// The proxy is the job's only way in, and it presents the runner bearer: an
// artifact turbo uploads under the placeholder token is filed under the
// runner's repository and found again by the next job of that repository.
func TestBuildProxyCarriesTurboToTheCacheServiceAsTheRunner(t *testing.T) {
	service := cachetest.Start(t, cachetest.Options{})
	first := startProxy(t, BuildProxyConfig{CacheServiceURL: service.URL, RunnerToken: service.PushJob("acme/web", "refs/heads/main"), Arch: "amd64"})
	artifact := []byte("compressed task outputs")
	status, body, _ := send(t, http.MethodPut, first.URL()+"/v8/artifacts/0abc?slug="+TurboTeam, artifact,
		map[string]string{"Authorization": turbo["Authorization"], "x-artifact-duration": "88", "Content-Type": "application/octet-stream"})
	if status != http.StatusAccepted {
		t.Fatalf("upload through the proxy = %d %s", status, body)
	}

	// A later job of the same repository, on a new runner.
	second := startProxy(t, BuildProxyConfig{CacheServiceURL: service.URL, RunnerToken: service.PushJob("acme/web", "refs/heads/main"), Arch: "amd64"})
	status, body, headers := send(t, http.MethodGet, second.URL()+"/v8/artifacts/0abc?slug="+TurboTeam, nil, turbo)
	if status != http.StatusOK || !bytes.Equal(body, artifact) || headers.Get("x-artifact-duration") != "88" {
		t.Fatalf("download through the proxy = %d %q %v", status, body, headers)
	}
	status, _, headers = send(t, http.MethodHead, second.URL()+"/v8/artifacts/0abc", nil, turbo)
	if status != http.StatusOK || headers.Get("Content-Length") != fmt.Sprint(len(artifact)) {
		t.Fatalf("exists through the proxy = %d, Content-Length %s", status, headers.Get("Content-Length"))
	}
	status, body, _ = send(t, http.MethodGet, second.URL()+"/v8/artifacts/status", nil, turbo)
	if status != http.StatusOK || !strings.Contains(string(body), `"enabled"`) {
		t.Fatalf("status through the proxy = %d %s", status, body)
	}

	// Another repository's job sees none of it.
	other := startProxy(t, BuildProxyConfig{CacheServiceURL: service.URL, RunnerToken: service.PushJob("acme/api", "refs/heads/main"), Arch: "amd64"})
	if status, _, _ := send(t, http.MethodGet, other.URL()+"/v8/artifacts/0abc", nil, turbo); status != http.StatusNotFound {
		t.Fatalf("another repository's job read the artifact: %d", status)
	}
}

// The architecture is the guest's, not the client's: a client header cannot
// file outputs under another architecture or read another's.
func TestBuildProxyStampsTheGuestArchitecture(t *testing.T) {
	service := cachetest.Start(t, cachetest.Options{})
	amd64 := startProxy(t, BuildProxyConfig{CacheServiceURL: service.URL, RunnerToken: service.PushJob("acme/web", "refs/heads/main"), Arch: "amd64"})
	arm64 := startProxy(t, BuildProxyConfig{CacheServiceURL: service.URL, RunnerToken: service.PushJob("acme/web", "refs/heads/main"), Arch: "arm64"})
	headers := map[string]string{"Authorization": turbo["Authorization"], buildArchHeader: "arm64"}
	if status, body, _ := send(t, http.MethodPut, amd64.URL()+"/v8/artifacts/00aa", []byte("x86"), headers); status != http.StatusAccepted {
		t.Fatalf("upload = %d %s", status, body)
	}
	if status, _, _ := send(t, http.MethodGet, arm64.URL()+"/v8/artifacts/00aa", nil, turbo); status != http.StatusNotFound {
		t.Fatalf("an arm64 guest read an artifact an amd64 guest uploaded claiming arm64: %d", status)
	}
	if status, _, _ := send(t, http.MethodGet, amd64.URL()+"/v8/artifacts/00aa", nil, turbo); status != http.StatusOK {
		t.Fatalf("the amd64 guest's own read = %d", status)
	}
}

// A workflow that set its own TURBO_TOKEN meant its own remote cache. Its
// request goes to Vercel as it was, and its token never reaches the cache
// service.
func TestBuildProxyForwardsAWorkflowsOwnTokenToVercel(t *testing.T) {
	var gotPath, gotAuth string
	vercel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotAuth = r.URL.RequestURI(), r.Header.Get("Authorization")
		w.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(vercel.Close)
	service := cachetest.Start(t, cachetest.Options{})
	cache := &countingTransport{next: http.DefaultTransport}
	log := &lines{}
	proxy := startProxy(t, BuildProxyConfig{
		CacheServiceURL: service.URL, RunnerToken: service.PushJob("acme/web", "refs/heads/main"),
		Transport: cache, VercelURL: vercel.URL + "/api", Logf: log.logf,
	})
	status, _, _ := send(t, http.MethodGet, proxy.URL()+"/v8/artifacts/ffee?teamId=team_123", nil,
		map[string]string{"Authorization": "Bearer vercel-user-token"})
	if status != http.StatusNotFound || gotPath != "/api/v8/artifacts/ffee?teamId=team_123" || gotAuth != "Bearer vercel-user-token" {
		t.Fatalf("forwarded to Vercel as %d %q with %q", status, gotPath, gotAuth)
	}
	if cache.count.Load() != 0 {
		t.Fatal("a request carrying the workflow's own token reached the cache service")
	}
	if len(log.snapshot()) != 1 {
		t.Fatalf("log = %q, want one line", log.snapshot())
	}
}

// A fork's pull request reads the base branch's artifacts. Its uploads are
// refused by the cache service once, and from then on dropped in the guest
// without being sent, so turbo prints nothing and the job uploads nothing.
func TestBuildProxyDropsAReadOnlyJobsUploadsQuietly(t *testing.T) {
	service := cachetest.Start(t, cachetest.Options{})
	trusted := startProxy(t, BuildProxyConfig{CacheServiceURL: service.URL, RunnerToken: service.PushJob("acme/web", "refs/heads/main")})
	if status, _, _ := send(t, http.MethodPut, trusted.URL()+"/v8/artifacts/0001", []byte("main output"), turbo); status != http.StatusAccepted {
		t.Fatalf("trusted upload = %d", status)
	}

	forkBearer := service.RunnerToken(cachetoken.JobFacts{
		Repository: "acme/web", HeadRepository: "stranger/web", Event: "pull_request",
		Ref: "refs/pull/3/merge", BaseRef: "refs/heads/main", DefaultBranch: "refs/heads/main",
	})
	cache := &countingTransport{next: http.DefaultTransport}
	log := &lines{}
	fork := startProxy(t, BuildProxyConfig{CacheServiceURL: service.URL, RunnerToken: forkBearer, Transport: cache, Logf: log.logf})

	if status, body, _ := send(t, http.MethodGet, fork.URL()+"/v8/artifacts/0001", nil, turbo); status != http.StatusOK || string(body) != "main output" {
		t.Fatalf("fork read of the base branch = %d %q", status, body)
	}
	for i := range 3 {
		status, body, _ := send(t, http.MethodPut, fork.URL()+fmt.Sprintf("/v8/artifacts/0f0%d", i), []byte("fork output"), turbo)
		if status != http.StatusAccepted || string(body) != `{"urls":[]}` {
			t.Fatalf("fork upload %d = %d %s, want a quiet 202", i, status, body)
		}
	}
	// One read and one refused upload reached the service; the next two
	// uploads never left the guest.
	if got := cache.count.Load(); got != 2 {
		t.Fatalf("%d requests reached the cache service, want 2", got)
	}
	if status, _, _ := send(t, http.MethodGet, trusted.URL()+"/v8/artifacts/0f00", nil, turbo); status != http.StatusNotFound {
		t.Fatalf("a fork upload was stored: %d", status)
	}
	if got := log.snapshot(); len(got) != 1 || !strings.Contains(got[0], "may read the cache but not write") {
		t.Fatalf("log = %q, want one line about the read-only job", got)
	}
}

// When the cache service cannot be reached, turbo gets the answers of a cache
// that is switched off, the proxy logs one line, and during the cooldown it
// does not dial again.
func TestBuildProxyFailsOpenWhenTheCacheServiceIsUnreachable(t *testing.T) {
	listener, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	deadURL := "http://" + listener.Addr().String()
	_ = listener.Close()

	cache := &countingTransport{next: buildTransport()}
	log := &lines{}
	proxy := startProxy(t, BuildProxyConfig{CacheServiceURL: deadURL, RunnerToken: "erainfra-cache-runner-v1.x.y", Transport: cache, Logf: log.logf})

	cases := []struct {
		method, path string
		body         []byte
		status       int
		contains     string
	}{
		{http.MethodGet, "/v8/artifacts/status", nil, http.StatusOK, `"disabled"`},
		{http.MethodGet, "/v8/artifacts/abcd", nil, http.StatusNotFound, ""},
		{http.MethodHead, "/v8/artifacts/abcd", nil, http.StatusNotFound, ""},
		{http.MethodPut, "/v8/artifacts/abcd", []byte("outputs"), http.StatusAccepted, `"urls"`},
		{http.MethodPost, "/v8/artifacts/events", []byte(`[]`), http.StatusOK, ""},
		{http.MethodPost, "/v8/artifacts", []byte(`{"hashes":["abcd"]}`), http.StatusOK, "{}"},
		{http.MethodGet, "/go/" + strings.Repeat("a", 64), nil, http.StatusBadGateway, ""},
	}
	for _, tc := range cases {
		status, body, _ := send(t, tc.method, proxy.URL()+tc.path, tc.body, turbo)
		if status != tc.status || !strings.Contains(string(body), tc.contains) {
			t.Errorf("%s %s = %d %s, want %d containing %q", tc.method, tc.path, status, body, tc.status, tc.contains)
		}
	}
	if got := cache.count.Load(); got != 1 {
		t.Fatalf("the proxy dialled the dead service %d times in its cooldown, want once", got)
	}
	if got := log.snapshot(); len(got) != 1 || !strings.Contains(got[0], "unreachable") {
		t.Fatalf("log = %q, want one line", got)
	}
}

// A service that answers again is used again once the cooldown has passed,
// and the proxy says so.
func TestBuildProxyRecoversAfterTheCooldown(t *testing.T) {
	service := cachetest.Start(t, cachetest.Options{})
	var broken atomic.Bool
	broken.Store(true)
	flaky := roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if broken.Load() {
			return nil, errors.New("connection refused")
		}
		return http.DefaultTransport.RoundTrip(r)
	})
	var clock atomic.Int64
	clock.Store(time.Date(2026, 11, 6, 0, 0, 0, 0, time.UTC).UnixNano())
	log := &lines{}
	proxy := startProxy(t, BuildProxyConfig{
		CacheServiceURL: service.URL, RunnerToken: service.PushJob("acme/web", "refs/heads/main"),
		Transport: flaky, Logf: log.logf, Now: func() time.Time { return time.Unix(0, clock.Load()) },
	})
	if status, _, _ := send(t, http.MethodGet, proxy.URL()+"/v8/artifacts/status", nil, turbo); status != http.StatusOK {
		t.Fatalf("status while down = %d", status)
	}
	broken.Store(false)
	clock.Add(int64(buildCooldown + time.Second))
	status, body, _ := send(t, http.MethodGet, proxy.URL()+"/v8/artifacts/status", nil, turbo)
	if status != http.StatusOK || !strings.Contains(string(body), "enabled") {
		t.Fatalf("status after recovery = %d %s", status, body)
	}
	if got := log.snapshot(); len(got) != 2 || !strings.Contains(got[1], "answers again") {
		t.Fatalf("log = %q", got)
	}
}

// A runner the service has no facts for yet is answered as a switched-off
// cache too, never with turbo's "check TURBO_TOKEN" advice: the job's token is
// not the problem.
func TestBuildProxyTurnsAnUnknownRunnerIntoAMiss(t *testing.T) {
	service := cachetest.Start(t, cachetest.Options{})
	log := &lines{}
	proxy := startProxy(t, BuildProxyConfig{CacheServiceURL: service.URL, RunnerToken: "erainfra-cache-runner-v1.e30.AAAA", Logf: log.logf})
	if status, body, _ := send(t, http.MethodGet, proxy.URL()+"/v8/artifacts/status", nil, turbo); status != http.StatusOK || !strings.Contains(string(body), "disabled") {
		t.Fatalf("status = %d %s", status, body)
	}
	if status, _, _ := send(t, http.MethodGet, proxy.URL()+"/v8/artifacts/aa", nil, turbo); status != http.StatusNotFound {
		t.Fatalf("read = %d, want a miss", status)
	}
	if status, _, _ := send(t, http.MethodPut, proxy.URL()+"/v8/artifacts/aa", []byte("x"), turbo); status != http.StatusAccepted {
		t.Fatalf("upload = %d, want a quiet 202", status)
	}
	if got := log.snapshot(); len(got) != 1 || !strings.Contains(got[0], "401") {
		t.Fatalf("log = %q, want one line naming the 401", got)
	}
}

// The Go helper's requests pass through with the runner bearer, and its
// errors are its own to handle.
func TestBuildProxyPassesGoRequestsThrough(t *testing.T) {
	service := cachetest.Start(t, cachetest.Options{})
	proxy := startProxy(t, BuildProxyConfig{CacheServiceURL: service.URL, RunnerToken: service.PushJob("acme/web", "refs/heads/main")})
	body := []byte("object file")
	sum := sha256.Sum256(body)
	output := hex.EncodeToString(sum[:])
	action := strings.Repeat("b", 64)
	if status, got, _ := send(t, http.MethodPut, proxy.URL()+"/go/"+action, body, map[string]string{"X-Erainfra-Go-Output-Id": output}); status != http.StatusNoContent {
		t.Fatalf("put = %d %s", status, got)
	}
	status, got, headers := send(t, http.MethodGet, proxy.URL()+"/go/"+action, nil, nil)
	if status != http.StatusOK || !bytes.Equal(got, body) || headers.Get("X-Erainfra-Go-Output-Id") != output {
		t.Fatalf("get = %d %q %v", status, got, headers)
	}
	if status, _, _ := send(t, http.MethodGet, proxy.URL()+"/elsewhere", nil, nil); status != http.StatusNotFound {
		t.Fatalf("an unknown path = %d, want 404", status)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
