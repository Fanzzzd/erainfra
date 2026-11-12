package guestcache

import (
	"bytes"
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"

	"github.com/Fanzzzd/erainfra/apps/cache-service/cachetest"
	"github.com/Fanzzzd/erainfra/internal/cachetoken"
)

// findTurbo returns a real turbo binary: ERAINFRA_TEST_TURBO if set, else the
// repository's own node_modules/.bin/turbo (present after pnpm install, which
// CI runs before go test). turbo runs each task through npm, so npm has to be
// on PATH as well.
func findTurbo(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("npm"); err != nil {
		t.Skip("npm is not on PATH; turbo runs tasks through it")
	}
	if path := os.Getenv("ERAINFRA_TEST_TURBO"); path != "" {
		return path
	}
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		candidate := filepath.Join(dir, "node_modules", ".bin", "turbo")
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Skip("no turbo binary: run pnpm install, or set ERAINFRA_TEST_TURBO")
		}
		dir = parent
	}
}

// writeWorkspace lays out an npm workspace of five packages, each with a
// build task whose output turbo caches. changed alters one package's source,
// which changes that task's hash and nothing else.
func writeWorkspace(t *testing.T, changed bool) string {
	t.Helper()
	dir := t.TempDir()
	names := []string{"a", "b", "c", "d", "e"}
	lock := `{"name":"root","lockfileVersion":3,"requires":true,"packages":{"":{"name":"root","workspaces":["packages/*"]}`
	files := map[string]string{
		"package.json": `{"name":"root","private":true,"packageManager":"npm@10.9.2","workspaces":["packages/*"]}`,
		"turbo.json":   `{"tasks":{"build":{"outputs":["dist/**"]}}}`,
	}
	for _, name := range names {
		files["packages/"+name+"/package.json"] = `{"name":"` + name + `","version":"1.0.0","scripts":{"build":"node build.js"}}`
		source := "const fs = require('fs'); fs.mkdirSync('dist', {recursive: true}); fs.writeFileSync('dist/out.txt', 'built " + name + "'); console.log('compiled " + name + "');\n"
		if changed && name == "a" {
			source += "// changed\n"
		}
		files["packages/"+name+"/build.js"] = source
		lock += `,"node_modules/` + name + `":{"resolved":"packages/` + name + `","link":true},"packages/` + name + `":{"name":"` + name + `","version":"1.0.0"}`
	}
	files["package-lock.json"] = lock + "}}"
	for name, body := range files {
		path := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

var cachedPattern = regexp.MustCompile(`Cached:\s+(\d+) cached, (\d+) total`)

// turboJob runs `turbo run build` the way a job does on a fresh microVM: a
// new checkout with an empty local cache, and the environment the guest
// hands the runner, which is the proxy's Env() and nothing from the workflow.
func turboJob(t *testing.T, turbo, workspace string, env []string) (cached string, warnings []string, output string) {
	t.Helper()
	cmd := exec.CommandContext(t.Context(), turbo, "run", "build", "--ui=stream")
	cmd.Dir = workspace
	cmd.Env = append([]string{
		"PATH=" + os.Getenv("PATH"),
		"HOME=" + t.TempDir(),
		// No network beyond the proxy: no telemetry, no update check.
		"TURBO_TELEMETRY_DISABLED=1",
		"DO_NOT_TRACK=1",
		"TURBO_NO_UPDATE_NOTIFIER=1",
		"NO_COLOR=1",
	}, env...)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	if err := cmd.Run(); err != nil {
		t.Fatalf("turbo run failed: %v\n%s", err, out.String())
	}
	output = out.String()
	match := cachedPattern.FindStringSubmatch(output)
	if match == nil {
		t.Fatalf("no cache summary in turbo's output:\n%s", output)
	}
	for _, line := range strings.Split(output, "\n") {
		// This one is about where turbo itself was installed, not the cache.
		if strings.Contains(line, "WARNING") && !strings.Contains(line, "locally installed") {
			warnings = append(warnings, strings.TrimSpace(line))
		}
	}
	return match[1] + "/" + match[2], warnings, output
}

// The real turbo binary, with only the environment the guest provides, against
// the real build cache proxy and cache service.
func TestRealTurboUsesTheCacheWithNoWorkflowConfig(t *testing.T) {
	if testing.Short() {
		t.Skip("runs turbo six times")
	}
	turbo := findTurbo(t)
	service := cachetest.Start(t, cachetest.Options{})
	job := func(bearer string) []string {
		proxy, err := StartBuildProxy(BuildProxyConfig{CacheServiceURL: service.URL, RunnerToken: bearer})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = proxy.Close(context.Background()) })
		return proxy.Env()
	}

	// A push to main builds everything and uploads it.
	cached, warnings, output := turboJob(t, turbo, writeWorkspace(t, false), job(service.PushJob("acme/web", "refs/heads/main")))
	if cached != "0/5" || len(warnings) != 0 || !strings.Contains(output, "Remote caching enabled") {
		t.Fatalf("first job: cached %s, warnings %q\n%s", cached, warnings, output)
	}
	if saved := service.Metric(`erainfra_cache_build_requests_total{system="turbo",outcome="saved"}`); saved != 5 {
		t.Fatalf("the cache service saved %d artifacts, want 5", saved)
	}

	// The next job of the same repository, on a new machine, replays all five
	// and restores their outputs.
	workspace := writeWorkspace(t, false)
	cached, warnings, output = turboJob(t, turbo, workspace, job(service.PushJob("acme/web", "refs/heads/main")))
	if cached != "5/5" || len(warnings) != 0 {
		t.Fatalf("second job: cached %s, warnings %q\n%s", cached, warnings, output)
	}
	if restored, err := os.ReadFile(filepath.Join(workspace, "packages", "c", "dist", "out.txt")); err != nil || string(restored) != "built c" {
		t.Fatalf("a remote hit did not restore the task's outputs: %q, %v", restored, err)
	}

	// Another repository gets nothing from it.
	cached, _, output = turboJob(t, turbo, writeWorkspace(t, false), job(service.PushJob("acme/other", "refs/heads/main")))
	if cached != "0/5" {
		t.Fatalf("another repository's job: cached %s\n%s", cached, output)
	}

	// A fork's pull request with one package changed reads the other four
	// from main, and its upload of the fifth is dropped without a word.
	fork := service.RunnerToken(cachetoken.JobFacts{
		Repository: "acme/web", HeadRepository: "stranger/web", Event: "pull_request",
		Ref: "refs/pull/5/merge", BaseRef: "refs/heads/main", DefaultBranch: "refs/heads/main",
	})
	cached, warnings, output = turboJob(t, turbo, writeWorkspace(t, true), job(fork))
	if cached != "4/5" || len(warnings) != 0 {
		t.Fatalf("fork job: cached %s, warnings %q\n%s", cached, warnings, output)
	}
	// So main, building the same change, finds nothing the fork left behind.
	cached, _, output = turboJob(t, turbo, writeWorkspace(t, true), job(service.PushJob("acme/web", "refs/heads/main")))
	if cached != "4/5" {
		t.Fatalf("the fork's refused upload was stored: main's job cached %s\n%s", cached, output)
	}

	// With the cache service gone, the build runs uncached and turbo prints
	// one line about it.
	listener, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	dead := "http://" + listener.Addr().String()
	_ = listener.Close()
	proxy, err := StartBuildProxy(BuildProxyConfig{CacheServiceURL: dead, RunnerToken: "erainfra-cache-runner-v1.x.y"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = proxy.Close(context.Background()) })
	cached, warnings, output = turboJob(t, turbo, writeWorkspace(t, false), proxy.Env())
	if cached != "0/5" || len(warnings) != 1 || !strings.Contains(warnings[0], "Remote caching unavailable") {
		t.Fatalf("job with the cache down: cached %s, warnings %q\n%s", cached, warnings, output)
	}
}

// remoteCacheRecorder is a repository's own Turborepo remote cache: it records
// every request and the token it carried, and answers enabled but empty.
type remoteCacheRecorder struct {
	*httptest.Server
	mu   sync.Mutex
	seen []string
}

func startRemoteCacheRecorder(t *testing.T) *remoteCacheRecorder {
	t.Helper()
	recorder := &remoteCacheRecorder{}
	recorder.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		recorder.mu.Lock()
		recorder.seen = append(recorder.seen, r.Method+" "+r.URL.Path+" "+r.Header.Get("Authorization"))
		recorder.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/v8/artifacts/status":
			_, _ = io.WriteString(w, `{"status":"enabled"}`)
		case r.Method == http.MethodPut:
			_, _ = io.Copy(io.Discard, r.Body)
			w.WriteHeader(http.StatusAccepted)
			_, _ = io.WriteString(w, `{"urls":[]}`)
		default:
			w.WriteHeader(http.StatusNotFound)
			_, _ = io.WriteString(w, `{"code":"not_found","message":"artifact not found"}`)
		}
	}))
	t.Cleanup(recorder.Close)
	return recorder
}

func (r *remoteCacheRecorder) requests() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.seen...)
}

// withOwnRemoteCache writes a workspace whose turbo.json names the
// repository's own remote cache, as a repository that runs one does.
func withOwnRemoteCache(t *testing.T, apiURL string) string {
	t.Helper()
	workspace := writeWorkspace(t, false)
	turboJSON := `{"remoteCache":{"apiUrl":"` + apiURL + `","teamId":"team_own"},"tasks":{"build":{"outputs":["dist/**"]}}}`
	if err := os.WriteFile(filepath.Join(workspace, "turbo.json"), []byte(turboJSON), 0o644); err != nil {
		t.Fatal(err)
	}
	return workspace
}

// A repository names its own remote cache in turbo.json and passes its token
// in the workflow env. turbo ranks the guest's TURBO_API above turbo.json, so
// the token arrives at the proxy, which used to forward it to Vercel, a host
// the workflow never named. Now it leaves the guest for nowhere: the job log
// has one warning pointing at TURBO_TOKEN, the guest journal one line saying
// to set TURBO_API, and the build runs uncached.
func TestRealTurboNeverSendsAWorkflowsOwnTokenAnywhere(t *testing.T) {
	turbo := findTurbo(t)
	service := cachetest.Start(t, cachetest.Options{})
	own := startRemoteCacheRecorder(t)

	var mu sync.Mutex
	var outbound []string
	recording := roundTripFunc(func(r *http.Request) (*http.Response, error) {
		mu.Lock()
		outbound = append(outbound, r.Method+" "+r.URL.String()+" "+r.Header.Get("Authorization"))
		mu.Unlock()
		return http.DefaultTransport.RoundTrip(r)
	})
	log := &lines{}
	proxy, err := StartBuildProxy(BuildProxyConfig{
		CacheServiceURL: service.URL, RunnerToken: service.PushJob("acme/web", "refs/heads/main"),
		Transport: recording, Logf: log.logf,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = proxy.Close(context.Background()) })

	// The runner's environment first, then the step's, which wins.
	env := append(proxy.Env(), "TURBO_TOKEN=own-secret-token", "TURBO_TEAM=own")
	cached, warnings, output := turboJob(t, turbo, withOwnRemoteCache(t, own.URL), env)
	if cached != "0/5" || len(warnings) != 1 || !strings.Contains(warnings[0], "check TURBO_TOKEN") {
		t.Fatalf("cached %s, warnings %q, want 0/5 and one warning about TURBO_TOKEN\n%s", cached, warnings, output)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(outbound) != 0 {
		t.Fatalf("the proxy sent requests on with the workflow's token: %q", outbound)
	}
	if got := log.snapshot(); len(got) != 1 || !strings.Contains(got[0], "set TURBO_API") {
		t.Fatalf("guest log = %q, want one line saying to set TURBO_API", got)
	}
	// turbo.json's apiUrl is shadowed. If a turbo release ranks turbo.json
	// above TURBO_API, this fails, and the precedence docs/job-cache.md and the
	// runbook describe has to be measured again.
	if got := own.requests(); len(got) != 0 {
		t.Fatalf("turbo.json's own remote cache was used despite the guest's TURBO_API: %q", got)
	}
}

// The remedy the proxy's log line names: with TURBO_API in the workflow's env,
// turbo talks to the repository's own cache with its own token, and the proxy
// sees nothing.
func TestRealTurboUsesAWorkflowsOwnCacheWhenItSetsTURBO_API(t *testing.T) {
	turbo := findTurbo(t)
	service := cachetest.Start(t, cachetest.Options{})
	own := startRemoteCacheRecorder(t)
	cache := &countingTransport{next: http.DefaultTransport}
	log := &lines{}
	proxy, err := StartBuildProxy(BuildProxyConfig{
		CacheServiceURL: service.URL, RunnerToken: service.PushJob("acme/web", "refs/heads/main"),
		Transport: cache, Logf: log.logf,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = proxy.Close(context.Background()) })

	env := append(proxy.Env(), "TURBO_API="+own.URL, "TURBO_TOKEN=own-secret-token", "TURBO_TEAM=own")
	cached, warnings, output := turboJob(t, turbo, withOwnRemoteCache(t, own.URL), env)
	if cached != "0/5" || len(warnings) != 0 {
		t.Fatalf("cached %s, warnings %q\n%s", cached, warnings, output)
	}
	got := own.requests()
	uploads := 0
	for _, request := range got {
		if !strings.HasSuffix(request, " Bearer own-secret-token") {
			t.Fatalf("the repository's cache got a request without its token: %q", request)
		}
		if strings.HasPrefix(request, "PUT ") {
			uploads++
		}
	}
	if uploads != 5 {
		t.Fatalf("the repository's cache got %d uploads, want 5: %q", uploads, got)
	}
	if cache.count.Load() != 0 || len(log.snapshot()) != 0 {
		t.Fatalf("the proxy was involved: %d requests to the cache service, log %q", cache.count.Load(), log.snapshot())
	}
}
