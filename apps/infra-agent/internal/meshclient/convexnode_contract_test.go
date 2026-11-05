package meshclient_test

// An external test package: convexnode imports agent, which imports meshclient, so only a
// meshclient_test file may import convexnode.

import (
	"bytes"
	"encoding/json"
	"testing"

	"github.com/Fanzzzd/erainfra/apps/infra-agent/internal/convexnode"
	"github.com/Fanzzzd/erainfra/apps/infra-agent/internal/meshclient"
)

// The Go type connect-convex decodes the Convex snapshot into is convexnode.DesiredMesh.
// Whatever it holds must re-encode into exactly what this package's Desired accepts, with no field
// dropped or renamed, so the Convex mode can hand its snapshot to the same Reconciler.
func TestConvexnodeDesiredMeshRoundTripsIntoDesired(t *testing.T) {
	var from convexnode.DesiredMesh
	if err := json.Unmarshal([]byte(meshclient.ConvexSnapshot), &from); err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(from)
	if err != nil {
		t.Fatal(err)
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	var d meshclient.Desired
	if err := dec.Decode(&d); err != nil {
		t.Fatalf("convexnode.DesiredMesh does not decode into meshclient.Desired: %v", err)
	}
	if err := d.Validate(); err != nil {
		t.Fatal(err)
	}
	var direct meshclient.Desired
	if err := json.Unmarshal([]byte(meshclient.ConvexSnapshot), &direct); err != nil {
		t.Fatal(err)
	}
	a, _ := json.Marshal(d)
	b, _ := json.Marshal(direct)
	if !bytes.Equal(a, b) {
		t.Fatalf("a field was lost through convexnode.DesiredMesh:\n%s\n%s", a, b)
	}
}
