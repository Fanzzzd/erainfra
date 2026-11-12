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
	if _, err := (&Reconciler{Client: c}).Apply(t.Context(), d); err != nil {
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

// A relay entry with a QUIC address discovery port, as the Hub may now send it, decodes strictly
// and reaches the sidecar as the same object. A plain URL still goes as a string, and an invalid
// entry is refused before anything is sent.
func TestReconcilerSendsRelayQUICPorts(t *testing.T) {
	snapshot := `{"v":1,"fleet":[],"exposures":[],"links":[],
	  "relays":{"relays":[{"url":"https://relay.on99.ai","quic_port":443},"https://relay.example.com",{"url":"https://noqad.example.com","quic":false}],"n0_fallback":false}}`
	dec := json.NewDecoder(bytes.NewReader([]byte(snapshot)))
	dec.DisallowUnknownFields()
	var d Desired
	if err := dec.Decode(&d); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var sent []byte
	c := fakeClient(t, func(r map[string]any) any {
		mu.Lock()
		defer mu.Unlock()
		switch r["op"] {
		case "status":
			return testStatus()
		case "set_relays":
			sent, _ = json.Marshal(r["relays"])
		}
		return map[string]any{"changed": true}
	})
	if _, err := (&Reconciler{Client: c}).Apply(t.Context(), d); err != nil {
		t.Fatal(err)
	}
	want := `[{"quic_port":443,"url":"https://relay.on99.ai"},"https://relay.example.com",{"quic":false,"url":"https://noqad.example.com"}]`
	mu.Lock()
	defer mu.Unlock()
	if string(sent) != want {
		t.Fatalf("set_relays relays\n got %s\nwant %s", sent, want)
	}
	d.Relays.List = []Relay{{URL: "https://r.example.com", NoQUIC: true, QUICPort: 443}}
	if err := d.Validate(); err == nil {
		t.Fatal("a relay with QUIC address discovery off and a port passed validation")
	}
}
