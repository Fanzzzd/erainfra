package config

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/Fanzzzd/erainfra/apps/controller/internal/fleet"
)

func TestWorkerStandbyNeedsOnlyExistingMachineCredentialAndProfileName(t *testing.T) {
	cfg := Config{ConvexURL: "https://example.convex.site", Profile: "rc-linux-js", MachineToken: "0123456789abcdef0123456789abcdef"}
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	if cfg.Credential() != cfg.MachineToken {
		t.Fatal("standby selected controller token")
	}
	for _, bad := range []Config{
		{ConvexURL: cfg.ConvexURL, Profile: cfg.Profile, MachineToken: "bad"},
		{ConvexURL: cfg.ConvexURL, Profile: cfg.Profile, MachineToken: cfg.MachineToken, ControllerToken: "shared"},
		{ConvexURL: cfg.ConvexURL, Profile: cfg.Profile, MachineToken: cfg.MachineToken, GitHubToken: "github"},
		{ConvexURL: cfg.ConvexURL, Profile: cfg.Profile, MachineToken: cfg.MachineToken, Executor: "docker"},
	} {
		if err := bad.Validate(); err == nil {
			t.Fatalf("accepted mixed/local standby configuration: %+v", bad)
		}
	}
	spec := validConfig().ProfileSpec()
	loaded, err := cfg.WithProfile(&spec)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.ImageRelease != spec.ImageRelease || loaded.VCPUs != spec.VCPUs || loaded.RegistrationURL != spec.RegistrationURL {
		t.Fatalf("did not read Convex contract: %+v", loaded)
	}
	if loaded.GitHubToken != "" || loaded.GitHubApp != nil || loaded.ControllerToken != "" {
		t.Fatal("invented static credentials")
	}
	spec.ImageRelease = "mutable:latest"
	if _, err := cfg.WithProfile(&spec); err == nil {
		t.Fatal("accepted invalid control-plane contract")
	}
	if _, err := cfg.WithProfile(nil); err == nil {
		t.Fatal("accepted absent Profile")
	}
	wrong := fleet.ProfileSpec{Name: "different"}
	if _, err := cfg.WithProfile(&wrong); err == nil {
		t.Fatal("accepted another Profile")
	}
}

func TestLoadWorkerTokenFromFile(t *testing.T) {
	for _, name := range []string{"RC_CONTROLLER_TOKEN", "RC_CONTROLLER_TOKEN_FILE", "RC_GITHUB_TOKEN", "RC_GITHUB_TOKEN_FILE", "RC_GITHUB_APP_CLIENT_ID", "RC_GITHUB_APP_INSTALLATION_ID", "RC_GITHUB_APP_PRIVATE_KEY", "RC_GITHUB_APP_PRIVATE_KEY_FILE", "RC_GITHUB_CONFIG_URL", "RC_EXECUTOR", "RC_IMAGE_RELEASE", "RC_MACHINE_TOKEN"} {
		t.Setenv(name, "")
	}
	file := filepath.Join(t.TempDir(), "machine-token")
	if err := os.WriteFile(file, []byte("0123456789abcdef0123456789abcdef\n"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("RC_CONVEX_URL", "https://example.convex.site")
	t.Setenv("RC_PROFILE", "rc-linux-js")
	t.Setenv("RC_MACHINE_TOKEN_FILE", file)
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.MachineToken != "0123456789abcdef0123456789abcdef" {
		t.Fatal("machine credential not loaded")
	}
}
