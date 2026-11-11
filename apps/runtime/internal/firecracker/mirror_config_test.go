package firecracker

import "testing"

func TestConfigRegistryMirrorFailsAtStartup(t *testing.T) {
	cfg := DefaultConfig()
	cfg.RegistryMirrorURL = "http://10.20.0.5:5000"
	if err := cfg.Validate(); err != nil {
		t.Fatalf("valid mirror rejected: %v", err)
	}
	// No key is needed with it, unlike the cache: a mirror serves public
	// images and holds no per-job identity.
	for _, malformed := range []string{"10.20.0.5:5000", "https://u:p@mirror.lan", "https://mirror.lan/v2"} {
		cfg.RegistryMirrorURL = malformed
		if err := cfg.Validate(); err == nil {
			t.Errorf("mirror %q accepted at startup", malformed)
		}
	}
}

func TestConfigAptMirrorFailsAtStartup(t *testing.T) {
	cfg := DefaultConfig()
	cfg.AptMirrorURL = "http://10.20.0.7:3142"
	if err := cfg.Validate(); err != nil {
		t.Fatalf("valid apt mirror rejected: %v", err)
	}
	for _, malformed := range []string{"10.20.0.7:3142", "https://apt-mirror.lan", "http://apt-mirror.lan/ubuntu"} {
		cfg.AptMirrorURL = malformed
		if err := cfg.Validate(); err == nil {
			t.Errorf("apt mirror %q accepted at startup", malformed)
		}
	}
}

// The checkout mirror's seeds live in the cache service, so turning it on
// without one is refused at startup rather than shipped to every guest as a
// setting that can never work.
func TestConfigCheckoutMirrorNeedsTheCacheService(t *testing.T) {
	cfg := DefaultConfig()
	cfg.GitMirror = true
	if err := cfg.Validate(); err == nil {
		t.Fatal("RC_GIT_MIRROR accepted without a cache service")
	}
	cfg.CacheServiceURL = "http://10.20.0.6:8721"
	cfg.CacheSigningKey = []byte("erainfra-cache-service-test-signing-key-0123456789")
	if err := cfg.Validate(); err != nil {
		t.Fatalf("RC_GIT_MIRROR with a cache service rejected: %v", err)
	}
}
