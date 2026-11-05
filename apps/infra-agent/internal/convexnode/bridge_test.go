//go:build !windows

package convexnode

import (
	"context"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Fanzzzd/erainfra/apps/infra-agent/internal/agent"
	"github.com/Fanzzzd/erainfra/apps/infra-agent/internal/meshclient"
)

// The deploy step starts a service that needs another Node's dependency with the host-gateway
// entry the pipeline planned, so host.docker.internal resolves on Linux to the address the
// bridge link listens on.
func TestDeployStartsContainersWithTheHostGatewayEntry(t *testing.T) {
	dir := t.TempDir()
	log := filepath.Join(dir, "calls.log")
	docker := filepath.Join(dir, "docker")
	if err := os.WriteFile(docker, []byte("#!/bin/sh\nprintf '%s\\n' \"$*\" >> '"+log+"'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	p := Payload{Kind: "deploy", App: "shop", Services: []agent.Service{{
		Name:  "web",
		Image: "127.0.0.1:5000/shop-web:abc",
		Args:  []string{"-p", "127.0.0.1:62000:3000", "--add-host=host.docker.internal:host-gateway"},
		Env:   map[string]string{"DB_HOST": "host.docker.internal", "DB_PORT": "62001"},
	}}}
	if got := (LocalExecutor{Runner: agent.ShellRunner{Docker: docker}}).Execute(context.Background(), p); got != "success" {
		t.Fatal(got)
	}
	calls, err := os.ReadFile(log)
	if err != nil {
		t.Fatal(err)
	}
	var run string
	for _, line := range strings.Split(string(calls), "\n") {
		if strings.HasPrefix(line, "run ") {
			run = line
		}
	}
	if !strings.Contains(run, "--add-host=host.docker.internal:host-gateway") || !strings.HasSuffix(run, " 127.0.0.1:5000/shop-web:abc") {
		t.Fatalf("docker run %q", run)
	}
}

// fakeDockerCLI answers `docker network inspect bridge` with out, or fails when out is "fail".
func fakeDockerCLI(t *testing.T, out string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "docker")
	body := "#!/bin/sh\nprintf '%s' '" + out + "'\n"
	if out == "fail" {
		body = "#!/bin/sh\nexit 1\n"
	}
	if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func daemonJSON(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "daemon.json")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestDockerBridgeResolvesWhatHostGatewayResolvesTo(t *testing.T) {
	ctx := context.Background()
	absent := filepath.Join(t.TempDir(), "no-daemon.json")
	for name, tc := range map[string]struct {
		docker, config string
		want           string
	}{
		"the default bridge's gateway":                {docker: "172.17.0.1 ", want: "172.17.0.1"},
		"the IPv4 gateway of a dual-stack bridge":     {docker: "fd00::1 172.18.0.1 ", want: "172.18.0.1"},
		"daemon.json host-gateway-ips wins":           {docker: "172.17.0.1 ", config: `{"host-gateway-ips":["2001:db8::1","192.0.2.1"]}`, want: "192.0.2.1"},
		"the older string host-gateway-ip":            {docker: "172.17.0.1 ", config: `{"host-gateway-ip":"192.0.2.9"}`, want: "192.0.2.9"},
		"a daemon.json without host-gateway settings": {docker: "172.17.0.1 ", config: `{"log-driver":"local"}`, want: "172.17.0.1"},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			config := absent
			if tc.config != "" {
				config = daemonJSON(t, tc.config)
			}
			got, err := DockerBridge{Docker: fakeDockerCLI(t, tc.docker), DaemonConfig: config}.Resolve(ctx)
			if err != nil || got.String() != tc.want {
				t.Fatalf("got %v, %v; want %s", got, err, tc.want)
			}
		})
	}
	for name, tc := range map[string]struct{ docker, config string }{
		"docker is not answering":            {docker: "fail"},
		"no IPv4 gateway":                    {docker: "fd00::1 "},
		"no gateway at all":                  {docker: ""},
		"host-gateway set to every address":  {docker: "172.17.0.1 ", config: `{"host-gateway-ip":"0.0.0.0"}`},
		"host-gateway set to loopback":       {docker: "172.17.0.1 ", config: `{"host-gateway-ips":["127.0.0.1"]}`},
		"an unreadable daemon configuration": {docker: "172.17.0.1 ", config: `{not json`},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			config := absent
			if tc.config != "" {
				config = daemonJSON(t, tc.config)
			}
			if got, err := (DockerBridge{Docker: fakeDockerCLI(t, tc.docker), DaemonConfig: config}).Resolve(ctx); err == nil {
				t.Fatalf("resolved %v", got)
			}
		})
	}
}

func snapshotJSON(t *testing.T, d DesiredMesh) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(d)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestDecodeBindsBridgeListenersOnTheGatewayAndNeverOnEveryInterface(t *testing.T) {
	_, key, _ := ed25519.GenerateKey(nil)
	peer := hex.EncodeToString(key.Public().(ed25519.PublicKey))
	snapshot := func(v int, listens ...string) json.RawMessage {
		d := DesiredMesh{V: v, Fleet: []MeshPeer{{ID: peer, RelayURLs: []string{}, DirectAddrs: []string{}}}}
		for i, l := range listens {
			name := []string{"shop-db", "registry-a", "other", "fourth"}[i]
			d.Links = append(d.Links, MeshLink{Name: name, Peer: peer, Service: name, Listen: l})
		}
		return snapshotJSON(t, d)
	}
	gateway := func(context.Context) (netip.Addr, error) { return netip.MustParseAddr("172.17.0.1"), nil }
	calls := 0
	unknown := func(context.Context) (netip.Addr, error) {
		calls++
		return netip.Addr{}, errors.New("docker network inspect bridge failed")
	}

	d, closed, err := decodeSnapshot(t.Context(), snapshot(2, "bridge:62001", "127.0.0.1:5000"), gateway)
	if err != nil || len(closed) != 0 || len(d.Links) != 2 || d.Links[0].Listen != "172.17.0.1:62001" || d.Links[1].Listen != "127.0.0.1:5000" {
		t.Fatalf("links %+v closed %+v err %v", d.Links, closed, err)
	}

	// An unknown bridge closes that link only, resolving once per snapshot; the loopback link stays.
	d, closed, err = decodeSnapshot(t.Context(), snapshot(2, "bridge:62001", "127.0.0.1:5000", "bridge:62002"), unknown)
	if err != nil || len(d.Links) != 1 || d.Links[0].Name != "registry-a" || len(closed) != 2 || calls != 1 ||
		!strings.Contains(closed[0].reason, "Docker bridge address is unknown") {
		t.Fatalf("links %+v closed %+v err %v calls %d", d.Links, closed, err, calls)
	}
	if _, closed, _ = decodeSnapshot(t.Context(), snapshot(2, "bridge:62001"), nil); len(closed) != 1 {
		t.Fatal("a bridge link opened without a resolver")
	}

	// Every interface is never bound, however the snapshot spells it, and version 1 has no bridge.
	d, closed, err = decodeSnapshot(t.Context(), snapshot(2, "0.0.0.0:62001", "[::]:62002", "bridge:0", "bridge:62003x"), gateway)
	if err != nil || len(d.Links) != 0 || len(closed) != 4 {
		t.Fatalf("links %+v closed %+v err %v", d.Links, closed, err)
	}
	if d, closed, _ = decodeSnapshot(t.Context(), snapshot(1, "bridge:62001"), gateway); len(d.Links) != 0 || len(closed) != 1 {
		t.Fatalf("version 1 bridge listener: links %+v closed %+v", d.Links, closed)
	}
	if _, _, err = decodeSnapshot(t.Context(), snapshot(3), gateway); err == nil {
		t.Fatal("an unknown snapshot version was accepted")
	}
}

// Through the production loop and sidecar client: the App link stays closed while the bridge is
// unknown, opens on the gateway once it resolves, and nothing listens on 0.0.0.0.
func TestAppLinkStaysClosedUntilTheBridgeResolves(t *testing.T) {
	f := newFakeConvex(t)
	a := newMeshNode(t, f, "a")
	peer := f.enroll("b")
	_, keyB, _ := ed25519.GenerateKey(nil)
	idB := hex.EncodeToString(keyB.Public().(ed25519.PublicKey))
	f.prove(peer, meshclient.Peer{ID: idB, RelayURLs: []string{}, DirectAddrs: []string{"192.0.2.7:4433"}})
	f.appLink("shop-db", peer, a.credential, 62005, 62001)

	bridgeErr := errors.New("docker network inspect bridge failed")
	a.loop.o.Bridge = func(context.Context) (netip.Addr, error) {
		if bridgeErr != nil {
			return netip.Addr{}, bridgeErr
		}
		return netip.MustParseAddr("172.17.0.1"), nil
	}
	a.heartbeat()
	a.sidecar.SetAddr([]string{}, []string{"10.0.0.2:41641"})
	a.advance(0)
	a.advance(3 * time.Second)
	if links := a.sidecar.Links(); len(links) != 0 {
		t.Fatalf("a link opened without a bridge address: %+v", links)
	}
	if a.logged("mesh link shop-db stays closed: the Docker bridge address is unknown") != 1 {
		t.Fatalf("logs %q", a.logs)
	}

	bridgeErr = nil
	a.advance(10 * time.Second)
	links := a.sidecar.Links()
	if len(links) != 1 || links["shop-db"].Listen != "172.17.0.1:62001" || links["shop-db"].Peer != idB {
		t.Fatalf("links %+v", links)
	}
	for _, l := range links {
		if strings.HasPrefix(l.Listen, "0.0.0.0:") || strings.HasPrefix(l.Listen, "[::]:") {
			t.Fatalf("listening on every interface: %+v", l)
		}
	}
}
