package meshclient

import (
	"bytes"
	"encoding/json"
	"sync"
	"testing"
)

// The Convex Node API (packages/backend/convex/infra/nodeState.ts desired(), Go side
// convexnode.DesiredMesh) emits this snapshot shape. It must decode into Desired with no
// unknown fields, so connect-convex needs no adapter of its own, and an omitted allowed_peers must
// stay deny-all.
const convexSnapshot = `{"v":1,
	  "fleet":[{"id":"` + testID + `","relay_urls":["https://relay.example.com/"],"direct_addrs":["203.0.113.7:41641"]}],
	  "relays":{"relays":["https://relay.example.com"],"n0_fallback":false},
	  "exposures":[{"name":"db","target":"127.0.0.1:5432","allowed_peers":["` + testID + `"]},{"name":"cache","target":"127.0.0.1:6379"}],
	  "links":[{"name":"api-db","peer":"` + testID + `","service":"db","listen":"127.0.0.1:15432"}]}`

func TestConvexSnapshotDecodesStrictly(t *testing.T) {
	snapshot := convexSnapshot
	dec := json.NewDecoder(bytes.NewReader([]byte(snapshot)))
	dec.DisallowUnknownFields()
	var d Desired
	if err := dec.Decode(&d); err != nil {
		t.Fatalf("Convex snapshot does not match meshclient.Desired: %v", err)
	}
	if err := d.Validate(); err != nil {
		t.Fatal(err)
	}
	if len(d.Exposures[1].AllowedPeers) != 0 {
		t.Fatal("an omitted grant list must be deny-all")
	}
	if d.Relays.AuthToken != "" {
		t.Fatal("phase 2b snapshots carry no relay token")
	}
}

// The same snapshot, fed to the Reconciler, reaches the sidecar as the NDJSON v1 requests the
// sidecar accepts: the fleet as set_fleet peers, each exposure with its exact grant list (an omitted
// one sent as an explicit []), and each link unchanged.
func TestReconcilerAppliesTheConvexSnapshot(t *testing.T) {
	var d Desired
	if err := json.Unmarshal([]byte(convexSnapshot), &d); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	byOp := map[string][]map[string]any{}
	c := fakeClient(t, func(r map[string]any) any {
		mu.Lock()
		defer mu.Unlock()
		op := r["op"].(string)
		byOp[op] = append(byOp[op], r)
		if op == "status" {
			return testStatus()
		}
		return map[string]any{"changed": true}
	})
	if _, err := (&Reconciler{Client: c}).Apply(t.Context(), d, ""); err != nil {
		t.Fatal(err)
	}
	fleet := byOp["set_fleet"][0]["peers"].([]any)[0].(map[string]any)
	if fleet["id"] != testID || fleet["relay_urls"].([]any)[0] != "https://relay.example.com/" || fleet["direct_addrs"].([]any)[0] != "203.0.113.7:41641" {
		t.Fatalf("set_fleet peer: %v", fleet)
	}
	if r := byOp["set_relays"][0]; r["relays"].([]any)[0] != "https://relay.example.com" || r["n0_fallback"] != false {
		t.Fatalf("set_relays: %v", r)
	}
	if _, ok := byOp["set_relays"][0]["auth_token"]; ok {
		t.Fatal("an empty relay token must be omitted, not sent")
	}
	exposed := byOp["expose"]
	if len(exposed) != 2 || exposed[0]["name"] != "db" || exposed[0]["allowed_peers"].([]any)[0] != testID {
		t.Fatalf("expose: %v", exposed)
	}
	if grants, ok := exposed[1]["allowed_peers"].([]any); !ok || len(grants) != 0 {
		t.Fatalf("an omitted grant list must reach the sidecar as an explicit []: %v", exposed[1])
	}
	if l := byOp["link"]; len(l) != 1 || l[0]["peer"] != testID || l[0]["service"] != "db" || l[0]["listen"] != "127.0.0.1:15432" {
		t.Fatalf("link: %v", l)
	}
}
