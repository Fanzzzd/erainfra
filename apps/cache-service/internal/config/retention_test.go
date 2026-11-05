package config

import (
	"testing"
	"time"
)

// The retention defaults are GitHub's: 7 days idle, 10 GiB per repository.
func TestRetentionDefaultsMatchGitHub(t *testing.T) {
	setMinimum(t)
	config, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if config.IdleTTL != 7*24*time.Hour {
		t.Errorf("idle TTL = %s, want 7 days", config.IdleTTL)
	}
	if config.RepoQuotaBytes != 10<<30 {
		t.Errorf("repository quota = %d, want 10 GiB", config.RepoQuotaBytes)
	}
	if config.EvictionInterval != time.Hour {
		t.Errorf("eviction interval = %s, want 1h", config.EvictionInterval)
	}
}

func TestRetentionIsConfigurableInDays(t *testing.T) {
	setMinimum(t)
	t.Setenv("ERAINFRA_CACHE_IDLE_TTL", "14d")
	t.Setenv("ERAINFRA_CACHE_REPO_QUOTA_BYTES", "26843545600")
	t.Setenv("ERAINFRA_CACHE_EVICTION_INTERVAL", "15m")
	config, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if config.IdleTTL != 14*24*time.Hour || config.RepoQuotaBytes != 25<<30 ||
		config.EvictionInterval != 15*time.Minute {
		t.Fatalf("retention = %s, %d, %s", config.IdleTTL, config.RepoQuotaBytes, config.EvictionInterval)
	}
}

func TestRetentionRefusesNonsense(t *testing.T) {
	for name, env := range map[string][2]string{
		"zero days":         {"ERAINFRA_CACHE_IDLE_TTL", "0d"},
		"fractional days":   {"ERAINFRA_CACHE_IDLE_TTL", "1.5d"},
		"negative duration": {"ERAINFRA_CACHE_EVICTION_INTERVAL", "-1h"},
		"zero quota":        {"ERAINFRA_CACHE_REPO_QUOTA_BYTES", "0"},
		"quota with a unit": {"ERAINFRA_CACHE_REPO_QUOTA_BYTES", "10GiB"},
	} {
		t.Run(name, func(t *testing.T) {
			setMinimum(t)
			t.Setenv(env[0], env[1])
			if _, err := Load(); err == nil {
				t.Fatalf("%s=%s was accepted", env[0], env[1])
			}
		})
	}
}
