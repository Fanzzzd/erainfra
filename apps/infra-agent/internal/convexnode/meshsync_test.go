//go:build !windows

package convexnode

import (
	"context"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Fanzzzd/erainfra/apps/infra-agent/internal/agent"
	"github.com/Fanzzzd/erainfra/apps/infra-agent/internal/meshclient"
	"github.com/Fanzzzd/erainfra/apps/infra-agent/internal/meshclient/meshtest"
)

// meshNode is one connect-convex Infra Agent driven tick by tick on a fake clock: the production
// Client and meshLoop, the production MeshManager and NDJSON client, a fake sidecar on a real
// Unix socket and a fake Convex over HTTP.
type meshNode struct {
	t          *testing.T
	credential string
	client     *Client
	sidecar    *meshtest.Sidecar
	manager    *agent.MeshManager
	loop       *meshLoop
	clock      time.Time
	mu         sync.Mutex
	logs       []string
}

func newMeshNode(t *testing.T, f *fakeConvex, name string) *meshNode {
	t.Helper()
	n := &meshNode{t: t, credential: f.enroll(name), sidecar: meshtest.Start(t), clock: time.Date(2026, 11, 6, 0, 0, 0, 0, time.UTC)}
	c, err := New(Config{URL: f.server.URL, Credential: n.credential, StateDir: privateDir(t), AllowHTTPForTests: true}, &fakeExecutor{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	c.now = func() time.Time { return n.clock }
	n.client = c
	control, err := os.MkdirTemp("", "mc-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(control) })
	n.manager, err = agent.OpenMesh(t.Context(), agent.MeshOptions{Socket: n.sidecar.Socket, Dir: control})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = n.manager.Close() })
	n.loop = newMeshLoop(c, MeshOptions{
		Sidecar: n.manager,
		Relays:  meshclient.Relays{URLs: []string{"https://relay.example"}, AuthToken: "relay-secret"},
		Poll:    time.Second, Settle: 3 * time.Second, MinPublishGap: 30 * time.Second, StatePoll: 10 * time.Second,
		Logf: func(format string, args ...any) {
			n.mu.Lock()
			defer n.mu.Unlock()
			n.logs = append(n.logs, fmt.Sprintf(format, args...))
		},
	})
	return n
}

// heartbeat runs one command-loop step with a fresh heartbeat, as the next 15-second poll would.
func (n *meshNode) heartbeat() {
	n.t.Helper()
	n.client.lastHeartbeat = time.Time{}
	if _, err := n.client.Step(n.t.Context()); err != nil {
		n.t.Fatal(err)
	}
}

// advance moves the clock and runs one mesh tick.
func (n *meshNode) advance(d time.Duration) {
	n.clock = n.clock.Add(d)
	n.loop.tick(n.t.Context())
}

func (n *meshNode) logged(substr string) int {
	n.mu.Lock()
	defer n.mu.Unlock()
	count := 0
	for _, l := range n.logs {
		if strings.Contains(l, substr) {
			count++
		}
	}
	return count
}

func peerOf(s *meshtest.Sidecar, direct ...string) meshclient.Peer {
	return meshclient.Peer{ID: s.ID(), RelayURLs: []string{}, DirectAddrs: direct}
}

// Challenge, sign by the sidecar, publish; then the declared link's snapshot reaches the sidecar.
func TestConnectConvexPublishesWithProofThenAppliesSnapshot(t *testing.T) {
	f := newFakeConvex(t)
	a := newMeshNode(t, f, "a")
	peer := f.enroll("b")
	_, keyB, _ := ed25519.GenerateKey(nil)
	idB := hex.EncodeToString(keyB.Public().(ed25519.PublicKey))
	f.prove(peer, meshclient.Peer{ID: idB, RelayURLs: []string{}, DirectAddrs: []string{"192.0.2.7:4433"}})
	f.link("db", a.credential, peer, 5432, 0)

	a.advance(0)
	if challenges, _, _, _ := f.counts(); challenges != 0 {
		t.Fatal("published before the first heartbeat said which key Convex holds")
	}
	a.heartbeat()
	a.sidecar.SetAddr([]string{"https://relay.example/"}, []string{"10.0.0.2:41641", "127.0.0.1:41641", "10.0.0.2:41641"})
	a.advance(0)
	a.advance(time.Second)
	if challenges, _, _, _ := f.counts(); challenges != 0 {
		t.Fatal("published an address before it settled")
	}
	a.advance(2 * time.Second)
	challenges, publishes, full, _ := f.counts()
	if challenges != 1 || publishes != 1 || full != 1 {
		t.Fatalf("challenges=%d publishes=%d state=%d", challenges, publishes, full)
	}
	// The sidecar signed exactly the bytes Convex issued, and Convex verified them.
	signed := a.sidecar.Signed()
	if len(signed) != 1 || !strings.Contains(signed[0], challengeNote) || !strings.HasPrefix(signed[0], "erainfra/node-endpoint/v1\n{") {
		t.Fatalf("signed %q", signed)
	}
	registered, addr := f.registered(a.credential)
	want := meshclient.Peer{ID: a.sidecar.ID(), RelayURLs: []string{"https://relay.example/"}, DirectAddrs: []string{"10.0.0.2:41641", "127.0.0.1:41641"}}
	if registered != a.sidecar.ID() || addr == nil || !samePeer(*addr, want) {
		t.Fatalf("registered %s at %+v", registered, addr)
	}
	exposures := a.sidecar.Exposures()
	if len(exposures) != 1 || exposures["db"].Target != "127.0.0.1:5432" || !sameSet(exposures["db"].AllowedPeers, []string{idB}) {
		t.Fatalf("exposures %+v", exposures)
	}
	if fleet := a.sidecar.Fleet(); len(fleet) != 1 || fleet[0].ID != idB {
		t.Fatalf("fleet %+v", fleet)
	}
	// The Node's relay policy, token included, reaches the sidecar but not the local record.
	if r := a.sidecar.Relays(); r.AuthToken != "relay-secret" || len(r.URLs) != 1 {
		t.Fatalf("relays %+v", r)
	}
	record, err := os.ReadFile(filepath.Join(a.client.cfg.StateDir, "desired.json"))
	if err != nil || strings.Contains(string(record), "relay-secret") || !strings.Contains(string(record), idB) {
		t.Fatalf("desired.json %s %v", record, err)
	}
}

// A new address is republished once it settles, a flapping one is not, and publications are
// bounded by MinPublishGap.
func TestConnectConvexRepublishesChangedAddressWithDebounceAndRateBound(t *testing.T) {
	f := newFakeConvex(t)
	a := newMeshNode(t, f, "a")
	a.heartbeat()
	a.advance(0)
	a.advance(3 * time.Second)
	if _, publishes, _, _ := f.counts(); publishes != 1 {
		t.Fatal("first publication")
	}
	// A reordered status is not a change.
	a.sidecar.SetAddr(nil, []string{"127.0.0.1:41641"})
	for range 40 {
		a.advance(time.Second)
	}
	if _, publishes, _, _ := f.counts(); publishes != 1 {
		t.Fatalf("republished an unchanged address: %d", publishes)
	}
	// Flapping between networks every second never settles.
	for i := range 20 {
		a.sidecar.SetAddr(nil, []string{fmt.Sprintf("198.51.100.%d:41641", i)})
		a.advance(time.Second)
	}
	if _, publishes, _, _ := f.counts(); publishes != 1 {
		t.Fatalf("published a flapping address: %d", publishes)
	}
	// Settled: published after Settle, since the last attempt was long enough ago.
	a.sidecar.SetAddr(nil, []string{"203.0.113.9:41641"})
	a.advance(time.Second)
	a.advance(3 * time.Second)
	if _, publishes, _, _ := f.counts(); publishes != 2 {
		t.Fatalf("settled change not republished: %d", publishes)
	}
	if _, addr := f.registered(a.credential); addr == nil || addr.DirectAddrs[0] != "203.0.113.9:41641" {
		t.Fatalf("registered %+v", addr)
	}
	// Another settled change right away waits for MinPublishGap.
	a.sidecar.SetAddr(nil, []string{"203.0.113.10:41641"})
	for range 10 {
		a.advance(time.Second)
	}
	if _, publishes, _, _ := f.counts(); publishes != 2 {
		t.Fatalf("publication rate not bounded: %d", publishes)
	}
	for range 25 {
		a.advance(time.Second)
	}
	if _, publishes, _, _ := f.counts(); publishes != 3 {
		t.Fatalf("change never republished: %d", publishes)
	}
}

// A changed key on a registered Node is refused by Convex, logged loudly and not retried; an
// operator reset lets the new key publish.
func TestConnectConvexSurfacesAKeyChangeRefusalWithoutRetrying(t *testing.T) {
	f := newFakeConvex(t)
	a := newMeshNode(t, f, "a")
	a.heartbeat()
	a.advance(0)
	a.advance(3 * time.Second)
	old := a.sidecar.ID()
	if registered, _ := f.registered(a.credential); registered != old {
		t.Fatal("not published")
	}
	a.heartbeat()
	a.sidecar.Rekey()
	for range 121 {
		a.advance(5 * time.Second) // just over ten minutes
	}
	challenges, publishes, _, _ := f.counts()
	if challenges != 1 || publishes != 1 {
		t.Fatalf("retried a refused key: challenges=%d publishes=%d", challenges, publishes)
	}
	if a.logged("ERROR: Convex refused mesh key "+a.sidecar.ID()) < 1 || a.logged("resetEndpoint") < 1 || a.logged(old) < 1 {
		t.Fatalf("refusal not surfaced: %q", a.logs)
	}
	// One reminder per ten minutes, not one per poll.
	if n := a.logged("ERROR"); n != 2 {
		t.Fatalf("%d refusal lines in ten minutes", n)
	}
	// The heartbeat said the old key, so no challenge was even requested for the new one. A
	// stale heartbeat that has not seen the registration yet gets the refusal from Convex itself.
	b := newMeshNode(t, f, "b")
	b.heartbeat() // Convex holds no key for b yet...
	// ...and then registers another one before b's next heartbeat.
	f.prove(b.credential, meshclient.Peer{ID: strings.Repeat("ab", 32), RelayURLs: []string{}, DirectAddrs: []string{}})
	b.advance(0)
	b.advance(3 * time.Second)
	for range 30 {
		b.advance(5 * time.Second)
	}
	if b.logged("ERROR: Convex refused mesh key") != 1 {
		t.Fatalf("Convex's refusal not surfaced once: %q", b.logs)
	}
	if challenges, _, _, _ := f.counts(); challenges != 2 {
		t.Fatalf("challenge retried after a refusal: %d", challenges)
	}

	// The operator resets a's endpoint; the next heartbeat shows it and the new key publishes.
	f.reset(a.credential)
	a.advance(5 * time.Second)
	if _, publishes, _, _ := f.counts(); publishes != 1 {
		t.Fatal("acted on a reset before a heartbeat showed it")
	}
	a.heartbeat()
	a.advance(time.Second)
	a.advance(3 * time.Second)
	if registered, _ := f.registered(a.credential); registered != a.sidecar.ID() {
		t.Fatalf("new key not published after reset: %s", registered)
	}
	if a.logged("refusal is resolved") != 1 {
		t.Fatalf("%q", a.logs)
	}
}

// A key another Node holds is refused as endpoint_in_use and never retried.
func TestConnectConvexKeyHeldByAnotherNodeIsRefusedOnce(t *testing.T) {
	f := newFakeConvex(t)
	a := newMeshNode(t, f, "a")
	other := f.enroll("other")
	f.prove(other, peerOf(a.sidecar, "127.0.0.1:1"))
	a.heartbeat()
	for range 100 {
		a.advance(5 * time.Second)
	}
	if challenges, publishes, _, _ := f.counts(); challenges != 1 || publishes != 0 {
		t.Fatalf("challenges=%d publishes=%d", challenges, publishes)
	}
	if a.logged("another Node already registered it") != 1 {
		t.Fatalf("%q", a.logs)
	}
	if len(a.sidecar.Exposures())+len(a.sidecar.Links()) != 0 || a.sidecar.Ops("set_fleet") != 0 {
		t.Fatal("applied a snapshot for a key Convex refused")
	}
}

// An unchanged revision applies nothing; a changed one applies; sidecar drift re-applies.
func TestConnectConvexAppliesOnlyChangedRevisions(t *testing.T) {
	f := newFakeConvex(t)
	a := newMeshNode(t, f, "a")
	peer := f.enroll("b")
	f.prove(peer, meshclient.Peer{ID: strings.Repeat("bb", 32), RelayURLs: []string{}, DirectAddrs: []string{"192.0.2.7:4433"}})
	f.link("db", a.credential, peer, 5432, 0)
	a.heartbeat()
	a.advance(0)
	a.advance(3 * time.Second)
	exposes := a.sidecar.Ops("expose")
	if exposes != 1 {
		t.Fatalf("first apply: %d", exposes)
	}
	for range 60 {
		a.advance(time.Second)
	}
	_, _, full, unchanged := f.counts()
	if full != 1 || unchanged != 6 {
		t.Fatalf("state polls: full=%d unchanged=%d", full, unchanged)
	}
	if a.sidecar.Ops("expose") != exposes || a.sidecar.Ops("set_fleet") != 2 {
		t.Fatalf("an unchanged revision was applied: expose=%d set_fleet=%d", a.sidecar.Ops("expose"), a.sidecar.Ops("set_fleet"))
	}
	f.link("cache", peer, a.credential, 6379, 16379)
	a.advance(10 * time.Second)
	if links := a.sidecar.Links(); len(links) != 1 || links["cache"].Listen != "127.0.0.1:16379" {
		t.Fatalf("changed revision not applied: %+v", links)
	}
	// The sidecar restarted without its state: re-applied from the last snapshot, no fetch.
	_, _, full, _ = f.counts()
	a.sidecar.Forget()
	a.advance(time.Second)
	if len(a.sidecar.Exposures()) != 1 || len(a.sidecar.Links()) != 1 {
		t.Fatal("drift not repaired")
	}
	if _, _, again, _ := f.counts(); again != full {
		t.Fatal("drift repair fetched the snapshot")
	}
}

// A mesh state Convex refuses (for example a conflicting link name) must not stop commands.
func TestMeshStateFailureDoesNotBlockCommands(t *testing.T) {
	f := newFakeConvex(t)
	a := newMeshNode(t, f, "a")
	f.mu.Lock()
	f.stateStatus = http.StatusConflict
	f.commands = []map[string]string{{"node": a.credential, "id": "cmd-1", "key": "restart-1"}}
	f.mu.Unlock()
	a.heartbeat()
	a.advance(0)
	a.advance(3 * time.Second)
	a.advance(time.Minute)
	f.mu.Lock()
	result := f.results["cmd-1"]
	f.mu.Unlock()
	if result != "success" {
		t.Fatalf("command blocked behind mesh state: %q", result)
	}
	if a.logged("fetching the mesh snapshot failed") != 2 {
		t.Fatalf("%q", a.logs)
	}
}

// Run starts the mesh loop beside the command loop and stops both with the context.
func TestRunDrivesTheMeshLoop(t *testing.T) {
	f := newFakeConvex(t)
	a := newMeshNode(t, f, "a")
	a.client.now = time.Now
	a.client.Mesh = &MeshOptions{Sidecar: a.manager, Poll: 10 * time.Millisecond, Settle: 10 * time.Millisecond, MinPublishGap: 50 * time.Millisecond, StatePoll: 20 * time.Millisecond, Logf: func(string, ...any) {}}
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error)
	go func() { done <- a.client.Run(ctx) }()
	deadline := time.Now().Add(10 * time.Second)
	for {
		if registered, _ := f.registered(a.credential); registered == a.sidecar.ID() {
			if _, _, full, _ := f.counts(); full > 0 {
				break
			}
		}
		if time.Now().After(deadline) {
			t.Fatal("Run never published or fetched the snapshot")
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	select {
	case err := <-done:
		if err == nil || ctx.Err() == nil {
			t.Fatalf("Run returned %v before its context ended", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not stop")
	}
}

// The signature the sidecar returns verifies over the challenge as Convex stored it.
func TestChallengeBytesSurviveTheAgent(t *testing.T) {
	f := newFakeConvex(t)
	a := newMeshNode(t, f, "a")
	a.heartbeat()
	if err := a.client.publishEndpoint(t.Context(), a.manager, publishable(peerOf(a.sidecar, "127.0.0.1:41641"))); err != nil {
		t.Fatal(err)
	}
	signed := a.sidecar.Signed()[0]
	var parsed map[string]any
	if json.Unmarshal([]byte(strings.TrimPrefix(signed, "erainfra/node-endpoint/v1\n")), &parsed) != nil || parsed["note"] != challengeNote {
		t.Fatalf("message changed on the way to the sidecar: %q", signed)
	}
}
