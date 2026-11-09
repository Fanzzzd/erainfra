//go:build linux

package main

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/guest"
)

func TestResolverConfigKeepsOnlyResolverDirectives(t *testing.T) {
	// The exact shape a Firecracker guest sees: the kernel's own comment line
	// first, then the nameservers the Profile's network policy named.
	published := "#MANUAL\nnameserver 1.1.1.1\nnameserver 9.9.9.9\n"
	config, err := resolverConfig([]byte(published))
	if err != nil {
		t.Fatalf("resolverConfig returned %v", err)
	}
	want := "nameserver 1.1.1.1\nnameserver 9.9.9.9\noptions edns0\n"
	if config != want {
		t.Fatalf("resolverConfig produced %q, want %q", config, want)
	}
}

func TestResolverConfigKeepsSearchAndDomain(t *testing.T) {
	config, err := resolverConfig([]byte("domain example.test\nsearch a.test b.test\nnameserver 10.0.0.53\n"))
	if err != nil {
		t.Fatalf("resolverConfig returned %v", err)
	}
	want := "domain example.test\nsearch a.test b.test\nnameserver 10.0.0.53\noptions edns0\n"
	if config != want {
		t.Fatalf("resolverConfig produced %q, want %q", config, want)
	}
}

// The options line is a decision, not something the kernel publication can
// carry: edns0 as ubuntu-latest has it, and never trust-ad, which would make
// glibc believe the AD bit from a resolver across the network.
func TestResolverConfigAsksForEDNS0AndNotTrustAD(t *testing.T) {
	config, err := resolverConfig([]byte("#MANUAL\nnameserver 1.1.1.1\n"))
	if err != nil {
		t.Fatalf("resolverConfig returned %v", err)
	}
	var options []string
	for _, line := range strings.Split(config, "\n") {
		if fields := strings.Fields(line); len(fields) > 0 && fields[0] == "options" {
			options = append(options, fields[1:]...)
		}
	}
	if strings.Join(options, " ") != "edns0" {
		t.Fatalf("resolverConfig options are %q, want exactly edns0 (config %q)", options, config)
	}
}

// A guest with no resolver cannot reach GitHub, a registry or a package mirror.
// Failing here is how that surfaces as an error instead of as a job that dies
// much later with an unexplained name resolution failure.
func TestResolverConfigRejectsAnEmptyPublication(t *testing.T) {
	if _, err := resolverConfig([]byte("#MANUAL\n")); err == nil {
		t.Fatal("resolverConfig accepted a publication with no resolver")
	}
}

func TestLoadRunnerEnvironmentMissingIsOptional(t *testing.T) {
	env, err := loadRunnerEnvironment(filepath.Join(t.TempDir(), "missing.json"))
	if err != nil || len(env) != 0 {
		t.Fatalf("missing image environment = %v, %v; want empty environment without error", env, err)
	}
	metadata := guest.Metadata{Kind: "ci", JITConfig: "runtime-secret"}
	got := runnerEnv(metadata, "/home/runner", "runner", "", nil, env)
	if want := runnerEnv(metadata, "/home/runner", "runner", "", nil, nil); !slices.Equal(got, want) {
		t.Fatalf("missing image environment changed runtime defaults: %q", got)
	}
}

func TestLoadRunnerEnvironmentRejectsInvalidInput(t *testing.T) {
	for name, data := range map[string]string{
		"empty file":            "",
		"malformed JSON":        `{"PATH":`,
		"null object":           `null`,
		"array":                 `[]`,
		"scalar":                `"PATH=/bin"`,
		"trailing JSON":         `{} {}`,
		"trailing garbage":      `{} trailing`,
		"number":                `{"JAVA_HOME":21}`,
		"boolean":               `{"JAVA_HOME":true}`,
		"null value":            `{"JAVA_HOME":null}`,
		"array value":           `{"JAVA_HOME":[]}`,
		"object value":          `{"JAVA_HOME":{}}`,
		"duplicate key":         `{"PATH":"/bin","PATH":"/other"}`,
		"NUL value":             `{"JAVA_HOME":"/jdk\u0000"}`,
		"newline value":         `{"JAVA_HOME":"/jdk\nLD_PRELOAD=/evil"}`,
		"carriage return value": `{"JAVA_HOME":"/jdk\r"}`,
		"empty PATH":            `{"PATH":""}`,
		"invalid UTF8":          "{\"JAVA_HOME\":\"\xff\"}",
	} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "runner-environment.json")
			if err := os.WriteFile(path, []byte(data), 0600); err != nil {
				t.Fatal(err)
			}
			if env, err := loadRunnerEnvironment(path); err == nil || env != nil {
				t.Fatalf("invalid image environment accepted: %v, %v", env, err)
			}
		})
	}
	// Missing is optional. Other read failures must not silently use defaults.
	if env, err := loadRunnerEnvironment(t.TempDir()); err == nil || env != nil {
		t.Fatalf("directory accepted as image environment: %v, %v", env, err)
	}
}

func TestLoadRunnerEnvironmentRejectsUnknownAndRuntimeKeys(t *testing.T) {
	for _, key := range []string{
		"UNKNOWN", "", "PATH=OTHER", "PATH\nOTHER", "path",
		"LD_PRELOAD", "LD_LIBRARY_PATH", "BASH_ENV", "ENV", "NODE_OPTIONS", "PYTHONPATH",
		"HOME", "USER", "LOGNAME", "LANG", "CARGO_HOME", "RUSTUP_HOME",
		"ACTIONS_RUNNER_INPUT_JITCONFIG", "ACTIONS_RUNNER_HOOK_JOB_STARTED",
		"ACTIONS_CACHE_URL", "ACTIONS_CACHE_SERVICE_V2", "ACTIONS_RUNTIME_TOKEN", "ACTIONS_RESULTS_URL",
		"NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE", "SSL_CERT_FILE",
		"TURBO_API", "TURBO_TOKEN", "TURBO_TEAM", "ERAINFRA_BUILD_CACHE_URL", "GOCACHEPROG",
		"JAVA_HOME_EVIL_X64", "JAVA_HOME_21_X64_EXTRA", "GOROOT_1_BAD_X64",
		"ANDROID_UNKNOWN", "PIPX_UNKNOWN", "DOTNET_STARTUP_HOOKS", "CHROME_UNKNOWN",
		"CHROMIUM_UNKNOWN", "EDGE_UNKNOWN", "HOMEBREW_UNKNOWN",
	} {
		t.Run(key, func(t *testing.T) {
			data, err := json.Marshal(map[string]string{key: "must-not-leak"})
			if err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(t.TempDir(), "runner-environment.json")
			if err := os.WriteFile(path, data, 0600); err != nil {
				t.Fatal(err)
			}
			if env, err := loadRunnerEnvironment(path); err == nil || env != nil {
				t.Fatalf("forbidden image key accepted: %v, %v", env, err)
			} else if strings.Contains(err.Error(), "must-not-leak") {
				t.Fatal("error disclosed an environment value")
			}
		})
	}
}

func TestRunnerEnvLoadsHostedImageEnvironment(t *testing.T) {
	t.Setenv("ERAINFRA_PARENT_SECRET", "must-not-leak")
	path := filepath.Join(t.TempDir(), "runner-environment.json")
	image := map[string]string{
		"PATH":                    "/home/runner/.cargo/bin:/opt/tools/bin:/usr/bin:/bin",
		"JAVA_HOME":               "/usr/lib/jvm/temurin-21-jdk-amd64",
		"JAVA_HOME_21_X64":        "/usr/lib/jvm/temurin-21-jdk-amd64",
		"GOROOT_1_27_X64":         "/opt/hostedtoolcache/go/1.27.3/x64",
		"NVM_DIR":                 "/home/runner/.nvm",
		"XDG_CONFIG_HOME":         "/home/runner/.config",
		"ImageOS":                 "ubuntu24",
		"ImageVersion":            "20261109.1",
		"ANDROID_HOME":            "/usr/local/lib/android/sdk",
		"ANDROID_SDK_ROOT":        "/usr/local/lib/android/sdk",
		"ANDROID_NDK":             "/usr/local/lib/android/sdk/ndk/27.3.13750724",
		"ANDROID_NDK_HOME":        "/usr/local/lib/android/sdk/ndk/27.3.13750724",
		"ANDROID_NDK_ROOT":        "/usr/local/lib/android/sdk/ndk/27.3.13750724",
		"ANDROID_NDK_LATEST_HOME": "/usr/local/lib/android/sdk/ndk/30.0.16248370",
		"PIPX_BIN_DIR":            "/opt/pipx_bin", "PIPX_HOME": "/opt/pipx",
		"DOTNET_SKIP_FIRST_TIME_EXPERIENCE": "1", "DOTNET_NOLOGO": "1", "DOTNET_MULTILEVEL_LOOKUP": "0",
		"CHROME_BIN": "/usr/bin/google-chrome", "CHROMEWEBDRIVER": "/usr/local/share/chromedriver-linux64",
		"EDGEWEBDRIVER": "/usr/local/share/edge_driver", "GECKOWEBDRIVER": "/usr/local/share/gecko_driver",
		"SELENIUM_JAR_PATH":       "/usr/share/java/selenium-server.jar",
		"VCPKG_INSTALLATION_ROOT": "/usr/local/share/vcpkg", "VCPKG_FORCE_SYSTEM_BINARIES": "1",
		"SWIFT_PATH": "/usr/share/swift/usr/bin", "GRADLE_HOME": "/usr/share/gradle-9.8.2", "ANT_HOME": "/usr/share/ant",
		"HOMEBREW_NO_AUTO_UPDATE": "1", "HOMEBREW_CLEANUP_PERIODIC_FULL_DAYS": "3650",
		"ACCEPT_EULA": "Y", "DEBIAN_FRONTEND": "noninteractive",
		"PSModulePath":                     "/root/.local/share/powershell/Modules:/usr/share/az_15.6.1",
		"AZURE_EXTENSION_DIR":              "/opt/az/azcliextensions",
		"BOOTSTRAP_HASKELL_NONINTERACTIVE": "1", "GHCUP_INSTALL_BASE_PREFIX": "/usr/local",
		"CONDA": "/usr/share/miniconda", "USE_BAZEL_FALLBACK_VERSION": "silent:",
		"LEIN_JAR": "/usr/local/lib/lein.jar", "LEIN_HOME": "/usr/local/lib/lein",
		"RUNNER_TOOL_CACHE":                   "/image/toolcache",
		"AGENT_TOOLSDIRECTORY":                "/image/toolcache",
		"ACTIONS_RUNNER_ACTION_ARCHIVE_CACHE": "/image/actions",
	}
	data, err := json.Marshal(image)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	loaded, err := loadRunnerEnvironment(path)
	if err != nil {
		t.Fatal(err)
	}
	// Startup owns the read. Constructing a command must not reread the file.
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	metadata := guest.Metadata{Kind: "ci", JITConfig: "runtime-secret", CacheURL: "https://cache.internal", CacheServiceV2: "true"}
	env := runnerEnv(metadata, "/home/runner", "runner", "/runtime/cache.crt", []string{"TURBO_TOKEN=runtime-token"}, loaded)
	if !slices.IsSorted(env) {
		t.Fatalf("environment is not sorted: %q", env)
	}
	if again := runnerEnv(metadata, "/home/runner", "runner", "/runtime/cache.crt", []string{"TURBO_TOKEN=runtime-token"}, loaded); !slices.Equal(env, again) {
		t.Fatal("environment is not deterministic")
	}
	command := exec.CommandContext(t.Context(), "/usr/bin/env")
	command.Env = env
	output, err := command.Output()
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, entry := range strings.Split(strings.TrimSuffix(string(output), "\n"), "\n") {
		key, value, ok := strings.Cut(entry, "=")
		if _, duplicate := got[key]; !ok || duplicate {
			t.Fatalf("malformed or duplicate environment entry %q", entry)
		}
		got[key] = value
	}
	want := map[string]string{
		"HOME": "/home/runner", "USER": "runner", "LOGNAME": "runner", "LANG": "C.UTF-8",
		"RUNNER_TOOL_CACHE": "/opt/hostedtoolcache", "AGENT_TOOLSDIRECTORY": "/opt/hostedtoolcache",
		"ACTIONS_RUNNER_ACTION_ARCHIVE_CACHE": "/opt/action-cache",
		"ACTIONS_RUNNER_INPUT_JITCONFIG":      "runtime-secret",
		"ACTIONS_CACHE_URL":                   "https://cache.internal", "ACTIONS_CACHE_SERVICE_V2": "true",
		"NODE_EXTRA_CA_CERTS": "/runtime/cache.crt", "TURBO_TOKEN": "runtime-token",
	}
	for key, value := range image {
		if _, runtimeControlled := want[key]; !runtimeControlled {
			want[key] = value
		}
	}
	for key, value := range want {
		if got[key] != value {
			t.Errorf("child environment %s = %q, want %q", key, got[key], value)
		}
	}
	for _, key := range []string{"ERAINFRA_PARENT_SECRET", "ACTIONS_RUNTIME_TOKEN", "ACTIONS_RESULTS_URL"} {
		if _, exists := got[key]; exists {
			t.Errorf("child inherited forbidden key %s", key)
		}
	}
	if loaded["RUNNER_TOOL_CACHE"] != "/image/toolcache" {
		t.Fatal("runnerEnv mutated the loaded image environment")
	}
}

func TestRunnerEnvIsADecisionATestCanRead(t *testing.T) {
	metadata := guest.Metadata{Kind: "ci", RunnerName: "rc-a", JITConfig: "secret"}
	env := runnerEnv(metadata, "/home/runner", "runner", "", nil, nil)

	want := map[string]string{
		"LANG":                           "C.UTF-8",
		"HOME":                           "/home/runner",
		"ACTIONS_RUNNER_INPUT_JITCONFIG": "secret",
		// The image's rustup, where ubuntu-latest keeps it.
		"CARGO_HOME":  "/home/runner/.cargo",
		"RUSTUP_HOME": "/home/runner/.rustup",
		"PATH":        "/home/runner/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
	}
	got := map[string]string{}
	for _, entry := range env {
		name, value, ok := strings.Cut(entry, "=")
		if !ok {
			t.Fatalf("malformed environment entry %q", entry)
		}
		got[name] = value
	}
	for name, value := range want {
		if got[name] != value {
			t.Fatalf("runner env %s = %q, want %q", name, got[name], value)
		}
	}
	for _, absent := range []string{"ACTIONS_CACHE_URL", "ACTIONS_CACHE_SERVICE_V2", "ACTIONS_RESULTS_URL", "ACTIONS_RUNTIME_TOKEN", "NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE", "SSL_CERT_FILE", "TURBO_API", "TURBO_TOKEN", "TURBO_TEAM", "ERAINFRA_BUILD_CACHE_URL", "GOCACHEPROG"} {
		if _, present := got[absent]; present {
			t.Fatalf("runner env carries %s with no cache endpoint configured", absent)
		}
	}

	metadata.CacheURL = "https://cache.internal:8080"
	metadata.CacheServiceV2 = "false"
	env = runnerEnv(metadata, "/home/runner", "runner", "", nil, nil)
	joined := strings.Join(env, "\n")
	if !strings.Contains(joined, "ACTIONS_CACHE_URL=https://cache.internal:8080") ||
		!strings.Contains(joined, "ACTIONS_CACHE_SERVICE_V2=false") {
		t.Fatalf("cache endpoint missing from runner env: %q", joined)
	}
	// Shared with the artifact service; writing them would break uploads (#106).
	if strings.Contains(joined, "ACTIONS_RESULTS_URL") || strings.Contains(joined, "ACTIONS_RUNTIME_TOKEN") {
		t.Fatalf("runner env must never carry the artifact-service pair: %q", joined)
	}
}

// A guest whose in-guest cache interceptor came up hands the runner the CA path
// as NODE_EXTRA_CA_CERTS: Node ships its own trust store, so without it the
// runner's cache client would reject the leaf the interceptor serves.
func TestRunnerEnvCarriesTheCacheTrustAnchorWhenRedirected(t *testing.T) {
	metadata := guest.Metadata{Kind: "ci", RunnerName: "rc-a", JITConfig: "secret"}

	env := runnerEnv(metadata, "/home/runner", "runner", "/usr/local/share/ca-certificates/erainfra-cache.crt", nil, nil)
	joined := strings.Join(env, "\n")
	for _, want := range []string{
		"NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/erainfra-cache.crt",
		// Python requests and httpx read certifi, not the system store; the
		// rebuilt system bundle is public roots plus the interceptor's CA.
		"REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt",
		"SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("redirected runner env missing %s: %q", want, joined)
		}
	}
}

// A guest whose build cache proxy came up hands the runner the proxy's
// environment: turbo's three variables and the Go helper's address.
// GOCACHEPROG itself is never set here; the Go helper is a workflow's
// one-line opt-in.
func TestRunnerEnvCarriesTheBuildCacheProxy(t *testing.T) {
	metadata := guest.Metadata{Kind: "ci", RunnerName: "rc-a", JITConfig: "secret"}
	build := []string{
		"TURBO_API=http://" + buildCacheAddr,
		"TURBO_TOKEN=erainfra-build-cache",
		"TURBO_TEAM=erainfra",
		"ERAINFRA_BUILD_CACHE_URL=http://" + buildCacheAddr,
	}
	joined := strings.Join(runnerEnv(metadata, "/home/runner", "runner", "", build, nil), "\n")
	for _, want := range build {
		if !strings.Contains(joined, want) {
			t.Fatalf("runner env missing %s: %q", want, joined)
		}
	}
	if strings.Contains(joined, "GOCACHEPROG") {
		t.Fatalf("the guest set GOCACHEPROG, which is the workflow's to opt into: %q", joined)
	}
	if !strings.HasPrefix(buildCacheAddr, "127.0.0.1:") {
		t.Fatalf("the build cache proxy listens on %s, want guest loopback only", buildCacheAddr)
	}
}

// The guest reports run.sh's status the way a shell would, so an operator
// reading "exited with code 143" knows the runner was sent SIGTERM.
func TestRunnerExitCodeReadsStatusAndSignal(t *testing.T) {
	for script, want := range map[string]int{
		"exit 0":        0,
		"exit 3":        3,
		"kill -TERM $$": 128 + 15,
	} {
		err := exec.CommandContext(t.Context(), "sh", "-c", script).Run()
		if got := runnerExitCode(err); got != want {
			t.Errorf("%q: runnerExitCode = %d, want %d", script, got, want)
		}
	}
	if got := runnerExitCode(errors.New("copying output failed")); got != 1 {
		t.Errorf("a Wait error that is no exit status: runnerExitCode = %d, want 1", got)
	}
}

// A container image ships an empty /etc/hosts (Docker fills it at run time), so
// a Firecracker guest built from one has no localhost entry unless the guest
// writes it: Node's dns.lookup("localhost") then fails with ENOTFOUND, which is
// what Plany's vitest hit on 2026-11-09.
func TestHostsEntriesAddLoopbackNamesToAnEmptyImageFile(t *testing.T) {
	got := hostsWithEntries(nil, "rc-erainfra-4vcpu-ubuntu-2404-be18f0a26c7f")
	want := "127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\n127.0.1.1\trc-erainfra-4vcpu-ubuntu-2404-be18f0a26c7f\n"
	if string(got) != want {
		t.Fatalf("hosts = %q, want %q", got, want)
	}
}

func TestHostsEntriesKeepAnImageThatAlreadyResolvesLocalhost(t *testing.T) {
	existing := "127.0.0.1 localhost\n::1 localhost ip6-localhost\n127.0.1.1\trunner-a\n"
	if got := hostsWithEntries([]byte(existing), "runner-a"); string(got) != existing {
		t.Fatalf("hosts = %q, want unchanged %q", got, existing)
	}
	// IPv4 present but no IPv6 loopback name: add only what is missing.
	got := string(hostsWithEntries([]byte("127.0.0.1 localhost"), "runner-b"))
	want := "127.0.0.1 localhost\n::1\tlocalhost ip6-localhost ip6-loopback\n127.0.1.1\trunner-b\n"
	if got != want {
		t.Fatalf("hosts = %q, want %q", got, want)
	}
}

func TestHostsEntriesIgnoreCommentsWhenLookingForLocalhost(t *testing.T) {
	got := string(hostsWithEntries([]byte("# 127.0.0.1 localhost\n"), "runner-c"))
	if !strings.Contains(got, "\n127.0.0.1\tlocalhost\n") || !strings.Contains(got, "\n::1\tlocalhost") {
		t.Fatalf("a commented-out entry must not count: %q", got)
	}
}
