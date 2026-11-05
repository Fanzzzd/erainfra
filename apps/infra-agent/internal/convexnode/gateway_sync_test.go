//go:build !windows

package convexnode

import (
	"crypto/ed25519"
	"encoding/hex"
	"net/http"
	"path/filepath"
	"testing"
	"time"

	"github.com/Fanzzzd/erainfra/apps/infra-agent/internal/gateway"
	"github.com/Fanzzzd/erainfra/apps/infra-agent/internal/meshclient"
)

// provenPeer enrolls a Node in the fake Convex that has already proven a fresh key.
func provenPeer(f *fakeConvex, name string) (credential, id string) {
	credential = f.enroll(name)
	_, key, _ := ed25519.GenerateKey(nil)
	id = hex.EncodeToString(key.Public().(ed25519.PublicKey))
	f.prove(credential, meshclient.Peer{ID: id, RelayURLs: []string{}, DirectAddrs: []string{"192.0.2.7:4433"}})
	return credential, id
}

func readRoutes(t *testing.T, path string) gateway.Table {
	t.Helper()
	tb, err := gateway.ReadTable(path)
	if err != nil {
		t.Fatal(err)
	}
	return tb
}

func upstreamOf(tb gateway.Table, host string) string {
	for _, r := range tb.Routes {
		if r.Host == host {
			if r.Upstream == nil {
				return "<none>"
			}
			return *r.Upstream
		}
	}
	return ""
}

// A gateway applies its ingress links, then writes the route table under the snapshot's
// revision. While Convex is unreachable the file is left alone, and a route change (failover)
// reaches both the sidecar and the file once Convex answers again.
func TestGatewayWritesTheRouteTableAndKeepsItWhileConvexIsDown(t *testing.T) {
	f := newFakeConvex(t)
	g := newMeshNode(t, f, "gw")
	routes := filepath.Join(t.TempDir(), "routes.json")
	g.loop.o.RoutesFile = routes
	app1, id1 := provenPeer(f, "app-1")
	app2, id2 := provenPeer(f, "app-2")
	f.route("web", app1, 62001, 61234)
	f.gateway(g.credential, true)

	g.heartbeat()
	g.advance(0)
	g.advance(3 * time.Second)
	tb := readRoutes(t, routes)
	if !tb.Gateway || tb.Revision == "" || upstreamOf(tb, "web") != "127.0.0.1:61234" || len(tb.Routes) != 1 {
		t.Fatalf("route table %+v", tb)
	}
	link := g.sidecar.Links()["ingress.web"]
	if link.Peer != id1 || link.Listen != "127.0.0.1:61234" || link.MaxConnections == nil || *link.MaxConnections != 1024 {
		t.Fatalf("ingress link %+v", link)
	}
	first := tb.Revision

	// Convex goes away, and failover moves the route meanwhile. Nothing changes locally.
	f.mu.Lock()
	f.stateStatus = http.StatusServiceUnavailable
	f.mu.Unlock()
	f.route("web", app2, 62001, 61234)
	for range 6 {
		g.advance(10 * time.Second)
	}
	if tb := readRoutes(t, routes); tb.Revision != first || upstreamOf(tb, "web") != "127.0.0.1:61234" {
		t.Fatalf("route table changed while Convex was down: %+v", tb)
	}
	if g.sidecar.Links()["ingress.web"].Peer != id1 {
		t.Fatal("ingress link changed while Convex was down")
	}
	if g.logged("keeping the last applied one") == 0 {
		t.Fatal("the outage was not logged")
	}

	// Convex is back: the next state poll moves the link, then the file follows.
	f.mu.Lock()
	f.stateStatus = 0
	f.mu.Unlock()
	g.advance(10 * time.Second)
	if g.sidecar.Links()["ingress.web"].Peer != id2 {
		t.Fatalf("failover not applied: %+v", g.sidecar.Links())
	}
	tb = readRoutes(t, routes)
	if tb.Revision == first || upstreamOf(tb, "web") != "127.0.0.1:61234" {
		t.Fatalf("route table after failover %+v", tb)
	}

	// The role is removed: links go, and the proxy gets an empty table.
	f.gateway(g.credential, false)
	g.advance(10 * time.Second)
	tb = readRoutes(t, routes)
	if tb.Gateway || len(tb.Routes) != 0 || len(g.sidecar.Links()) != 0 {
		t.Fatalf("after removing the role: %+v links=%+v", tb, g.sidecar.Links())
	}
}

// A Node that is not a gateway gets no routes, and an unreachable App stays in a gateway's table
// with no upstream, so the proxy answers 503 for it instead of 404.
func TestNonGatewayGetsNoRoutesAndUnreachableAppsHaveNoUpstream(t *testing.T) {
	f := newFakeConvex(t)
	plain := newMeshNode(t, f, "plain")
	plainRoutes := filepath.Join(t.TempDir(), "routes.json")
	plain.loop.o.RoutesFile = plainRoutes
	app, _ := provenPeer(f, "app")
	unproven := f.enroll("unproven")
	f.route("web", app, 62001, 61234)
	f.route("api", unproven, 62002, 61235)

	plain.heartbeat()
	plain.advance(0)
	plain.advance(3 * time.Second)
	if tb := readRoutes(t, plainRoutes); tb.Gateway || len(tb.Routes) != 0 {
		t.Fatalf("non-gateway route table %+v", tb)
	}
	if len(plain.sidecar.Links()) != 0 || len(plain.sidecar.Exposures()) != 0 {
		t.Fatal("non-gateway received ingress grants")
	}

	f.gateway(plain.credential, true)
	plain.advance(10 * time.Second)
	tb := readRoutes(t, plainRoutes)
	if upstreamOf(tb, "api") != "<none>" || upstreamOf(tb, "web") != "127.0.0.1:61234" {
		t.Fatalf("gateway route table %+v", tb)
	}
	if _, ok := plain.sidecar.Links()["ingress.api"]; ok {
		t.Fatal("linked to a Node with no proven key")
	}
}

// Convex marks the Node a gateway but the agent has nowhere to put the routes: say so once.
func TestGatewayWithoutRoutesFileWarns(t *testing.T) {
	f := newFakeConvex(t)
	g := newMeshNode(t, f, "gw")
	app, _ := provenPeer(f, "app")
	f.route("web", app, 62001, 61234)
	f.gateway(g.credential, true)
	g.heartbeat()
	g.advance(0)
	g.advance(3 * time.Second)
	for range 3 {
		g.advance(10 * time.Second)
	}
	if n := g.logged("ERAINFRA_GATEWAY_ROUTES_FILE is not set"); n != 1 {
		t.Fatalf("warned %d times", n)
	}
}

// Routes past the gateway's mesh budget are an operator problem: logged as an error per revision.
func TestGatewayLogsRoutesPastItsBudget(t *testing.T) {
	f := newFakeConvex(t)
	g := newMeshNode(t, f, "gw")
	g.loop.o.RoutesFile = filepath.Join(t.TempDir(), "routes.json")
	app, _ := provenPeer(f, "app")
	f.route("web", app, 62001, 61234)
	f.gateway(g.credential, true)
	f.mu.Lock()
	f.overflow = 3
	f.mu.Unlock()
	g.heartbeat()
	g.advance(0)
	g.advance(3 * time.Second)
	g.advance(10 * time.Second)
	if n := g.logged("ERROR: 3 routes do not fit"); n != 1 {
		t.Fatalf("logged %d times", n)
	}
}

// A snapshot whose route table would point the proxy off loopback is refused whole, and the
// last applied snapshot and table stay.
func TestSnapshotWithANonLoopbackUpstreamIsRefused(t *testing.T) {
	bad := []byte(`{"v":1,"fleet":[],"relays":{"relays":[],"n0_fallback":false},"exposures":[],"links":[],"ingress":{"routes":[{"host":"web","upstream":"10.0.0.5:80"}]}}`)
	if _, err := decodeIngress(bad); err == nil {
		t.Fatal("accepted a non-loopback upstream")
	}
	ok := []byte(`{"v":1,"fleet":[],"relays":{"relays":[],"n0_fallback":false},"exposures":[],"links":[],"ingress":{"routes":[]}}`)
	if ingress, err := decodeIngress(ok); err != nil || ingress == nil {
		t.Fatalf("empty gateway table: %v %v", ingress, err)
	}
}
