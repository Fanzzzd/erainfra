package executor

import "testing"

func TestSpecRegistryMirrorIsHeldToDockerdsRule(t *testing.T) {
	spec := Spec{
		Kind:              "ci",
		AttemptID:         "attempt-1",
		RunnerName:        "erainfra-4vcpu-ubuntu-2404-a",
		Profile:           "erainfra-4vcpu-ubuntu-2404",
		ImageRelease:      "ghcr.io/fanzzzd/image@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		VCPUs:             4,
		MemoryMiB:         8192,
		JITConfig:         "single-use-secret",
		RegistryMirrorURL: "http://10.20.0.5:5000",
	}
	if err := spec.Validate(); err != nil {
		t.Fatalf("valid mirror refused: %v", err)
	}
	// dockerd refuses to start on a mirror with no scheme, so it never gets
	// as far as a guest's daemon.json.
	spec.RegistryMirrorURL = "10.20.0.5:5000"
	if err := spec.Validate(); err == nil {
		t.Fatal("a mirror dockerd would reject was accepted")
	}
}
