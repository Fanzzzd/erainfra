package meshclient

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"strings"
	"sync"
	"testing"
	"time"
)

const testID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func fakeClient(t *testing.T, handler func(map[string]any) any) *Client {
	t.Helper()
	c := New("local-test")
	c.Dial = func(context.Context, string) (net.Conn, error) {
		a, b := net.Pipe()
		go func() {
			defer func() { _ = b.Close() }()
			// Read the whole line, as the sidecar does. A json.Decoder may stop at the closing brace
			// and leave the newline unread, which blocks the client's write on a synchronous pipe.
			line, err := bufio.NewReader(b).ReadBytes('\n')
			var request map[string]any
			if err != nil || json.Unmarshal(line, &request) != nil {
				return
			}
			reply := map[string]any{"v": 1, "id": request["id"], "ok": true, "result": handler(request)}
			_ = json.NewEncoder(b).Encode(reply)
		}()
		return a, nil
	}
	return c
}
func testStatus() any {
	return map[string]any{"endpoint_id": testID, "addr": Peer{ID: testID, RelayURLs: []string{}, DirectAddrs: []string{"127.0.0.1:9999"}}, "exposures": []ExposureStatus{}, "links": []LinkStatus{}}
}
func TestActualV1ShapesAndDefaultDeny(t *testing.T) {
	var requests []map[string]any
	var mu sync.Mutex
	c := fakeClient(t, func(r map[string]any) any {
		mu.Lock()
		defer mu.Unlock()
		requests = append(requests, r)
		switch r["op"] {
		case "status":
			return testStatus()
		case "link":
			return map[string]string{"listen": "127.0.0.1:15432"}
		case "sign_challenge":
			return Signature{EndpointID: testID, Signature: "signature"}
		default:
			return map[string]bool{"changed": true}
		}
	})
	ctx := t.Context()
	s, err := c.Status(ctx)
	if err != nil || s.EndpointID != testID {
		t.Fatalf("status: %v %v", s, err)
	}
	if err := c.SetFleet(ctx, nil); err != nil {
		t.Fatal(err)
	}
	if err := c.SetRelays(ctx, Relays{}); err != nil {
		t.Fatal(err)
	}
	if err := c.Expose(ctx, Exposure{Name: "db", Target: "127.0.0.1:5432"}); err != nil {
		t.Fatal(err)
	}
	if listen, err := c.Link(ctx, Link{Name: "db", Peer: testID, Service: "db", Listen: "15432"}); err != nil || listen != "127.0.0.1:15432" {
		t.Fatalf("link: %s %v", listen, err)
	}
	if err := c.Unlink(ctx, "db"); err != nil {
		t.Fatal(err)
	}
	if err := c.Unexpose(ctx, "db"); err != nil {
		t.Fatal(err)
	}
	if _, err := c.SignChallenge(ctx, "erainfra/node-endpoint/v1\n{\"nonce\":\"x\"}"); err != nil {
		t.Fatal(err)
	}
	if _, err := c.SignChallenge(ctx, "arbitrary signing"); err == nil {
		t.Fatal("arbitrary signing must fail")
	}
	if _, ok := requests[1]["peers"].([]any); !ok {
		t.Fatal("nil peers must encode as []")
	}
	if _, ok := requests[2]["relays"].([]any); !ok {
		t.Fatal("nil relays must encode as []")
	}
	if a, ok := requests[3]["allowed_peers"].([]any); !ok || len(a) != 0 {
		t.Fatal("missing grants must be explicit empty []")
	}
	if len(requests) != 8 {
		t.Fatalf("unexpected requests: %d", len(requests))
	}
	for _, r := range requests {
		if r["v"] != float64(1) || r["id"] == nil {
			t.Fatal("unversioned request")
		}
	}
}
func TestDeadlineAndCancellationCloseTheConnection(t *testing.T) {
	c := New("stalled")
	c.Dial = func(context.Context, string) (net.Conn, error) {
		a, b := net.Pipe()
		go func() {
			defer func() { _ = b.Close() }()
			_, _ = bufio.NewReader(b).ReadBytes('\n')
			var one [1]byte
			_, _ = b.Read(one[:])
		}()
		return a, nil
	}
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Millisecond)
	defer cancel()
	start := time.Now()
	if _, err := c.Status(ctx); err == nil {
		t.Fatal("stalled request succeeded")
	}
	if time.Since(start) > time.Second {
		t.Fatal("caller deadline was ignored")
	}
}
func TestResponseBoundsVersionAndTokenRedaction(t *testing.T) {
	for _, kind := range []string{"oversize", "version", "id", "secret"} {
		t.Run(kind, func(t *testing.T) {
			c := New("bad")
			c.Dial = func(context.Context, string) (net.Conn, error) {
				a, b := net.Pipe()
				go func() {
					defer func() { _ = b.Close() }()
					var r map[string]any
					line, _ := bufio.NewReader(b).ReadBytes('\n')
					_ = json.Unmarshal(line, &r)
					switch kind {
					case "oversize":
						_, _ = b.Write(bytes.Repeat([]byte("x"), MaxMessage+1))
					case "version":
						_ = json.NewEncoder(b).Encode(map[string]any{"v": 2, "id": r["id"], "ok": true})
					case "id":
						_ = json.NewEncoder(b).Encode(map[string]any{"v": 1, "id": 999, "ok": true})
					case "secret":
						_ = json.NewEncoder(b).Encode(map[string]any{"v": 1, "id": r["id"], "ok": false, "error": map[string]string{"code": "bad_request", "message": "relay-token-do-not-log"}})
					}
				}()
				return a, nil
			}
			_, err := c.Status(t.Context())
			if err == nil {
				t.Fatal("invalid response succeeded")
			}
			if strings.Contains(err.Error(), "relay-token-do-not-log") {
				t.Fatal("token leaked")
			}
		})
	}
}
func TestReconcileRevokesBeforeOpeningNewListeners(t *testing.T) {
	var ops []string
	c := fakeClient(t, func(r map[string]any) any {
		op := r["op"].(string)
		ops = append(ops, op)
		if op == "status" {
			return map[string]any{"endpoint_id": testID, "addr": Peer{ID: testID}, "exposures": []Exposure{{Name: "old"}}, "links": []Link{{Name: "old"}}}
		}
		return map[string]any{}
	})
	r := Reconciler{Client: c}
	d := Desired{V: 1, Exposures: []Exposure{{Name: "db", Target: "127.0.0.1:5432"}}, Links: []Link{{Name: "db", Peer: testID, Service: "db", Listen: "15432"}}}
	if _, err := r.Apply(t.Context(), d); err != nil {
		t.Fatal(err)
	}
	want := "status unexpose unlink set_relays set_fleet expose set_fleet link status"
	if strings.Join(ops, " ") != want {
		t.Fatalf("order: %v", ops)
	}
	ops = nil
	d.Exposures[0].Target = "192.168.1.10:5432"
	if _, err := r.Apply(t.Context(), d); err == nil {
		t.Fatal("nonloopback accepted")
	}
	if len(ops) != 0 {
		t.Fatal("invalid desired state partially changed the daemon")
	}
}
func TestOutputIsBoundedEvenForAChattyChild(t *testing.T) {
	b := &boundedOutput{}
	p := bytes.Repeat([]byte("x"), 1024*1024)
	n, err := b.Write(p)
	if err != nil || n != len(p) || len(b.data) != 64*1024 || b.total != uint64(len(p)) {
		t.Fatal("unbounded or blocking child output")
	}
}
func TestDesiredBounds(t *testing.T) {
	if (Desired{V: 1, Fleet: make([]Peer, 4097)}).Validate() == nil {
		t.Fatal("unbounded fleet")
	}
	if (Desired{V: 2}).Validate() == nil {
		t.Fatal("unknown version")
	}
	if fmt.Sprint(ErrUnsupported) == "" {
		t.Fatal("missing mixed-version error")
	}
}
