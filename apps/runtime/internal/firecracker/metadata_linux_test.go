//go:build linux

package firecracker

import (
	"testing"
	"time"

	"github.com/Fanzzzd/erainfra/apps/cache-service/cachetoken"
	"github.com/Fanzzzd/erainfra/apps/runtime/internal/executor"
)

var testCacheKey = []byte("erainfra-cache-service-signing-key-0123456789")

func TestMetadataCarriesTheCacheEndpointToTheGuest(t *testing.T) {
	spec := executor.Spec{
		Kind:           "ci",
		RunnerName:     "rc-a",
		JITConfig:      "secret",
		CacheURL:       "https://cache.internal:8080",
		CacheServiceV2: "false",
	}
	tree := metadataFor(spec)
	runnerCenter := tree["latest"].(map[string]any)["meta-data"].(map[string]any)["runner-center"].(map[string]any)
	if runnerCenter["cache_url"] != spec.CacheURL {
		t.Fatalf("cache_url = %v, want %q", runnerCenter["cache_url"], spec.CacheURL)
	}
	if runnerCenter["cache_service_v2"] != spec.CacheServiceV2 {
		t.Fatalf("cache_service_v2 = %v, want %q", runnerCenter["cache_service_v2"], spec.CacheServiceV2)
	}
	if _, present := runnerCenter["actions_runtime_token"]; present {
		t.Fatal("the artifact-service pair must never enter MMDS")
	}
}

func TestMetadataCarriesTheRunnerBearerToTheGuest(t *testing.T) {
	spec := executor.Spec{
		Kind:             "ci",
		RunnerName:       "rc-a",
		JITConfig:        "secret",
		CacheRunnerToken: "erainfra-cache-runner-v1.payload.signature",
	}
	tree := metadataFor(spec)
	runnerCenter := tree["latest"].(map[string]any)["meta-data"].(map[string]any)["runner-center"].(map[string]any)
	if runnerCenter["cache_runner_token"] != spec.CacheRunnerToken {
		t.Fatalf("cache_runner_token = %v, want %q", runnerCenter["cache_runner_token"], spec.CacheRunnerToken)
	}
}

// The bearer the host mints must be exactly the one the cache service will
// verify: same key, same runner name, same token package. This is the seam
// between the two programs, so the test crosses it rather than trusting it.
func TestNewMintsARunnerBearerTheServiceCanVerify(t *testing.T) {
	cfg := DefaultConfig()
	cfg.CacheSigningKey = testCacheKey
	cfg.CacheServiceURL = "https://cache.internal:8721"
	runtime, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}

	token := runtime.mintCacheBearer("rc-linux-js-a")
	if token == "" {
		t.Fatal("a configured issuer minted no bearer")
	}

	verifier, err := cachetoken.NewVerifier(testCacheKey)
	if err != nil {
		t.Fatal(err)
	}
	claims, err := verifier.VerifyRunner(token, time.Now())
	if err != nil {
		t.Fatalf("minted bearer did not verify: %v", err)
	}
	if claims.Runner != "rc-linux-js-a" {
		t.Fatalf("bearer names %q, want rc-linux-js-a", claims.Runner)
	}
}

// No key is a fleet without a cache, and a runner name that cannot scope a token
// is a mint that fails safe — both must yield an empty bearer, never a panic and
// never a token, so the Attempt proceeds with a cold cache.
func TestMintCacheBearerFailsSafe(t *testing.T) {
	plain, err := New(DefaultConfig())
	if err != nil {
		t.Fatal(err)
	}
	if token := plain.mintCacheBearer("rc-a"); token != "" {
		t.Fatalf("a fleet without a cache minted a bearer: %q", token)
	}

	cfg := DefaultConfig()
	cfg.CacheSigningKey = testCacheKey
	cfg.CacheServiceURL = "https://cache.internal:8721"
	withKey, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if token := withKey.mintCacheBearer(""); token != "" {
		t.Fatalf("an unnameable runner minted a bearer: %q", token)
	}
}

func TestNewRejectsAShortCacheKey(t *testing.T) {
	cfg := DefaultConfig()
	cfg.CacheSigningKey = []byte("too-short")
	cfg.CacheServiceURL = "https://cache.internal:8721"
	if _, err := New(cfg); err == nil {
		t.Fatal("a short signing key was accepted")
	}
}
