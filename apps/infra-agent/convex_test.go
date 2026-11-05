package main

import "testing"

func TestExplicitTransportModes(t *testing.T) {
	for _, key := range []string{"ERAINFRA_HUB", "PORTLESS_HUB", "ERAINFRA_CONVEX_SITE", "ERAINFRA_NODE_CREDENTIAL", "ERAINFRA_NODE_CREDENTIAL_FILE", "ERAINFRA_NODE_STATE_DIR"} {
		t.Setenv(key, "")
	}
	t.Setenv("ERAINFRA_HUB", "wss://legacy/agent")
	if err := convexModeConflict("connect"); err != nil {
		t.Fatal("legacy Hub config rejected", err)
	}
	if err := convexModeConflict("connect-convex"); err == nil {
		t.Fatal("Convex started while Hub configured")
	}
	t.Setenv("ERAINFRA_HUB", "")
	t.Setenv("ERAINFRA_NODE_CREDENTIAL_FILE", "/private/node-token")
	if err := convexModeConflict("connect"); err == nil {
		t.Fatal("Hub started while Convex configured")
	}
}
