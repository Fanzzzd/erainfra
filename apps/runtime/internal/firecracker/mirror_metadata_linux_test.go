//go:build linux

package firecracker

import (
	"encoding/json"
	"testing"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/executor"
	"github.com/Fanzzzd/erainfra/apps/runtime/internal/guest"
)

// The host writes MMDS as a map and the guest reads it into guest.Metadata.
// The field names are the seam between two binaries, so the test crosses it:
// whatever metadataFor writes must come back out of the guest's decoder intact.
func TestMetadataRoundTripsIntoTheGuestsDecoder(t *testing.T) {
	spec := executor.Spec{
		Kind:              "ci",
		RunnerName:        "rc-a",
		JITConfig:         "secret",
		CacheServiceURL:   "https://cache.internal:8721",
		CacheRunnerToken:  "erainfra-cache-runner-v1.payload.signature",
		RegistryMirrorURL: "http://10.20.0.5:5000",
		GitMirror:         true,
	}
	tree := metadataFor(spec)
	encoded, err := json.Marshal(tree["latest"].(map[string]any)["meta-data"].(map[string]any)["runner-center"])
	if err != nil {
		t.Fatal(err)
	}
	var decoded guest.Metadata
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if err := decoded.Validate(); err != nil {
		t.Fatalf("the guest refused what the host wrote: %v", err)
	}
	if decoded.RegistryMirrorURL != spec.RegistryMirrorURL ||
		decoded.CacheServiceURL != spec.CacheServiceURL ||
		decoded.CacheRunnerToken != spec.CacheRunnerToken ||
		!decoded.GitMirror {
		t.Fatalf("round trip lost a field: %+v", decoded)
	}

	// A fleet without a mirror writes an empty value, which the guest reads
	// as no mirror at all.
	tree = metadataFor(executor.Spec{Kind: "ci", RunnerName: "rc-a", JITConfig: "secret"})
	encoded, _ = json.Marshal(tree["latest"].(map[string]any)["meta-data"].(map[string]any)["runner-center"])
	decoded = guest.Metadata{}
	if err := json.Unmarshal(encoded, &decoded); err != nil || decoded.RegistryMirrorURL != "" || decoded.Validate() != nil {
		t.Fatalf("no-mirror metadata: %+v, %v", decoded, err)
	}
}
