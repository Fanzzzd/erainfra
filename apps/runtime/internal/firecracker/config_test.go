package firecracker

import "testing"

func TestConfigRejectsBroadRecoveryDirectory(t *testing.T) {
	for _, path := range []string{"/", "/var", "/home/storage", "/attempts", "relative/attempts"} {
		config := DefaultConfig()
		config.WorkDir = path
		if err := config.Validate(); err == nil {
			t.Fatalf("unsafe work directory %q was accepted", path)
		}
	}
}

func TestConfigAcceptsDedicatedAttemptDirectories(t *testing.T) {
	for _, path := range []string{
		"/var/lib/runner-center/attempts",
		"/home/storage/runner-center/attempts",
	} {
		config := DefaultConfig()
		config.WorkDir = path
		if err := config.Validate(); err != nil {
			t.Fatalf("work directory %q rejected: %v", path, err)
		}
	}
}
