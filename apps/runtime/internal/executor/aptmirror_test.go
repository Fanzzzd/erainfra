package executor

import "testing"

func TestSpecAptMirrorIsHeldToItsRule(t *testing.T) {
	spec := Spec{
		Kind:         "ci",
		AttemptID:    "attempt-1",
		RunnerName:   "rc-linux-js-a",
		Profile:      "rc-linux-js",
		ImageRelease: "ghcr.io/fanzzzd/image@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		VCPUs:        4,
		MemoryMiB:    8192,
		JITConfig:    "single-use-secret",
		AptMirrorURL: "http://10.20.0.7:3142",
	}
	if err := spec.Validate(); err != nil {
		t.Fatalf("valid apt mirror refused: %v", err)
	}
	// An https proxy would make apt tunnel the fetches the mirror exists to
	// cache, so it never reaches a guest.
	spec.AptMirrorURL = "https://10.20.0.7:3142"
	if err := spec.Validate(); err == nil {
		t.Fatal("an https apt mirror was accepted")
	}
}
