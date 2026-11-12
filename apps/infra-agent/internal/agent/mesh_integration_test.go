//go:build !windows

package agent

import (
	"io"
	"net"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Fanzzzd/erainfra/apps/infra-agent/internal/meshclient"
)

func TestBuiltSidecarThroughInfraAgentThreePeers(t *testing.T) {
	bin := os.Getenv("MESH_TEST_BINARY")
	if bin == "" {
		t.Skip("dedicated mesh CI supplies the built, static sidecar through MESH_TEST_BINARY")
	}
	if os.Geteuid() == 0 {
		t.Fatal("real sidecar integration must run as an unprivileged user")
	}
	bin, err := filepath.Abs(bin)
	if err != nil {
		t.Fatal(err)
	}
	root, err := os.MkdirTemp("", "era-mesh-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	type node struct {
		cfg        meshclient.SupervisorConfig
		supervisor *meshclient.Supervisor
		manager    *MeshManager
		client     *meshclient.Client
		controlDir string
	}
	start := func(name string) *node {
		dir := filepath.Join(root, name)
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
		n := &node{cfg: meshclient.SupervisorConfig{Binary: bin, Dir: dir, Socket: filepath.Join(dir, "m.sock"), NoPortmap: true, LoopbackOnly: true}, controlDir: filepath.Join(dir, "controller")}
		n.supervisor, err = meshclient.Start(t.Context(), n.cfg)
		if err != nil {
			t.Fatal(err)
		}
		n.manager, err = OpenMesh(t.Context(), MeshOptions{Socket: n.cfg.Socket, Dir: n.controlDir})
		if err != nil {
			t.Fatal(err)
		}
		n.client = meshclient.New(n.cfg.Socket)
		t.Cleanup(func() { _ = n.manager.Close(); _ = n.supervisor.Close() })
		return n
	}
	a, b, c := start("a"), start("b"), start("c")
	status := func(n *node) meshclient.Status {
		s, e := n.client.Status(t.Context())
		if e != nil {
			t.Fatal(e)
		}
		return s
	}
	sa, sb, sc := status(a), status(b), status(c)
	peers := []meshclient.Peer{sa.Addr, sb.Addr, sc.Addr}
	// All endpoint IP addresses are loopback, and relays are disabled for the entire test.
	for _, p := range peers {
		for _, addr := range p.DirectAddrs {
			host, _, e := net.SplitHostPort(addr)
			if e != nil || !net.ParseIP(host).IsLoopback() {
				t.Fatalf("non-loopback endpoint address: %s", addr)
			}
		}
	}
	echo, e := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { _ = echo.Close() })
	var accepted atomic.Int32
	go func() {
		for {
			conn, e := echo.Accept()
			if e != nil {
				return
			}
			accepted.Add(1)
			go func() { defer func() { _ = conn.Close() }(); _, _ = io.Copy(conn, conn) }()
		}
	}()
	db := meshclient.Desired{V: 1, Fleet: peers, Exposures: []meshclient.Exposure{{Name: "db", Target: echo.Addr().String(), AllowedPeers: []string{sa.EndpointID}}}}
	apply := func(n *node, d meshclient.Desired) meshclient.Status {
		s, e := n.manager.ApplyDesired(t.Context(), d)
		if e != nil {
			t.Fatal(e)
		}
		return s
	}
	apply(b, db)
	da := meshclient.Desired{V: 1, Fleet: peers, Links: []meshclient.Link{{Name: "db", Peer: sb.EndpointID, Service: "db", Listen: "127.0.0.1:0"}}}
	aListen := apply(a, da).Links[0].Bound
	cListen := apply(c, da).Links[0].Bound
	dial := func(addr string) net.Conn {
		conn, e := (&net.Dialer{Timeout: time.Second}).DialContext(t.Context(), "tcp", addr)
		if e != nil {
			t.Fatal(e)
		}
		t.Cleanup(func() { _ = conn.Close() })
		_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
		return conn
	}
	round := func(conn net.Conn, text string) {
		if _, e := io.WriteString(conn, text); e != nil {
			t.Fatal(e)
		}
		out := make([]byte, len(text))
		if _, e := io.ReadFull(conn, out); e != nil || string(out) != text {
			t.Fatalf("echo: %q %v", out, e)
		}
	}
	closed := func(conn net.Conn) {
		buf := make([]byte, 1)
		n, e := conn.Read(buf)
		if n != 0 {
			t.Fatal("unauthorized data returned")
		}
		if ne, ok := e.(net.Error); ok && ne.Timeout() {
			t.Fatal("revocation waited for reconnect or idle timeout")
		}
	}
	live := dial(aListen)
	round(live, "authorized A")
	denied := dial(cListen)
	_, _ = io.WriteString(denied, "unauthorized C")
	closed(denied)
	if accepted.Load() != 1 {
		t.Fatal("unauthorized fleet member reached DB target")
	}
	db.Exposures[0].AllowedPeers = []string{}
	apply(b, db)
	closed(live)
	db.Exposures[0].AllowedPeers = []string{sa.EndpointID}
	apply(b, db)
	round(dial(aListen), "re-authorized A")
	if _, e := meshclient.Start(t.Context(), b.cfg); e == nil {
		t.Fatal("double-started a daemon")
	}
	// Restarting only the Infra Agent adapter retains the external service and its identity.
	if e := a.manager.Close(); e != nil {
		t.Fatal(e)
	}
	a.manager, e = OpenMesh(t.Context(), MeshOptions{Socket: a.cfg.Socket, Dir: a.controlDir})
	if e != nil {
		t.Fatal(e)
	}
	if status(a).EndpointID != sa.EndpointID {
		t.Fatal("agent restart changed identity")
	}
	// Restart the actual child; init must not replace the persisted key, and grants restore.
	if e := b.supervisor.Close(); e != nil {
		t.Fatal(e)
	}
	b.supervisor, e = meshclient.Start(t.Context(), b.cfg)
	if e != nil {
		t.Fatal(e)
	}
	sb2 := status(b)
	if sb2.EndpointID != sb.EndpointID {
		t.Fatal("sidecar restart changed identity")
	}
	da.Fleet = []meshclient.Peer{status(a).Addr, sb2.Addr, status(c).Addr}
	apply(a, da)
	round(dial(aListen), "after restart")
	for _, entry := range []struct {
		path string
		mode os.FileMode
	}{{b.cfg.Dir, 0700}, {filepath.Join(b.cfg.Dir, "endpoint.key"), 0600}, {b.cfg.Socket, 0660}} {
		st, e := os.Stat(entry.path)
		if e != nil || st.Mode().Perm() != entry.mode {
			t.Fatalf("private permissions: %s %v", entry.path, e)
		}
	}
}
