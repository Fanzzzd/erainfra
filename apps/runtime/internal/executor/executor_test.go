package executor

import (
	"strings"
	"testing"
)

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

func TestSpecJobIdentityRejectsUnsafeFacts(t *testing.T) {
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

	// Empty is always valid (a fleet without a cache), and ordinary facts pass.
	for _, tweak := range []func(*Spec){
		func(*Spec) {},
		func(s *Spec) {
			s.JobIdentity = JobIdentity{
				Repository: "Fanzzzd/erainfra", HeadRepository: "someone/erainfra",
				Event: "pull_request", Ref: "refs/pull/12/merge",
				BaseRef: "refs/heads/main", DefaultBranch: "main", Attempt: "1",
			}
		},
	} {
		spec := valid
		tweak(&spec)
		if err := spec.Validate(); err != nil {
			t.Fatalf("valid job identity refused: %+v: %v", spec.JobIdentity, err)
		}
	}

	// A fact that flows into a signed token and MMDS must not carry whitespace,
	// control characters, or unbounded length.
	for _, tweak := range []func(*Spec){
		func(s *Spec) { s.JobIdentity.Repository = "Fanzzzd/era infra" },
		func(s *Spec) { s.JobIdentity.Ref = "refs/heads/main\n" },
		func(s *Spec) { s.JobIdentity.Event = "push\t" },
		func(s *Spec) { s.JobIdentity.Repository = strings.Repeat("a", 257) },
	} {
		spec := valid
		tweak(&spec)
		if err := spec.Validate(); err == nil {
			t.Fatalf("unsafe job identity accepted: %+v", spec.JobIdentity)
		}
	}
}

func TestSpecCacheEndpointMirrorsTheDockerProvisionersRules(t *testing.T) {
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

	accepted := []Spec{valid}
	for _, tweak := range []func(*Spec){
		func(s *Spec) { s.CacheURL = "http://cache.internal:8080" },
		func(s *Spec) { s.CacheURL = "https://cache.example/v1"; s.CacheServiceV2 = "false" },
		func(s *Spec) { s.CacheServiceV2 = "true" },
	} {
		spec := valid
		tweak(&spec)
		accepted = append(accepted, spec)
	}
	for _, spec := range accepted {
		if err := spec.Validate(); err != nil {
			t.Fatalf("valid cache endpoint refused: %+v: %v", spec, err)
		}
	}

	rejected := []func(*Spec){
		func(s *Spec) { s.CacheURL = "cache.internal:8080" },
		func(s *Spec) { s.CacheURL = "ftp://cache.internal" },
		// Whitespace is the shape that turns one environment entry into two
		// somewhere downstream; provision-docker.sh refuses it and so does this.
		func(s *Spec) { s.CacheURL = "https://cache.example/a b" },
		func(s *Spec) { s.CacheURL = "https://cache.example/\n" },
		// A scheme with nothing after it satisfies a prefix check and
		// configures nothing; the URL must name a host.
		func(s *Spec) { s.CacheURL = "https://" },
		func(s *Spec) { s.CacheURL = "http://" },
		func(s *Spec) { s.CacheURL = "https:///cache" },
		func(s *Spec) { s.CacheServiceV2 = "True" },
		func(s *Spec) { s.CacheServiceV2 = "1" },
	}
	for _, tweak := range rejected {
		spec := valid
		tweak(&spec)
		if err := spec.Validate(); err == nil {
			t.Fatalf("invalid cache endpoint accepted: %+v", spec)
		}
	}
}
