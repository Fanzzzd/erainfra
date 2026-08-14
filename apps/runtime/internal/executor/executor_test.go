package executor

import "testing"

func TestSpecRequiresImmutableSafeInputs(t *testing.T) {
	valid := Spec{
		Kind:         "ci",
		AttemptID:    "attempt-1",
		RunnerName:   "rc-linux-js-a",
		Profile:      "rc-linux-js",
		ImageRelease: "ghcr.io/fanzzzd/image@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		VCPUs:        4,
		MemoryMiB:    8192,
		JITConfig:    "single-use-secret",
	}
	if err := valid.Validate(); err != nil {
		t.Fatal(err)
	}

	tests := []Spec{
		{AttemptID: "../escape"},
		{AttemptID: "attempt", RunnerName: "runner", Profile: "profile", ImageRelease: "image:latest", VCPUs: 2, MemoryMiB: 2048, JITConfig: "secret"},
		{AttemptID: "attempt", RunnerName: "runner", Profile: "profile", ImageRelease: valid.ImageRelease, VCPUs: 0, MemoryMiB: 2048, JITConfig: "secret"},
		{AttemptID: "attempt", RunnerName: "runner", Profile: "profile", ImageRelease: valid.ImageRelease, VCPUs: 2, MemoryMiB: 2048},
	}
	for _, spec := range tests {
		if err := spec.Validate(); err == nil {
			t.Fatalf("invalid spec accepted: %+v", spec)
		}
	}

	experiment := valid
	experiment.Kind = "experiment"
	experiment.JITConfig = ""
	experiment.Command = []string{"bash", "-lc", "node --version"}
	experiment.ResultToken = "result-token"
	if err := experiment.Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestProfileWarmPoolIsExplicitAndBounded(t *testing.T) {
	profile := Profile{
		Name:         "rc-linux-js",
		ImageRelease: "ghcr.io/fanzzzd/image@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		VCPUs:        2,
		MemoryMiB:    4096,
		WarmPool:     2,
	}
	if err := profile.Validate(); err != nil {
		t.Fatal(err)
	}
	profile.WarmPool = 17
	if err := profile.Validate(); err == nil {
		t.Fatal("oversized warm pool was accepted")
	}
}
