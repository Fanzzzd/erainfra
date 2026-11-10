//go:build linux

package main

import (
	"errors"
	"os/exec"
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

func TestRunnerEnvIsADecisionATestCanRead(t *testing.T) {
	metadata := guest.Metadata{Kind: "ci", RunnerName: "rc-a", JITConfig: "secret"}
	env := runnerEnv(metadata, "/home/runner", "runner", "", nil)

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
	env = runnerEnv(metadata, "/home/runner", "runner", "", nil)
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

	env := runnerEnv(metadata, "/home/runner", "runner", "/usr/local/share/ca-certificates/erainfra-cache.crt", nil)
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
	joined := strings.Join(runnerEnv(metadata, "/home/runner", "runner", "", build), "\n")
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
