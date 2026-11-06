package gocacheprog

import (
	"bytes"
	"context"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"testing"

	"github.com/Fanzzzd/erainfra/apps/cache-service/cachetest"
	"github.com/Fanzzzd/erainfra/apps/runtime/internal/guestcache"
)

// helperEnv makes this test binary act as erainfra-gocacheprog, so cmd/go can
// run it as GOCACHEPROG with exactly the code under test and no separate build.
const helperEnv = "ERAINFRA_GOCACHEPROG_TEST_AS_HELPER"

func TestMain(m *testing.M) {
	if os.Getenv(helperEnv) == "1" {
		cfg, err := ConfigFromEnv(os.Getenv)
		if err != nil {
			_, _ = os.Stderr.WriteString("erainfra-gocacheprog: " + err.Error() + "\n")
			os.Exit(1)
		}
		cfg.Stderr = os.Stderr
		if err := Run(context.Background(), cfg, os.Stdin, os.Stdout); err != nil {
			_, _ = os.Stderr.WriteString("erainfra-gocacheprog: " + err.Error() + "\n")
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// module is a small program with one local package, so a build compiles the
// standard library packages it needs, the package and the command.
func writeModule(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	files := map[string]string{
		"go.mod":         "module example.com/hello\n\ngo 1.24\n",
		"greet/greet.go": "package greet\n\nimport \"strings\"\n\nfunc Hello(name string) string { return \"hello, \" + strings.ToUpper(name) }\n",
		"main.go":        "package main\n\nimport (\n\t\"fmt\"\n\n\t\"example.com/hello/greet\"\n)\n\nfunc main() { fmt.Println(greet.Hello(\"erainfra\")) }\n",
	}
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

var summaryPattern = regexp.MustCompile(`erainfra-gocacheprog: (\d+) local hits, (\d+) remote hits, (\d+) misses, (\d+) uploaded`)

type buildRun struct {
	local, remote, misses, uploaded int
	stderr                          string
}

// goBuild runs the real `go build` as one job would: a fresh GOCACHE (a new
// microVM), GOCACHEPROG set by the one workflow line, and the guest's
// ERAINFRA_BUILD_CACHE_URL pointing at the build cache proxy.
func goBuild(t *testing.T, module, proxyURL string) buildRun {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	// go test builds this binary and runs it in place, so the GOROOT it was
	// built with is the toolchain running the test, whatever go is on PATH.
	goTool := filepath.Join(runtime.GOROOT(), "bin", "go") //nolint:staticcheck // see above
	cmd := exec.CommandContext(t.Context(), goTool, "build", "-o", filepath.Join(t.TempDir(), "hello"), ".")
	cmd.Dir = module
	cmd.Env = []string{
		"PATH=" + os.Getenv("PATH"),
		"HOME=" + t.TempDir(),
		"GOCACHE=" + t.TempDir(),
		"GOPATH=" + t.TempDir(),
		"GOCACHEPROG=" + self,
		helperEnv + "=1",
		"ERAINFRA_BUILD_CACHE_URL=" + proxyURL,
		"ERAINFRA_GOCACHEPROG_VERBOSE=1",
		"GOTOOLCHAIN=local",
		"GOFLAGS=-mod=mod",
		"GOPROXY=off",
		"GOWORK=off",
		"CGO_ENABLED=0",
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("go build failed: %v\n%s", err, stderr.String())
	}
	match := summaryPattern.FindStringSubmatch(stderr.String())
	if match == nil {
		t.Fatalf("no helper summary in:\n%s", stderr.String())
	}
	number := func(i int) int {
		n, _ := strconv.Atoi(match[i])
		return n
	}
	return buildRun{local: number(1), remote: number(2), misses: number(3), uploaded: number(4), stderr: stderr.String()}
}

// The real go command, GOCACHEPROG pointed at the helper, the real build cache
// proxy and the real cache service: a second job of the same repository on a
// fresh machine compiles nothing, a job of another repository gets nothing,
// and a job whose cache is down builds anyway with one line of warning.
func TestRealGoBuildSharesItsCacheAcrossJobsOfOneRepository(t *testing.T) {
	if testing.Short() {
		t.Skip("compiles a program four times")
	}
	service := cachetest.Start(t, cachetest.Options{})
	module := writeModule(t)
	proxy := func(repository string) string {
		p, err := guestcache.StartBuildProxy(guestcache.BuildProxyConfig{
			CacheServiceURL: service.URL, RunnerToken: service.PushJob(repository, "refs/heads/main"),
		})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = p.Close(context.Background()) })
		return p.URL()
	}

	first := goBuild(t, module, proxy("acme/hello"))
	if first.remote != 0 || first.misses == 0 || first.uploaded < first.misses {
		t.Fatalf("first job = %+v, want every lookup a miss and every output uploaded", first)
	}

	// A handful of lookups miss on every build (the link step's key covers
	// the output path, which is a fresh temporary directory here), so the bar
	// is that compiling is served remotely, not that the count is zero.
	second := goBuild(t, module, proxy("acme/hello"))
	if second.remote < first.misses || second.misses*10 > first.misses {
		t.Fatalf("second job = %+v, want the first job's %d compiled actions from the remote tier", second, first.misses)
	}
	if hits := service.Metric(`erainfra_cache_build_requests_total{system="go",outcome="hit"}`); hits != int64(second.remote) {
		t.Fatalf("the cache service counted %d hits, the helper %d", hits, second.remote)
	}

	other := goBuild(t, module, proxy("acme/other"))
	if other.remote != 0 {
		t.Fatalf("another repository's job got %d remote hits", other.remote)
	}

	listener, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	dead := "http://" + listener.Addr().String()
	_ = listener.Close()
	down := goBuild(t, module, dead)
	var warnings []string
	for _, line := range strings.Split(strings.TrimSpace(down.stderr), "\n") {
		if strings.HasPrefix(line, "erainfra-gocacheprog:") && !summaryPattern.MatchString(line) {
			warnings = append(warnings, line)
		}
	}
	if len(warnings) != 1 || down.remote != 0 {
		t.Fatalf("a build with the cache down printed %q and got %d remote hits; want one line and none", warnings, down.remote)
	}
}
