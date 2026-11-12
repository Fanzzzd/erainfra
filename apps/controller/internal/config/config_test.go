package config

import (
	"strings"
	"testing"

	"github.com/actions/scaleset"
)

func validConfig() Config {
	return Config{
		ConvexURL:       "https://example.convex.cloud",
		ControllerToken: "controller-token",
		RegistrationURL: "https://github.example/actions/runner-registration",
		Profile:         "erainfra-4vcpu-ubuntu-2404",
		Executor:        "firecracker",
		ImageRelease:    "ghcr.io/fanzzzd/runner@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		VCPUs:           2,
		MemoryMiB:       4096,
		FitPolicy:       "balanced",
		ScaleSetName:    "erainfra-4vcpu-ubuntu-2404",
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

// RC_GITHUB_CONFIG_URL decides where the scale set is registered, and
// docs/controllers.md promises a repository, organization or enterprise URL. Each of the
// three must pass validation and be read as the scope the scale-set client will
// register against, with a credential that scope accepts.
func TestValidateAcceptsEveryRegistrationScope(t *testing.T) {
	app := &scaleset.GitHubAppAuth{ClientID: "Iv1.client", InstallationID: 42, PrivateKey: "key"}
	cases := []struct {
		url   string
		app   bool
		scope Scope
	}{
		{"https://github.com/Fanzzzd/erainfra", true, ScopeRepository},
		{"https://github.com/Fanzzzd/erainfra/", false, ScopeRepository},
		{"https://github.com/Fanzzzd", true, ScopeOrganization},
		{"https://github.com/Fanzzzd", false, ScopeOrganization},
		{"https://ghes.example.test/platform", true, ScopeOrganization},
		{"https://github.com/enterprises/era", false, ScopeEnterprise},
		{"https://github.com/Enterprises/era/", false, ScopeEnterprise},
	}
	for _, tc := range cases {
		config := validConfig()
		config.RegistrationURL = tc.url
		if tc.app {
			config.GitHubToken = ""
			config.GitHubApp = app
		}
		if err := config.Validate(); err != nil {
			t.Fatalf("%s (app=%v) should be valid: %v", tc.url, tc.app, err)
		}
		scope, err := RegistrationScope(tc.url)
		if err != nil {
			t.Fatalf("RegistrationScope(%q): %v", tc.url, err)
		}
		if scope != tc.scope {
			t.Fatalf("RegistrationScope(%q) = %q, want %q", tc.url, scope, tc.scope)
		}
	}
}

// GitHub documents that a GitHub App cannot authenticate runners at the
// enterprise level, so the scale-set client would fail at its first
// registration-token call. Refusing that at startup names the fix instead.
func TestValidateRejectsAGitHubAppForAnEnterprise(t *testing.T) {
	config := validConfig()
	config.RegistrationURL = "https://github.com/enterprises/era"
	config.GitHubToken = ""
	config.GitHubApp = &scaleset.GitHubAppAuth{ClientID: "Iv1.client", InstallationID: 42, PrivateKey: "key"}
	err := config.Validate()
	if err == nil {
		t.Fatal("a GitHub App was accepted for an enterprise scale set")
	}
	if !strings.Contains(err.Error(), "RC_GITHUB_TOKEN") {
		t.Fatalf("the error should name the credential that works: %v", err)
	}
}

// A URL the scale-set client would misread must fail at startup. Without a
// scheme, "github.com/owner" parses as a bare path and would be registered as a
// repository named "owner" in an organization named "github.com".
func TestValidateRejectsAMalformedRegistrationURL(t *testing.T) {
	for _, raw := range []string{
		"github.com/Fanzzzd",
		"https://github.com",
		"https://github.com/",
		"https://github.com/Fanzzzd/erainfra/actions",
		"ftp://github.com/Fanzzzd",
		"https://github.com/Fanzzzd/erainfra?ref=main",
	} {
		config := validConfig()
		config.RegistrationURL = raw
		if err := config.Validate(); err == nil {
			t.Fatalf("%q was accepted as a registration URL", raw)
		}
	}
}
