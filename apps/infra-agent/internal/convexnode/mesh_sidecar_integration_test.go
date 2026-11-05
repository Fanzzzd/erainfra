//go:build !windows

package convexnode

import (
	"context"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Fanzzzd/erainfra/apps/infra-agent/internal/agent"
	"github.com/Fanzzzd/erainfra/apps/infra-agent/internal/meshclient"
)

// Three connect-convex Infra Agents, each with a real erainfra-mesh sidecar on loopback, against
// a fake Convex. a consumes b's "db" through a declared link and reaches it. c is enrolled and
// published but has no link: Convex gives it nothing, and even when its sidecar is driven by hand
// to link to b, b refuses it.
func TestBuiltSidecarConnectConvexLinksOnlyDeclaredPeers(t *testing.T) {
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
	root, err := os.MkdirTemp("", "era-cx-") // short: macOS caps socket paths at 104 bytes
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })

	echo, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = echo.Close() })
	var accepted atomic.Int32
	go func() {
		for {
			conn, err := echo.Accept()
			if err != nil {
				return
			}
			accepted.Add(1)
			go func() { defer func() { _ = conn.Close() }(); _, _ = io.Copy(conn, conn) }()
		}
	}()
	aPort := freePort(t)

	f := newFakeConvex(t)
	type node struct {
		credential string
		socket     string
		client     *Client
		stop       func()
	}
	start := func(name string) *node {
		dir := filepath.Join(root, name)
		n := &node{credential: f.enroll(name), socket: filepath.Join(dir, "m.sock")}
		supervisor, err := meshclient.Start(t.Context(), meshclient.SupervisorConfig{Binary: bin, Dir: dir, Socket: n.socket, NoPortmap: true, LoopbackOnly: true})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = supervisor.Close() })
		manager, err := agent.OpenMesh(t.Context(), agent.MeshOptions{Socket: n.socket, Dir: filepath.Join(root, name+"-ctl")})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = manager.Close() })
		n.client, err = New(Config{URL: f.server.URL, Credential: n.credential, StateDir: privateDir(t), AllowHTTPForTests: true}, &fakeExecutor{})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = n.client.Close() })
		n.client.Mesh = &MeshOptions{Sidecar: manager, Poll: 50 * time.Millisecond, Settle: 100 * time.Millisecond, MinPublishGap: 200 * time.Millisecond, StatePoll: 100 * time.Millisecond, Logf: func(string, ...any) {}}
		ctx, cancel := context.WithCancel(t.Context())
		done := make(chan struct{})
		go func() { defer close(done); _ = n.client.Run(ctx) }()
		n.stop = func() { cancel(); <-done }
		t.Cleanup(n.stop)
		return n
	}
	a, b := start("a"), start("b")
	c := start("c")
	f.link("db", b.credential, a.credential, portOf(t, echo.Addr().String()), aPort)

	status := func(n *node) meshclient.Status {
		s, err := meshclient.New(n.socket).Status(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		return s
	}
	waitFor := func(what string, ok func() bool) {
		t.Helper()
		deadline := time.Now().Add(30 * time.Second)
		for !ok() {
			if time.Now().After(deadline) {
				t.Fatalf("timed out waiting for %s", what)
			}
			time.Sleep(50 * time.Millisecond)
		}
	}
	idA, idB, idC := status(a).EndpointID, status(b).EndpointID, status(c).EndpointID
	for _, n := range []*node{a, b, c} {
		waitFor("every Node to publish its proven endpoint", func() bool {
			registered, _ := f.registered(n.credential)
			return registered == status(n).EndpointID
		})
	}
	waitFor("b to grant a, and a to bind its link", func() bool {
		sb, sa := status(b), status(a)
		return len(sb.Exposures) == 1 && sameSet(sb.Exposures[0].AllowedPeers, []string{idA}) && len(sa.Links) == 1 && sa.Links[0].Bound == "127.0.0.1:"+strconv.Itoa(aPort)
	})

	dial := func(addr string) net.Conn {
		conn, err := (&net.Dialer{Timeout: time.Second}).DialContext(t.Context(), "tcp", addr)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = conn.Close() })
		_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
		return conn
	}
	live := dial("127.0.0.1:" + strconv.Itoa(aPort))
	if _, err := io.WriteString(live, "declared a"); err != nil {
		t.Fatal(err)
	}
	got := make([]byte, len("declared a"))
	if _, err := io.ReadFull(live, got); err != nil || string(got) != "declared a" {
		t.Fatalf("declared link: %q %v", got, err)
	}

	// c holds a proven endpoint and a live credential, but no link: nothing names it.
	sc := status(c)
	if len(sc.Exposures)+len(sc.Links) != 0 {
		t.Fatalf("c received mesh state without a link: %+v", sc)
	}
	for _, s := range []meshclient.Status{status(a), status(b)} {
		for _, e := range s.Exposures {
			for _, p := range e.AllowedPeers {
				if p == idC {
					t.Fatal("c granted without a declared link")
				}
			}
		}
	}

	// Drive c's sidecar by hand, as a compromised c would, after stopping its agent (which would
	// otherwise repair the drift): b refuses it because c is in neither its fleet nor its grant.
	c.stop()
	rogue := meshclient.New(c.socket)
	if err := rogue.SetFleet(t.Context(), []meshclient.Peer{status(b).Addr}); err != nil {
		t.Fatal(err)
	}
	listen, err := rogue.Link(t.Context(), meshclient.Link{Name: "db", Peer: idB, Service: "db", Listen: "127.0.0.1:0"})
	if err != nil {
		t.Fatal(err)
	}
	denied := dial(listen)
	_, _ = io.WriteString(denied, "undeclared c")
	buf := make([]byte, 1)
	if n, err := denied.Read(buf); n != 0 {
		t.Fatal("undeclared Node received data")
	} else if ne, ok := err.(net.Error); ok && ne.Timeout() {
		t.Fatal("denial waited for a timeout instead of closing")
	}
	if accepted.Load() != 1 {
		t.Fatalf("the DB target saw %d connections; only a's is declared", accepted.Load())
	}
}

func freePort(t *testing.T) int {
	t.Helper()
	l, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = l.Close() }()
	return portOf(t, l.Addr().String())
}

func portOf(t *testing.T, addr string) int {
	t.Helper()
	_, port, err := net.SplitHostPort(addr)
	if err != nil {
		t.Fatal(err)
	}
	p, err := strconv.Atoi(port)
	if err != nil {
		t.Fatal(err)
	}
	return p
}
