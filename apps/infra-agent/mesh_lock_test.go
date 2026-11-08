//go:build !windows

package main

import (
	"encoding/json"
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
	if err != nil || len(p.List) != 1 || p.AuthToken != "token" || !p.N0Fallback {
		t.Fatalf("%+v %v", p, err)
	}
	t.Setenv("ERAINFRA_MESH_RELAYS", "")
	t.Setenv("ERAINFRA_MESH_RELAY_TOKEN", "")
	t.Setenv("ERAINFRA_MESH_N0_FALLBACK", "")
	if p, err = meshRelayPolicy(); err != nil || len(p.List) != 0 || p.List == nil || p.N0Fallback {
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

// A cloud security list that blocks udp/7842, iroh's QUIC address discovery port, leaves the
// fleet relay unmeasured, so a relay entry may name another port. A plain URL keeps meaning 7842,
// and reaches the sidecar as a plain string, which a sidecar without the object form accepts.
func TestConvexModeRelayPolicyQUICPort(t *testing.T) {
	t.Setenv("ERAINFRA_MESH_RELAY_TOKEN", "")
	t.Setenv("ERAINFRA_MESH_N0_FALLBACK", "")
	t.Setenv("ERAINFRA_MESH_RELAYS", `[{"url":"https://relay.on99.ai","quic_port":443},"https://relay.example",{"url":"https://noqad.example","quic":false},{"url":"https://explicit.example","quic":true}]`)
	p, err := meshRelayPolicy()
	if err != nil {
		t.Fatal(err)
	}
	b, err := json.Marshal(p)
	want := `{"relays":[{"url":"https://relay.on99.ai","quic_port":443},"https://relay.example",{"url":"https://noqad.example","quic":false},"https://explicit.example"],"n0_fallback":false}`
	if err != nil || string(b) != want {
		t.Fatalf("set_relays body\n got %s %v\nwant %s", b, err, want)
	}

	for env, wantErr := range map[string]string{
		`{"url":"https://r.example"}`:                                         "ERAINFRA_MESH_RELAYS must be a JSON URL array, each entry a URL string or {",
		`https://r.example`:                                                   "ERAINFRA_MESH_RELAYS must be a JSON URL array",
		`[{"url":"https://r.example","quic_port":0}]`:                         `ERAINFRA_MESH_RELAYS entry 1: relay https://r.example: "quic_port" must be a port number from 1 to 65535, not 0`,
		`["https://a.example",{"url":"https://r.example","quic_port":65536}]`: `ERAINFRA_MESH_RELAYS entry 2: relay https://r.example: "quic_port" must be a port number from 1 to 65535, not 65536`,
		`[{"url":"https://r.example","quic_port":"443"}]`:                     `"quic_port" must be a port number from 1 to 65535, not "443"`,
		`[{"url":"https://r.example","quic_port":-1}]`:                        `from 1 to 65535, not -1`,
		`[{"url":"https://r.example","quic_port":443.5}]`:                     `from 1 to 65535, not 443.5`,
		`[{"url":"https://r.example","quic":false,"quic_port":443}]`:          `"quic": false turns QUIC address discovery off, so drop "quic_port"`,
		`[{"url":"https://r.example","quic":"no"}]`:                           `"quic" must be true or false, not "no"`,
		`[{"url":"https://r.example","qad_port":443}]`:                        `relay field "qad_port" is unknown; a relay object has "url", "quic_port" and "quic"`,
		`[{"quic_port":443}]`:                                                 `ERAINFRA_MESH_RELAYS entry 1: a relay object needs "url", a string`,
		`[443]`:                                                               `a relay is a URL string or an object like {"url":"https://relay.example.com","quic_port":443}, not 443`,
		`[null]`:                                                              `a relay is a URL string or an object`,
		`[{"url":"ftp://r.example","quic_port":443}]`:                         `ERAINFRA_MESH_RELAYS entry 1: relay ftp://r.example has scheme "ftp"; use https`,
		`["relay.example"]`:                                                   `relay relay.example has scheme ""; use https`,
	} {
		t.Setenv("ERAINFRA_MESH_RELAYS", env)
		if _, err := meshRelayPolicy(); err == nil || !strings.Contains(err.Error(), wantErr) {
			t.Errorf("%s: got %v, want %q", env, err, wantErr)
		}
	}

	// The sidecar's rule, checked at startup: plain http only without a token.
	t.Setenv("ERAINFRA_MESH_RELAYS", `[{"url":"http://r.example","quic_port":443}]`)
	if _, err := meshRelayPolicy(); err != nil {
		t.Fatalf("plain http without a token: %v", err)
	}
	t.Setenv("ERAINFRA_MESH_RELAY_TOKEN", "token")
	if _, err := meshRelayPolicy(); err == nil || !strings.Contains(err.Error(), "relay http://r.example is plain http; refusing to send the relay auth token over it") {
		t.Fatalf("plain http with a token: %v", err)
	}
}
