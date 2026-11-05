package agent

import (
	"context"
	"strings"
	"testing"

	"github.com/Fanzzzd/erainfra/apps/infra-agent/internal/meshclient"
)

// A Node without the sidecar answers the mesh commands with a clear unsupported error, and an
// unknown control API version is refused even on a Node that has one.
func TestMeshCommandsOnANodeWithoutTheSidecar(t *testing.T) {
	m := NewMeshManager()
	if m.Enabled() {
		t.Fatal("mesh is not opt-in")
	}
	for _, cmd := range []cmdMsg{{Cmd: "meshStatus"}, {Cmd: "meshStatus", MeshVersion: 1}, {Cmd: "meshApply", MeshVersion: 2}} {
		result := RunCmd(context.Background(), cmd, ShellRunner{Mesh: m})
		if result.OK || !strings.Contains(result.Error, "secure mesh unsupported") {
			t.Fatalf("%s: %+v", cmd.Cmd, result)
		}
	}
}

// A name the Hub has put on the mesh never goes back to dumbpipe on this Node. Dropping the
// dumbpipe half stays allowed, because the Hub does that while migrating a link.
func TestLegacyCommandsAreRefusedForNamesOnTheMesh(t *testing.T) {
	m := NewMeshManager()
	m.client = meshclient.New("unreachable") // enabled, but the sidecar does not answer
	m.onMesh["db"] = true
	r := ShellRunner{Mesh: m}
	for _, cmd := range []cmdMsg{{Cmd: "meshShare", Name: "db", Port: 5432}, {Cmd: "meshConnect", Name: "db", Ticket: "t", Port: 15432}} {
		if res := RunCmd(t.Context(), cmd, r); res.OK || !strings.Contains(res.Error, "on the authenticated mesh") {
			t.Fatalf("%s: %+v", cmd.Cmd, res)
		}
	}
	if res := RunCmd(t.Context(), cmdMsg{Cmd: "meshDrop", Name: "db"}, r); !res.OK {
		t.Fatalf("meshDrop: %+v", res)
	}
}
