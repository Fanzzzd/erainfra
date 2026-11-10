package firecracker

import (
	"os"
	"testing"
)

func TestEnsureSDKRequestTimeoutSetsDefault(t *testing.T) {
	t.Setenv(sdkRequestTimeoutEnv, "")
	if err := os.Unsetenv(sdkRequestTimeoutEnv); err != nil {
		t.Fatal(err)
	}
	ensureSDKRequestTimeout()
	if got := os.Getenv(sdkRequestTimeoutEnv); got != defaultSDKRequestTimeoutMillis {
		t.Fatalf("request timeout = %q, want %q", got, defaultSDKRequestTimeoutMillis)
	}
}

func TestEnsureSDKRequestTimeoutKeepsOperatorValue(t *testing.T) {
	t.Setenv(sdkRequestTimeoutEnv, "2500")
	ensureSDKRequestTimeout()
	if got := os.Getenv(sdkRequestTimeoutEnv); got != "2500" {
		t.Fatalf("request timeout = %q, want the operator's 2500", got)
	}
}
