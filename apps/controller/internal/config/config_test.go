package config

import "testing"

func validConfig() Config {
	return Config{
		ConvexURL:       "https://example.convex.cloud",
		ControllerToken: "controller-token",
		RegistrationURL: "https://github.example/actions/runner-registration",
		Profile:         "rc-linux-js",
		Executor:        "firecracker",
		ImageRelease:    "ghcr.io/fanzzzd/runner@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		VCPUs:           2,
		MemoryMiB:       4096,
		FitPolicy:       "balanced",
		ScaleSetName:    "rc-linux-js",
		MaxRunners:      1,
		GitHubToken:     "github-token",
	}
}

func TestValidateFitPolicy(t *testing.T) {
	for _, policy := range []string{"balanced", "cpu", "network", "io"} {
		config := validConfig()
		config.FitPolicy = policy
		if err := config.Validate(); err != nil {
			t.Fatalf("policy %q should be valid: %v", policy, err)
		}
	}

	config := validConfig()
	config.FitPolicy = "fastest"
	if err := config.Validate(); err == nil {
		t.Fatal("unknown fit policy should be rejected")
	}
}
