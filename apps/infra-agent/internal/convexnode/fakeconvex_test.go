//go:build !windows

package convexnode

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Fanzzzd/erainfra/apps/infra-agent/internal/meshclient"
)

// fakeConvex serves the Node routes the way packages/backend/convex/infra does for the mesh:
// heartbeat reports the registered key, a challenge refuses a key change before signing, publish
// verifies the Ed25519 signature over the exact bytes it issued, and state derives each Node's
// snapshot from declared links between proven Nodes, conditional on the revision.
type fakeConvex struct {
	mu         sync.Mutex
	server     *httptest.Server
	nodes      map[string]*fakeNode // by credential
	links      []fakeLink
	routes     []fakeRoute
	gateways   map[string]bool // by credential
	challenges map[string]fakeChallenge
	next       int

	stateStatus int // non-zero: state answers with this status and a refusal body
	commands    []map[string]string
	results     map[string]string

	challengeCount, publishCount, stateFull, stateUnchanged int
	refusals                                                []string
}
type fakeNode struct {
	id, name    string
	registered  string
	address     *meshclient.Peer
	commandSent bool
}
type fakeLink struct {
	name                 string
	provider, consumer   string // credentials
	providerPort, listen int
	// bridge marks an App dependency link, whose consumer listens on the Docker bridge.
	bridge bool
}

// fakeRoute is an appRoutes row; listen is the gateway-side ingress port Convex derives.
type fakeRoute struct {
	host         string
	provider     string // credential of the App's Node
	port, listen int
}

type fakeChallenge struct {
	credential string
	address    meshclient.Peer
	message    string
	expires    time.Time
}

// Messages carry characters Go's JSON encoder escapes (<, >, &, U+2028) and non-ASCII text, so a
// test that verifies a signature also proves the bytes survived decode and re-encode unchanged.
const challengeNote = "节点 <&> \u2028 end"

func newFakeConvex(t *testing.T) *fakeConvex {
	t.Helper()
	f := &fakeConvex{nodes: map[string]*fakeNode{}, challenges: map[string]fakeChallenge{}, results: map[string]string{}, gateways: map[string]bool{}}
	f.server = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.server.Close)
	return f
}

func (f *fakeConvex) enroll(name string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	credential := "erainfra_node_" + fmt.Sprintf("%064x", sha256.Sum256([]byte(name)))
	f.nodes[credential] = &fakeNode{id: "node-" + name, name: name}
	return credential
}

// prove registers a Node directly, as if it had published key with a valid proof earlier.
func (f *fakeConvex) prove(credential string, addr meshclient.Peer) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.nodes[credential].registered, f.nodes[credential].address = addr.ID, &addr
}

// reset is infra/nodes:resetEndpoint.
func (f *fakeConvex) reset(credential string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.nodes[credential].registered, f.nodes[credential].address = "", nil
	for id, c := range f.challenges {
		if c.credential == credential {
			delete(f.challenges, id)
		}
	}
}

func (f *fakeConvex) link(name, provider, consumer string, providerPort, listen int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.links = append(f.links, fakeLink{name: name, provider: provider, consumer: consumer, providerPort: providerPort, listen: listen})
}

// appLink declares an App dependency link, as the deploy pipeline records one (nodeState.ts).
func (f *fakeConvex) appLink(name, provider, consumer string, providerPort, listen int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.links = append(f.links, fakeLink{name: name, provider: provider, consumer: consumer, providerPort: providerPort, listen: listen, bridge: true})
}

// route upserts an appRoutes row by host, as deploy and failover do.
func (f *fakeConvex) route(host, provider string, port, listen int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i, r := range f.routes {
		if r.host == host {
			f.routes[i] = fakeRoute{host: host, provider: provider, port: port, listen: listen}
			return
		}
	}
	f.routes = append(f.routes, fakeRoute{host: host, provider: provider, port: port, listen: listen})
}

// gateway is infra/nodes:setPlacementRoles with or without "gateway".
func (f *fakeConvex) gateway(credential string, on bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.gateways[credential] = on
}

func (f *fakeConvex) registered(credential string) (string, *meshclient.Peer) {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := f.nodes[credential]
	return n.registered, n.address
}

func (f *fakeConvex) counts() (challenges, publishes, full, unchanged int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.challengeCount, f.publishCount, f.stateFull, f.stateUnchanged
}

func (f *fakeConvex) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	credential := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	node := f.nodes[credential]
	if node == nil {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	send := func(v any) { _ = json.NewEncoder(w).Encode(v) }
	refuse := func(code string) {
		f.refusals = append(f.refusals, code)
		w.WriteHeader(http.StatusConflict)
		send(map[string]string{"error": code})
	}
	switch r.URL.Path {
	case "/api/v1/nodes/heartbeat":
		var registered any
		if node.registered != "" {
			registered = node.registered
		}
		send(map[string]any{"nodeId": node.id, "heartbeatAfterMs": 15000, "endpointId": registered})
	case "/api/v1/nodes/endpoint/challenge":
		var body struct {
			Address meshclient.Peer `json:"address"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil || !meshclient.ValidID(body.Address.ID) || len(body.Address.RelayURLs) > 8 || len(body.Address.DirectAddrs) > 16 || body.Address.RelayURLs == nil || body.Address.DirectAddrs == nil {
			refuse("request_refused")
			return
		}
		f.challengeCount++
		if node.registered != "" && node.registered != body.Address.ID {
			refuse("endpoint_key_changed")
			return
		}
		for c, other := range f.nodes {
			if c != credential && other.registered == body.Address.ID {
				refuse("endpoint_in_use")
				return
			}
		}
		nonce := make([]byte, 32)
		_, _ = rand.Read(nonce)
		f.next++
		id := fmt.Sprintf("challenge-%d", f.next)
		f.challenges[id] = fakeChallenge{credential: credential, address: body.Address, message: "erainfra/node-endpoint/v1\n" + stringify(map[string]any{"nodeId": node.id, "nonce": hex.EncodeToString(nonce), "note": challengeNote, "address": body.Address}), expires: time.Now().Add(time.Minute)}
		send(map[string]any{"challengeId": id, "message": f.challenges[id].message, "algorithm": "Ed25519", "encoding": "UTF-8", "signatureEncoding": "base64"})
	case "/api/v1/nodes/endpoint":
		var body struct {
			ChallengeID string `json:"challengeId"`
			Signature   string `json:"signature"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil {
			refuse("request_refused")
			return
		}
		c, ok := f.challenges[body.ChallengeID]
		delete(f.challenges, body.ChallengeID)
		key, _ := hex.DecodeString(c.address.ID)
		sig, err := base64.StdEncoding.DecodeString(body.Signature)
		if !ok || c.credential != credential || time.Now().After(c.expires) || err != nil || len(key) != ed25519.PublicKeySize || !ed25519.Verify(key, []byte(c.message), sig) {
			refuse("request_refused")
			return
		}
		if node.registered != "" && node.registered != c.address.ID {
			refuse("endpoint_key_changed")
			return
		}
		f.publishCount++
		addr := c.address
		node.registered, node.address = addr.ID, &addr
		send(map[string]bool{"published": true})
	case "/api/v1/nodes/state":
		if f.stateStatus != 0 {
			w.WriteHeader(f.stateStatus)
			send(map[string]string{"error": "request_refused"})
			return
		}
		snapshot := f.desired(credential)
		text, _ := json.Marshal(snapshot)
		sum := sha256.Sum256(text)
		revision := hex.EncodeToString(sum[:])
		if r.URL.Query().Get("revision") == revision {
			f.stateUnchanged++
			send(map[string]any{"revision": revision, "unchanged": true})
			return
		}
		f.stateFull++
		send(map[string]any{"revision": revision, "unchanged": false, "desired": snapshot})
	case "/api/v1/nodes/commands":
		commands := []map[string]string{}
		if !node.commandSent {
			for _, c := range f.commands {
				if c["node"] == credential {
					commands = append(commands, map[string]string{"id": c["id"], "idempotencyKey": c["key"], "kind": "operate"})
				}
			}
		}
		send(map[string]any{"cursor": nil, "commands": commands})
	case "/api/v1/nodes/commands/claim":
		send(map[string]any{"epoch": 1, "leaseUntil": time.Now().Add(time.Minute).UnixMilli()})
	case "/api/v1/nodes/commands/payload":
		send(map[string]any{"kind": "operate", "operation": map[string]any{"name": "systemctl.restart", "args": map[string]string{"unit": "portless-agent"}}})
	case "/api/v1/nodes/commands/renew":
		send(nil)
	case "/api/v1/nodes/commands/result":
		var b map[string]any
		_ = json.NewDecoder(r.Body).Decode(&b)
		id, _ := b["commandId"].(string)
		f.results[id], _ = b["outcome"].(string)
		node.commandSent = true
		send(nil)
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

// stringify encodes like JavaScript's JSON.stringify, which Convex uses for the message: no HTML
// escaping and U+2028 left raw, unlike Go's encoder.
func stringify(v any) string {
	var b strings.Builder
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
	return strings.ReplaceAll(strings.TrimSuffix(b.String(), "\n"), `\u2028`, "\u2028")
}

// desired mirrors nodeState.desired: only declared links involving this Node, only proven peers,
// exact consumer grants, sorted output.
func (f *fakeConvex) desired(credential string) DesiredMesh {
	d := DesiredMesh{V: 1, Fleet: []MeshPeer{}, Relays: MeshRelays{Relays: []string{}}, Exposures: []MeshExposure{}, Links: []MeshLink{}}
	peers := map[string]MeshPeer{}
	exposures := map[string]*MeshExposure{}
	for _, l := range f.links {
		if l.provider != credential && l.consumer != credential {
			continue
		}
		other := l.provider
		if other == credential {
			other = l.consumer
		}
		peer := f.nodes[other]
		if peer.address == nil {
			continue
		}
		peers[peer.address.ID] = MeshPeer{ID: peer.address.ID, RelayURLs: peer.address.RelayURLs, DirectAddrs: peer.address.DirectAddrs}
		if l.provider == credential {
			e := exposures[l.name]
			if e == nil {
				e = &MeshExposure{Name: l.name, Target: fmt.Sprintf("127.0.0.1:%d", l.providerPort), AllowedPeers: []string{}}
				exposures[l.name] = e
			}
			e.AllowedPeers = append(e.AllowedPeers, peer.address.ID)
		} else {
			listen := fmt.Sprintf("127.0.0.1:%d", l.listen)
			if l.bridge {
				listen, d.V = fmt.Sprintf("bridge:%d", l.listen), 2
			}
			d.Links = append(d.Links, MeshLink{Name: l.name, Peer: peer.address.ID, Service: l.name, Listen: listen})
		}
	}
	// Ingress, as infra/ingress.ts derives it: the App's Node exposes each route to exactly the
	// proven gateways, and a gateway links to each route and receives the table.
	maxConn := uint32(1024)
	for _, r := range f.routes {
		if r.provider != credential {
			continue
		}
		allowed := []string{}
		for g, on := range f.gateways {
			if on && g != credential && f.nodes[g].address != nil {
				a := f.nodes[g].address
				allowed = append(allowed, a.ID)
				peers[a.ID] = MeshPeer{ID: a.ID, RelayURLs: a.RelayURLs, DirectAddrs: a.DirectAddrs}
			}
		}
		if len(allowed) > 0 {
			sort.Strings(allowed)
			exposures["ingress."+r.host] = &MeshExposure{Name: "ingress." + r.host, Target: fmt.Sprintf("127.0.0.1:%d", r.port), AllowedPeers: allowed, MaxConnections: &maxConn}
		}
	}
	if f.gateways[credential] {
		d.Ingress = &MeshIngress{Routes: []IngressRoute{}}
		for _, r := range f.routes {
			var upstream *string
			switch app := f.nodes[r.provider]; {
			case r.provider == credential:
				u := fmt.Sprintf("127.0.0.1:%d", r.port)
				upstream = &u
			case app.address != nil:
				u := fmt.Sprintf("127.0.0.1:%d", r.listen)
				upstream = &u
				peers[app.address.ID] = MeshPeer{ID: app.address.ID, RelayURLs: app.address.RelayURLs, DirectAddrs: app.address.DirectAddrs}
				d.Links = append(d.Links, MeshLink{Name: "ingress." + r.host, Peer: app.address.ID, Service: "ingress." + r.host, Listen: u, MaxConnections: &maxConn})
			}
			d.Ingress.Routes = append(d.Ingress.Routes, IngressRoute{Host: r.host, Upstream: upstream})
		}
		sort.Slice(d.Ingress.Routes, func(i, j int) bool { return d.Ingress.Routes[i].Host < d.Ingress.Routes[j].Host })
	}
	for _, p := range peers {
		d.Fleet = append(d.Fleet, p)
	}
	sort.Slice(d.Fleet, func(i, j int) bool { return d.Fleet[i].ID < d.Fleet[j].ID })
	for _, e := range exposures {
		sort.Strings(e.AllowedPeers)
		d.Exposures = append(d.Exposures, *e)
	}
	sort.Slice(d.Exposures, func(i, j int) bool { return d.Exposures[i].Name < d.Exposures[j].Name })
	sort.Slice(d.Links, func(i, j int) bool { return d.Links[i].Name < d.Links[j].Name })
	return d
}
