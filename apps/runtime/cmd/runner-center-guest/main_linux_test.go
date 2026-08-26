//go:build linux

package main

import (
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
	want := "nameserver 1.1.1.1\nnameserver 9.9.9.9\n"
	if config != want {
		t.Fatalf("resolverConfig produced %q, want %q", config, want)
	}
}

func TestResolverConfigKeepsSearchAndDomain(t *testing.T) {
	config, err := resolverConfig([]byte("domain example.test\nsearch a.test b.test\nnameserver 10.0.0.53\n"))
	if err != nil {
		t.Fatalf("resolverConfig returned %v", err)
	}
	want := "domain example.test\nsearch a.test b.test\nnameserver 10.0.0.53\n"
	if config != want {
		t.Fatalf("resolverConfig produced %q, want %q", config, want)
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
	env := runnerEnv(metadata, "/home/runner", "runner", "")

	want := map[string]string{
		"LANG":                           "C.UTF-8",
		"HOME":                           "/home/runner",
		"ACTIONS_RUNNER_INPUT_JITCONFIG": "secret",
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
	for _, absent := range []string{"ACTIONS_CACHE_URL", "ACTIONS_CACHE_SERVICE_V2", "ACTIONS_RESULTS_URL", "ACTIONS_RUNTIME_TOKEN", "NODE_EXTRA_CA_CERTS"} {
		if _, present := got[absent]; present {
			t.Fatalf("runner env carries %s with no cache endpoint configured", absent)
		}
	}

	metadata.CacheURL = "https://cache.internal:8080"
	metadata.CacheServiceV2 = "false"
	env = runnerEnv(metadata, "/home/runner", "runner", "")
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

	env := runnerEnv(metadata, "/home/runner", "runner", "/usr/local/share/ca-certificates/erainfra-cache.crt")
	joined := strings.Join(env, "\n")
	if !strings.Contains(joined, "NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/erainfra-cache.crt") {
		t.Fatalf("redirected runner env missing the cache trust anchor: %q", joined)
	}
}
