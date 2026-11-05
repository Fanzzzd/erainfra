package config

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"
)

func loadWithEgress(t *testing.T, mode, presets, allow string) (Config, error) {
	t.Helper()
	t.Setenv("RC_CONVEX_URL", "https://example.convex.cloud")
	t.Setenv("RC_CONTROLLER_TOKEN", "controller-token")
	t.Setenv("RC_GITHUB_CONFIG_URL", "https://github.com/example")
	t.Setenv("RC_PROFILE", "rc-linux-js")
	t.Setenv("RC_EXECUTOR", "firecracker")
	t.Setenv("RC_IMAGE_RELEASE", validConfig().ImageRelease)
	t.Setenv("RC_GITHUB_TOKEN", "github-token")
	t.Setenv("RC_EGRESS_MODE", mode)
	t.Setenv("RC_EGRESS_PRESETS", presets)
	t.Setenv("RC_EGRESS_ALLOW", allow)
	return Load()
}

func TestLoadPublishesTheProfilesEgressFromTheEnvironment(t *testing.T) {
	config, err := loadWithEgress(t, "Allowlist", "github", " Registry.NPMJS.org., *.example.com, 140.82.112.0/20, 192.168.50.10 ")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	spec := config.ProfileSpec()
	if spec.Egress == nil {
		t.Fatal("a configured egress policy must be published with the Profile")
	}
	if spec.Egress.Mode != "allowlist" ||
		!slices.Equal(spec.Egress.Presets, []string{"github"}) ||
		!slices.Equal(spec.Egress.Domains, []string{"registry.npmjs.org", "*.example.com"}) ||
		!slices.Equal(spec.Egress.CIDRs, []string{"140.82.112.0/20", "192.168.50.10/32"}) {
		t.Fatalf("published egress = %+v", spec.Egress)
	}
	encoded, err := json.Marshal(spec)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), `"egress":{"mode":"allowlist","presets":["github"]`) {
		t.Fatalf("the controller must send egress to the control plane, sent %s", encoded)
	}
}

func TestLoadWithoutEgressPublishesNoneSoOldControlPlanesSeeNoChange(t *testing.T) {
	config, err := loadWithEgress(t, "", "", "")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	encoded, err := json.Marshal(config.ProfileSpec())
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "egress") {
		t.Fatalf("an unconfigured controller must not publish egress, sent %s", encoded)
	}
}

func TestLoadRefusesEgressItCannotPublishSafely(t *testing.T) {
	cases := map[string][3]string{
		"a list without a mode":            {"", "github", ""},
		"an allowlist that allows nothing": {"allowlist", "", ""},
		"an unknown mode":                  {"block", "", ""},
		"public egress with a list":        {"public", "", "github.com"},
		"an unknown preset":                {"allowlist", "gitlab", ""},
		"an IPv6 destination":              {"allowlist", "github", "2001:db8::/32"},
		"a one-label name":                 {"allowlist", "github", "localhost"},
		"a URL where a domain belongs":     {"allowlist", "github", "https://example.com/path"},
	}
	for name, values := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := loadWithEgress(t, values[0], values[1], values[2]); err == nil {
				t.Fatalf("%v must be refused at startup", values)
			}
		})
	}
}

func TestValidateRefusesEgressOnExecutorsThatDoNotEnforceIt(t *testing.T) {
	for _, executor := range []string{"docker", "tart", "hyperv"} {
		config := validConfig()
		config.Executor = executor
		config.Egress = Egress{Mode: "allowlist", Presets: []string{"github"}}
		if err := config.Validate(); err == nil {
			t.Fatalf("%s Workers do not enforce Profile egress; publishing it must be refused", executor)
		}
		config.Egress = Egress{Mode: "public"}
		if err := config.Validate(); err != nil {
			t.Fatalf("explicit public egress is valid on %s: %v", executor, err)
		}
	}
}
