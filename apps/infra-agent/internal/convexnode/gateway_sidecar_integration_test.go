//go:build !windows

package convexnode

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Fanzzzd/erainfra/apps/infra-agent/internal/agent"
	"github.com/Fanzzzd/erainfra/apps/infra-agent/internal/gateway"
	"github.com/Fanzzzd/erainfra/apps/infra-agent/internal/gateway/gatewaytest"
	"github.com/Fanzzzd/erainfra/apps/infra-agent/internal/meshclient"
)

// A gateway Node, an App's Node and a third Node, each a connect-convex Infra Agent with a real
// erainfra-mesh sidecar on loopback, against a fake Convex. The gateway proxy, fed by the route
// table its agent writes, reaches the App over the mesh: plain requests, a streamed upload and a
// WebSocket. The third Node gets nothing from Convex, and when its sidecar is driven by hand to
// the App's ingress exposure, the App's sidecar refuses it.
func TestBuiltSidecarGatewayReachesTheAppOnlyFromTheGateway(t *testing.T) {
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
	root, err := os.MkdirTemp("", "era-gw-") // short: macOS caps socket paths at 104 bytes
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })

	// The App, on the App Node's loopback only.
	var appConns atomic.Int32
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", gatewaytest.EchoWebSocket("app:"))
	mux.HandleFunc("PUT /upload", func(w http.ResponseWriter, r *http.Request) {
		sum := sha256.New()
		n, err := io.Copy(sum, r.Body)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		_, _ = fmt.Fprintf(w, "%d %s", n, hex.EncodeToString(sum.Sum(nil)))
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		_, _ = fmt.Fprintf(w, "app host=%s proto=%s", r.Host, r.Header.Get("X-Forwarded-Proto"))
	})
	app := httptest.NewUnstartedServer(mux)
	app.Config.ConnState = func(_ net.Conn, s http.ConnState) {
		if s == http.StateNew {
			appConns.Add(1)
		}
	}
	app.Start()
	t.Cleanup(app.Close)
	ingressPort := freePort(t)

	f := newFakeConvex(t)
	type node struct {
		credential string
		socket     string
		stop       func()
	}
	start := func(name, routesFile string) *node {
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
		client, err := New(Config{URL: f.server.URL, Credential: n.credential, StateDir: privateDir(t), AllowHTTPForTests: true}, &fakeExecutor{})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = client.Close() })
		client.Mesh = &MeshOptions{Sidecar: manager, RoutesFile: routesFile, Poll: 50 * time.Millisecond, Settle: 100 * time.Millisecond, MinPublishGap: 200 * time.Millisecond, StatePoll: 100 * time.Millisecond, Logf: func(string, ...any) {}}
		ctx, cancel := context.WithCancel(t.Context())
		done := make(chan struct{})
		go func() { defer close(done); _ = client.Run(ctx) }()
		n.stop = func() { cancel(); <-done }
		t.Cleanup(n.stop)
		return n
	}
	routes := filepath.Join(root, "routes.json")
	g := start("g", routes)
	a := start("a", "")
	c := start("c", filepath.Join(root, "c-routes.json"))
	f.gateway(g.credential, true)
	f.route("web", a.credential, portOf(t, app.Listener.Addr().String()), ingressPort)

	// The gateway proxy, as `infra-agent gateway` runs it.
	proxy, err := gateway.New(gateway.Config{Zones: []string{"example.test"}, RoutesFile: routes, Poll: 50 * time.Millisecond, Logf: func(string, ...any) {}})
	if err != nil {
		t.Fatal(err)
	}
	ln, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := proxy.Server()
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })
	go proxy.Watch(t.Context())

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
	idG, idA, idC := status(g).EndpointID, status(a).EndpointID, status(c).EndpointID
	waitFor("a to grant exactly the gateway, and the gateway to bind its ingress link", func() bool {
		sa, sg := status(a), status(g)
		return len(sa.Exposures) == 1 && sameSet(sa.Exposures[0].AllowedPeers, []string{idG}) &&
			len(sg.Links) == 1 && sg.Links[0].Peer == idA && sg.Links[0].Bound == "127.0.0.1:"+strconv.Itoa(ingressPort)
	})
	get := func(host, path string) (int, string) {
		req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, "http://"+ln.Addr().String()+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Host = host
		req.Header.Set("X-Forwarded-Proto", "https")
		resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
		if err != nil {
			return 0, err.Error()
		}
		defer func() { _ = resp.Body.Close() }()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(b)
	}
	waitFor("the proxy to serve the App through the mesh", func() bool {
		code, body := get("web.example.test", "/")
		return code == 200 && body == "app host=web.example.test proto=https"
	})
	if code, _ := get("nope.example.test", "/"); code != http.StatusNotFound {
		t.Fatalf("unknown host: %d", code)
	}

	// A streamed upload over the mesh.
	payload := bytes.Repeat([]byte("0123456789abcdef"), 1<<19) // 8 MiB
	req, err := http.NewRequestWithContext(t.Context(), http.MethodPut, "http://"+ln.Addr().String()+"/upload", io.NopCloser(bytes.NewReader(payload)))
	if err != nil {
		t.Fatal(err)
	}
	req.Host = "web.example.test"
	resp, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	sum := sha256.Sum256(payload)
	if want := fmt.Sprintf("%d %s", len(payload), hex.EncodeToString(sum[:])); string(got) != want {
		t.Fatalf("upload over the mesh: %q", got)
	}

	// A WebSocket over the mesh.
	echo, err := gatewaytest.RoundTrip(t.Context(), ln.Addr().String(), "web.example.test", "over the mesh")
	if err != nil || echo != "app:web.example.test over the mesh" {
		t.Fatalf("websocket: %q %v", echo, err)
	}

	// c is enrolled and proven but is not a gateway: Convex gives it no routes and no grant.
	sc := status(c)
	if len(sc.Exposures)+len(sc.Links) != 0 {
		t.Fatalf("c received mesh state: %+v", sc)
	}
	tb, err := gateway.ReadTable(filepath.Join(root, "c-routes.json"))
	if err != nil || tb.Gateway || len(tb.Routes) != 0 {
		t.Fatalf("c route table %+v %v", tb, err)
	}
	for _, e := range status(a).Exposures {
		for _, p := range e.AllowedPeers {
			if p == idC {
				t.Fatal("c granted the App's ingress exposure")
			}
		}
	}
	// Drive c's sidecar by hand, as a compromised c would: a refuses it.
	c.stop()
	before := appConns.Load()
	rogue := meshclient.New(c.socket)
	if err := rogue.SetFleet(t.Context(), []meshclient.Peer{status(a).Addr}); err != nil {
		t.Fatal(err)
	}
	listen, err := rogue.Link(t.Context(), meshclient.Link{Name: "ingress.web", Peer: idA, Service: "ingress.web", Listen: "127.0.0.1:0"})
	if err != nil {
		t.Fatal(err)
	}
	conn, err := (&net.Dialer{Timeout: time.Second}).DialContext(t.Context(), "tcp", listen)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
	_, _ = io.WriteString(conn, "GET / HTTP/1.1\r\nHost: web.example.test\r\n\r\n")
	buf := make([]byte, 1)
	if n, err := conn.Read(buf); n != 0 {
		t.Fatal("a Node that is not a gateway reached the App")
	} else if ne, ok := err.(net.Error); ok && ne.Timeout() {
		t.Fatal("denial waited for a timeout instead of closing")
	}
	if appConns.Load() != before {
		t.Fatal("the App saw a connection from a Node that is not a gateway")
	}
}
