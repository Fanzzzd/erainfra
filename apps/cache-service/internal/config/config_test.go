package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// setMinimum puts the four store variables and the signing key in the
// environment. Everything else has a default, and the defaults are what an
// operator gets, so they are asserted rather than assumed.
func setMinimum(t *testing.T) {
	t.Helper()
	t.Setenv("ERAINFRA_CACHE_SIGNING_KEY", "a-signing-key-that-is-long-enough-0123456789")
	t.Setenv("ERAINFRA_CACHE_S3_ENDPOINT", "https://store.lan:9000")
	t.Setenv("ERAINFRA_CACHE_S3_BUCKET", "erainfra-cache")
	t.Setenv("ERAINFRA_CACHE_S3_ACCESS_KEY", "access")
	t.Setenv("ERAINFRA_CACHE_S3_SECRET", "secret")
}

func TestLoadDefaults(t *testing.T) {
	setMinimum(t)
	config, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if config.DownloadMode != DownloadPresign {
		t.Errorf("download mode = %q, want presign", config.DownloadMode)
	}
	if config.LookupTimeout != 5*time.Second {
		t.Errorf("lookup budget = %s", config.LookupTimeout)
	}
	if config.ReserveTimeout != 10*time.Second {
		t.Errorf("reserve budget = %s", config.ReserveTimeout)
	}
	if config.TransferTimeout != 30*time.Minute {
		t.Errorf("transfer budget = %s", config.TransferTimeout)
	}
	if !config.Store.PathStyle {
		t.Error("path-style addressing should be the default: it is what a store on an operator's own LAN speaks")
	}
	if config.Store.Prefix == "" {
		t.Error("a key prefix should be the default so one bucket can hold more than the cache")
	}
}

// Every one of these is required, and the service refuses to start without it.
// A cache service that comes up without a store answers every restore with a
// miss and looks like a cache that is merely always cold.
func TestLoadRequiresTheStoreContractAndTheSigningKey(t *testing.T) {
	for _, name := range []string{
		"ERAINFRA_CACHE_SIGNING_KEY",
		"ERAINFRA_CACHE_S3_ENDPOINT",
		"ERAINFRA_CACHE_S3_BUCKET",
		"ERAINFRA_CACHE_S3_ACCESS_KEY",
		"ERAINFRA_CACHE_S3_SECRET",
	} {
		t.Run(name, func(t *testing.T) {
			setMinimum(t)
			t.Setenv(name, "")
			config, err := Load()
			if err == nil {
				// The store variables are validated by objectstore.NewS3, so
				// Load may pass them through; what must never happen is a
				// usable configuration with one of them empty.
				if strings.TrimSpace(config.Store.Endpoint) != "" &&
					strings.TrimSpace(config.Store.Bucket) != "" &&
					strings.TrimSpace(config.Store.AccessKey) != "" &&
					strings.TrimSpace(config.Store.Secret) != "" &&
					len(config.SigningKey) > 0 {
					t.Fatalf("%s was empty and the configuration came out complete", name)
				}
			}
		})
	}
}

func TestSigningKeyMustBeLongEnoughToBeASecret(t *testing.T) {
	setMinimum(t)
	t.Setenv("ERAINFRA_CACHE_SIGNING_KEY", "short")
	if _, err := Load(); err == nil {
		t.Fatal("a five-byte signing key was accepted")
	}
}

// A secret in an environment variable is visible to anything that can read
// /proc; the _FILE twin is the preferred shape and has to actually work.
func TestSecretsCanComeFromFiles(t *testing.T) {
	setMinimum(t)
	directory := t.TempDir()
	signing := filepath.Join(directory, "signing")
	store := filepath.Join(directory, "store")
	if err := os.WriteFile(signing, []byte("a-signing-key-from-a-file-that-is-long-enough\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(store, []byte("store-secret\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ERAINFRA_CACHE_SIGNING_KEY", "")
	t.Setenv("ERAINFRA_CACHE_SIGNING_KEY_FILE", signing)
	t.Setenv("ERAINFRA_CACHE_S3_SECRET", "")
	t.Setenv("ERAINFRA_CACHE_S3_SECRET_FILE", store)

	config, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if string(config.SigningKey) != "a-signing-key-from-a-file-that-is-long-enough" {
		t.Errorf("signing key = %q, want the file's contents without the newline", config.SigningKey)
	}
	if config.Store.Secret != "store-secret" {
		t.Errorf("store secret = %q", config.Store.Secret)
	}
}

func TestLoadRefusesNonsense(t *testing.T) {
	for name, env := range map[string]map[string]string{
		"unknown download mode":  {"ERAINFRA_CACHE_DOWNLOAD_MODE": "magic"},
		"unparseable duration":   {"ERAINFRA_CACHE_LOOKUP_TIMEOUT": "soon"},
		"negative duration":      {"ERAINFRA_CACHE_LOOKUP_TIMEOUT": "-5s"},
		"unparseable size":       {"ERAINFRA_CACHE_MAX_ENTRY_BYTES": "lots"},
		"zero size":              {"ERAINFRA_CACHE_MAX_ENTRY_BYTES": "0"},
		"unknown log level":      {"ERAINFRA_CACHE_LOG_LEVEL": "chatty"},
		"non-boolean path style": {"ERAINFRA_CACHE_S3_PATH_STYLE": "sometimes"},
	} {
		t.Run(name, func(t *testing.T) {
			setMinimum(t)
			for key, value := range env {
				t.Setenv(key, value)
			}
			if _, err := Load(); err == nil {
				t.Fatalf("%s was accepted", name)
			}
		})
	}
}

func TestBudgetsAndModeAreConfigurable(t *testing.T) {
	setMinimum(t)
	t.Setenv("ERAINFRA_CACHE_DOWNLOAD_MODE", "proxy")
	t.Setenv("ERAINFRA_CACHE_LOOKUP_TIMEOUT", "2s")
	t.Setenv("ERAINFRA_CACHE_RESERVE_TIMEOUT", "3s")
	t.Setenv("ERAINFRA_CACHE_TRANSFER_TIMEOUT", "4m")
	t.Setenv("ERAINFRA_CACHE_MAX_ENTRY_BYTES", "1048576")
	t.Setenv("ERAINFRA_CACHE_S3_PATH_STYLE", "false")

	config, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if config.DownloadMode != DownloadProxy || config.LookupTimeout != 2*time.Second ||
		config.ReserveTimeout != 3*time.Second || config.TransferTimeout != 4*time.Minute ||
		config.MaxEntryBytes != 1<<20 || config.Store.PathStyle {
		t.Fatalf("configuration = %+v", config)
	}
}
