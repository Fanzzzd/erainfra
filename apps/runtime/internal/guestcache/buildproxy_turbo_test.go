package guestcache

import (
	"bytes"
	"context"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/Fanzzzd/erainfra/apps/cache-service/cachetest"
	"github.com/Fanzzzd/erainfra/apps/cache-service/cachetoken"
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
