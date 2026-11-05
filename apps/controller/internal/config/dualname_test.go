package config

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// cleanEnvironment removes every RC_ and ERAINFRA_ variable for one test, so a developer's shell
// cannot decide which branch of the dual read a test walks.
func cleanEnvironment(t *testing.T) {
	t.Helper()
	for _, entry := range os.Environ() {
		name, _, _ := strings.Cut(entry, "=")
		if strings.HasPrefix(name, "RC_") || strings.HasPrefix(name, "ERAINFRA_") {
			t.Setenv(name, "")
			if err := os.Unsetenv(name); err != nil {
				t.Fatal(err)
			}
		}
	}
}

// A dedicated controller's full configuration, keyed by the suffix shared by both names. The
// token goes through the _FILE variant, which is what the installer writes.
func dedicatedControllerSettings(t *testing.T) map[string]string {
	t.Helper()
	tokenFile := filepath.Join(t.TempDir(), "controller-token")
	if err := os.WriteFile(tokenFile, []byte("controller-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return map[string]string{
		"CONVEX_URL":            "https://example.convex.cloud",
		"CONTROLLER_TOKEN_FILE": tokenFile,
		"GITHUB_CONFIG_URL":     "https://github.com/example",
		"PROFILE":               "linux-js",
		"SCALE_SET_NAME":        "linux-js-set",
		"LABELS":                "linux-js,firecracker",
		"EXECUTOR":              "firecracker",
		"IMAGE_RELEASE":         validConfig().ImageRelease,
		"VCPUS":                 "4",
		"MEMORY_MIB":            "16384",
		"WARM_POOL":             "1",
		"FIT_POLICY":            "cpu",
		"MIN_RUNNERS":           "0",
		"MAX_RUNNERS":           "3",
		"GITHUB_TOKEN":          "github-token",
		"EGRESS_MODE":           "allowlist",
		"EGRESS_PRESETS":        "github",
		"EGRESS_ALLOW":          "registry.npmjs.org,10.0.0.0/8",
		"LOG_LEVEL":             "debug",
	}
}

func loadWith(t *testing.T, prefix string, settings map[string]string) Config {
	t.Helper()
	cleanEnvironment(t)
	for suffix, value := range settings {
		t.Setenv(prefix+suffix, value)
	}
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load with only %s names: %v", prefix, err)
	}
	return cfg
}

func TestLoadWithOnlyTheNewNamesMatchesTheLegacyNames(t *testing.T) {
	settings := dedicatedControllerSettings(t)
	legacy := loadWith(t, "RC_", settings)
	renamed := loadWith(t, "ERAINFRA_", settings)
	if !reflect.DeepEqual(legacy, renamed) {
		t.Fatalf("ERAINFRA_ names loaded\n%+v\nbut the same values under RC_ names loaded\n%+v", renamed, legacy)
	}
	if renamed.ControllerToken != "controller-token" || renamed.Profile != "linux-js" || renamed.VCPUs != 4 {
		t.Fatalf("the ERAINFRA_ names were not read: %+v", renamed)
	}
}

func TestLoadAcceptsAMixOfNamesThatAgree(t *testing.T) {
	settings := dedicatedControllerSettings(t)
	cleanEnvironment(t)
	// Half under each name, and one under both with the same value: the state an env file is in
	// partway through runbook section 3, step 1.
	i := 0
	for suffix, value := range settings {
		prefix := "RC_"
		if i%2 == 0 {
			prefix = "ERAINFRA_"
		}
		t.Setenv(prefix+suffix, value)
		i++
	}
	t.Setenv("RC_PROFILE", settings["PROFILE"])
	t.Setenv("ERAINFRA_PROFILE", settings["PROFILE"])
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load with a mix of agreeing names: %v", err)
	}
	if cfg.Profile != "linux-js" || cfg.MaxRunners != 3 {
		t.Fatalf("mixed names loaded %+v", cfg)
	}
}

func TestLoadRefusesNamesThatDisagree(t *testing.T) {
	for _, suffix := range []string{"PROFILE", "CONTROLLER_TOKEN_FILE", "MAX_RUNNERS"} {
		t.Run(suffix, func(t *testing.T) {
			settings := dedicatedControllerSettings(t)
			cleanEnvironment(t)
			for name, value := range settings {
				t.Setenv("RC_"+name, value)
			}
			t.Setenv("ERAINFRA_"+suffix, settings[suffix]+"-different")
			_, err := Load()
			if err == nil {
				t.Fatalf("Load accepted ERAINFRA_%s and RC_%s with different values", suffix, suffix)
			}
			for _, name := range []string{"ERAINFRA_" + suffix, "RC_" + suffix} {
				if !strings.Contains(err.Error(), name) {
					t.Fatalf("error %q does not name %s", err, name)
				}
			}
		})
	}
}

// An empty ERAINFRA_ name is unset, exactly as an empty RC_ name always was, so it neither
// overrides the legacy value nor conflicts with it.
func TestLoadTreatsAnEmptyNewNameAsUnset(t *testing.T) {
	settings := dedicatedControllerSettings(t)
	cleanEnvironment(t)
	for name, value := range settings {
		t.Setenv("RC_"+name, value)
	}
	t.Setenv("ERAINFRA_PROFILE", "")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Profile != "linux-js" {
		t.Fatalf("an empty ERAINFRA_PROFILE replaced RC_PROFILE: got %q", cfg.Profile)
	}
}
