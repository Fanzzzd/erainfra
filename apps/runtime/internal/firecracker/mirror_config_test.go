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
