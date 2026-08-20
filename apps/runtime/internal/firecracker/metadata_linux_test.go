//go:build linux

package firecracker

import (
	"testing"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/executor"
)

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
