//go:build linux

package main

import (
	"context"
	"os"
	"strings"
	"testing"
)

// isolate removes every RC_ and ERAINFRA_ variable for one test, so the shell running the suite
// cannot decide which name a read resolves to.
func isolate(t *testing.T) {
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

func TestRunRefusesNamesThatDisagreeBeforeReadingEither(t *testing.T) {
	isolate(t)
	t.Setenv("RC_PROFILE", "linux-js")
	t.Setenv("ERAINFRA_PROFILE", "linux-go")
	// A socket path nothing listens on: if the check did not come first, remove-profile would get
	// as far as dialing it and fail with exit 1 for an unrelated reason.
	t.Setenv("RC_RUNTIME_SOCKET", t.TempDir()+"/absent.sock")
	code, err := run(context.Background(), []string{"remove-profile"})
	if code != 2 || err == nil {
		t.Fatalf("run(remove-profile) = %d, %v; want exit 2 and the conflict", code, err)
	}
	for _, name := range []string{"ERAINFRA_PROFILE", "RC_PROFILE"} {
		if !strings.Contains(err.Error(), name) {
			t.Fatalf("error %q does not name %s", err, name)
		}
	}
}

func TestProfileEnvReadsEitherName(t *testing.T) {
	for _, prefix := range []string{"RC_", "ERAINFRA_"} {
		t.Run(prefix, func(t *testing.T) {
			isolate(t)
			t.Setenv(prefix+"PROFILE", "linux-js")
			t.Setenv(prefix+"IMAGE_RELEASE", "ghcr.io/example/runner@sha256:"+strings.Repeat("a", 64))
			t.Setenv(prefix+"VCPUS", "4")
			t.Setenv(prefix+"MEMORY_MIB", "16384")
			t.Setenv(prefix+"WARM_POOL", "2")
			profile, err := profileEnv()
			if err != nil {
				t.Fatal(err)
			}
			if profile.Name != "linux-js" || profile.VCPUs != 4 || profile.MemoryMiB != 16384 || profile.WarmPool != 2 {
				t.Fatalf("profileEnv with only %s names = %+v", prefix, profile)
			}
		})
	}
}

func TestRuntimeConfigReadsTheNewNames(t *testing.T) {
	isolate(t)
	t.Setenv("ERAINFRA_THIN_POOL", "erainfra-pool")
	t.Setenv("ERAINFRA_EGRESS_ALLOW", "10.0.0.0/8, registry.npmjs.org")
	t.Setenv("RC_NAMESERVERS", "1.1.1.1")
	config := runtimeConfig()
	if config.ThinPoolName != "erainfra-pool" {
		t.Fatalf("ThinPoolName = %q, want the ERAINFRA_THIN_POOL value", config.ThinPoolName)
	}
	if strings.Join(config.Network.AllowedDestinations, ",") != "10.0.0.0/8,registry.npmjs.org" {
		t.Fatalf("AllowedDestinations = %v", config.Network.AllowedDestinations)
	}
	if strings.Join(config.Network.Nameservers, ",") != "1.1.1.1" {
		t.Fatalf("Nameservers = %v; the legacy name alone must still be read", config.Network.Nameservers)
	}
	if runtimeSocket() != "/run/runner-center/runtime.sock" {
		t.Fatalf("with neither name set the socket must stay where every host has it, got %q", runtimeSocket())
	}
}

func TestBoolEnvReadsASwitchAndRefusesATypo(t *testing.T) {
	for value, want := range map[string]bool{"": false, "off": false, "0": false, "on": true, "1": true, "TRUE": true} {
		isolate(t)
		t.Setenv("ERAINFRA_GIT_MIRROR", value)
		got, err := boolEnv("RC_GIT_MIRROR")
		if err != nil || got != want {
			t.Errorf("boolEnv with %q = %v, %v; want %v", value, got, err, want)
		}
	}
	isolate(t)
	t.Setenv("RC_GIT_MIRROR", "enabled")
	if _, err := boolEnv("RC_GIT_MIRROR"); err == nil {
		t.Fatal("boolEnv accepted a value that is neither on nor off")
	}
}
