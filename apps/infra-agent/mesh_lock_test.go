//go:build !windows

package main

import (
	"os"
	"strings"
	"testing"

	"github.com/Fanzzzd/erainfra/apps/infra-agent/internal/meshclient/meshtest"
)

// Hub mode and Convex mode can never drive one sidecar at once on a host, even when they are
// configured with different control directories: the second one to start fails before it sends
// the sidecar anything.
func TestHubAndConvexModesCannotDriveOneSidecar(t *testing.T) {
	sidecar := meshtest.Start(t)
	t.Setenv("ERAINFRA_MESH_BIN", "")
	t.Setenv("ERAINFRA_MESH_SOCKET", sidecar.Socket)
	control := func() string {
		dir, err := os.MkdirTemp("", "mc-")
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.RemoveAll(dir) })
		return dir
	}
	hubDir, convexDir := control(), control()
	refused := func(err error) {
		t.Helper()
		if err == nil || !strings.Contains(err.Error(), "already has a controller") {
			t.Fatalf("second controller admitted: %v", err)
		}
	}

	t.Setenv("ERAINFRA_MESH_CONTROL_DIR", hubDir)
	hub, err := connectMesh(t.Context(), "hub")
	if err != nil || !hub.Enabled() {
		t.Fatal(err)
	}
	statusCalls := sidecar.Ops("status")
	_, err = convexMesh(t.Context())
	refused(err)
	t.Setenv("ERAINFRA_MESH_CONTROL_DIR", convexDir)
	_, err = convexMesh(t.Context())
	refused(err)
	if sidecar.Ops("status") != statusCalls {
		t.Fatal("a refused controller talked to the sidecar")
	}

	if err := hub.Close(); err != nil {
		t.Fatal(err)
	}
	convex, err := convexMesh(t.Context())
	if err != nil || convex == nil {
		t.Fatalf("Convex mode after Hub mode stopped: %v", err)
	}
	defer func() { _ = convex.Close() }()
	t.Setenv("ERAINFRA_MESH_CONTROL_DIR", hubDir)
	_, err = connectMesh(t.Context(), "hub")
	refused(err)
}

func TestConvexModeRelayPolicy(t *testing.T) {
	t.Setenv("ERAINFRA_MESH_RELAYS", `["https://relay.example"]`)
	t.Setenv("ERAINFRA_MESH_RELAY_TOKEN", "token")
	t.Setenv("ERAINFRA_MESH_N0_FALLBACK", "true")
	p, err := meshRelayPolicy()
	if err != nil || len(p.URLs) != 1 || p.AuthToken != "token" || !p.N0Fallback {
		t.Fatalf("%+v %v", p, err)
	}
	t.Setenv("ERAINFRA_MESH_RELAYS", "")
	t.Setenv("ERAINFRA_MESH_RELAY_TOKEN", "")
	t.Setenv("ERAINFRA_MESH_N0_FALLBACK", "")
	if p, err = meshRelayPolicy(); err != nil || len(p.URLs) != 0 || p.URLs == nil || p.N0Fallback {
		t.Fatalf("default is direct only: %+v %v", p, err)
	}
	for key, bad := range map[string]string{"ERAINFRA_MESH_RELAYS": "https://relay.example", "ERAINFRA_MESH_N0_FALLBACK": "yes"} {
		t.Setenv(key, bad)
		if _, err := meshRelayPolicy(); err == nil {
			t.Fatalf("%s=%s accepted", key, bad)
		}
		t.Setenv(key, "")
	}
	t.Setenv("ERAINFRA_MESH_RELAYS", "null")
	if _, err := meshRelayPolicy(); err == nil {
		t.Fatal("null relay list accepted")
	}
}
