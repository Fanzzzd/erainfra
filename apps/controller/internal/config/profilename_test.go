package config

import "testing"

func TestProfileNameErrorAcceptsLegalNames(t *testing.T) {
	for _, name := range []string{
		"erainfra-4vcpu-ubuntu-2404",
		"erainfra-8vcpu-ubuntu-2404-arm",
		"erainfra-canary-16vcpu-ubuntu-2404-arm-32gb",
		"erainfra-6vcpu-macos-15",
		"erainfra-4vcpu-windows-2025",
		// In service before ADR 0010; GitHub holds their scale sets.
		"rc-linux-js",
		"rc-e2e",
	} {
		if err := ProfileNameError(name); err != nil {
			t.Errorf("ProfileNameError(%q) = %v, want nil", name, err)
		}
	}
}

func TestProfileNameErrorRefusesNamesGitHubWouldMisread(t *testing.T) {
	for _, name := range []string{
		"Erainfra-4vcpu-ubuntu-2404", // labels are case-insensitive
		"erainfra_4vcpu",
		"erainfra--4vcpu",
		"-erainfra",
		"erainfra-",
		"4vcpu-ubuntu",
		"ubuntu-latest",
		"ubuntu-24.04",
		"ubuntu-24.04-arm",
		"self-hosted",
		"linux",
		"windows-2025",
		"macos-15",
		"erainfra-canary-16vcpu-ubuntu-2404-arm-32gb-xxx", // 47 characters
	} {
		if err := ProfileNameError(name); err == nil {
			t.Errorf("ProfileNameError(%q) = nil, want an error", name)
		}
	}
}

func TestProfileNameFollowsScheme(t *testing.T) {
	cases := map[string]bool{
		"erainfra-4vcpu-ubuntu-2404":                  true,
		"erainfra-8vcpu-ubuntu-2404-arm":              true,
		"erainfra-4vcpu-ubuntu-2404-8gb":              true,
		"erainfra-canary-4vcpu-ubuntu-2404":           true,
		"erainfra-canary-16vcpu-ubuntu-2404-arm-32gb": true,
		"erainfra-4vcpu-ubuntu-2404-gpu":              true,
		"erainfra-6vcpu-macos-15":                     true,
		"erainfra-4vcpu-windows-2025":                 true,
		"rc-linux-js":                                 false,
		"rc-e2e":                                      false,
		"erainfra-ubuntu-2404":                        false, // no size
		"erainfra-4vcpu-ubuntu-24.04":                 false, // dotted version
		"erainfra-0vcpu-ubuntu-2404":                  false,
		"blacksmith-4vcpu-ubuntu-2404":                false,
	}
	for name, want := range cases {
		if got := ProfileNameFollowsScheme(name); got != want {
			t.Errorf("ProfileNameFollowsScheme(%q) = %v, want %v", name, got, want)
		}
	}
}
