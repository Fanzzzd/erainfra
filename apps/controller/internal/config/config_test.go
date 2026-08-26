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

func TestValidateCacheFacts(t *testing.T) {
	key := "erainfra-cache-service-signing-key-0123456789"

	both := validConfig()
	both.CacheFactsURL = "http://127.0.0.1:8721"
	both.CacheSigningKey = key
	if err := both.Validate(); err != nil {
		t.Fatalf("a URL and key together should be valid: %v", err)
	}

	urlOnly := validConfig()
	urlOnly.CacheFactsURL = "http://127.0.0.1:8721"
	if err := urlOnly.Validate(); err == nil {
		t.Fatal("a cache URL with no signing key was accepted")
	}

	keyOnly := validConfig()
	keyOnly.CacheSigningKey = key
	if err := keyOnly.Validate(); err == nil {
		t.Fatal("a signing key with no cache URL was accepted")
	}

	shortKey := validConfig()
	shortKey.CacheFactsURL = "http://127.0.0.1:8721"
	shortKey.CacheSigningKey = "too-short"
	if err := shortKey.Validate(); err == nil {
		t.Fatal("a short signing key was accepted")
	}
}

func TestValidateWarmPool(t *testing.T) {
	config := validConfig()
	config.MaxRunners = 4
	config.WarmPool = 2
	if err := config.Validate(); err != nil {
		t.Fatal(err)
	}

	config.WarmPool = 5
	if err := config.Validate(); err == nil {
		t.Fatal("warm pool larger than max runners was accepted")
	}
	config.WarmPool = 1
	config.Executor = "docker"
	if err := config.Validate(); err == nil {
		t.Fatal("Docker warm pool was accepted")
	}
}
