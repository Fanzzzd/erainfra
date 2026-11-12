package agent

import (
	"errors"
	"strings"
	"testing"

	"github.com/Fanzzzd/erainfra/apps/infra-agent/internal/meshclient"
)

// A Node without the sidecar answers the mesh calls with a clear unsupported error.
func TestMeshCallsOnANodeWithoutTheSidecar(t *testing.T) {
	m := NewMeshManager()
	if m.Enabled() {
		t.Fatal("mesh is not opt-in")
	}
	if _, err := m.EndpointStatus(t.Context()); !errors.Is(err, meshclient.ErrUnsupported) {
		t.Fatalf("EndpointStatus: %v", err)
	}
	if _, err := m.ApplyDesired(t.Context(), meshclient.Desired{V: 1}); !errors.Is(err, meshclient.ErrUnsupported) {
		t.Fatalf("ApplyDesired: %v", err)
	}
}

// shellQuote single-quotes an argument for safe interpolation into a test's fake docker script.
func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }
