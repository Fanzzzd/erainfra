//go:build !windows

// Package meshtest is a fake erainfra-mesh control server for tests. It speaks NDJSON v1 on a
// real Unix socket, keeps the state the real daemon would (fleet, relays, exposures, links) and
// signs challenges with a real Ed25519 key, so callers exercise the production client and dialer.
// It forwards no traffic. Test code only.
package meshtest

import (
	"bufio"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"

	"github.com/Fanzzzd/erainfra/apps/infra-agent/internal/meshclient"
)

type Sidecar struct {
	Socket string

	mu        sync.Mutex
	key       ed25519.PrivateKey
	relays    []string
	direct    []string
	fleet     []meshclient.Peer
	relayCfg  meshclient.Relays
	exposures map[string]meshclient.Exposure
	links     map[string]meshclient.Link
	ops       map[string]int
	signed    []string
}

// Start serves a fake sidecar on a socket in a fresh short private directory (macOS caps socket
// paths at 104 bytes, which t.TempDir() can exceed).
func Start(t *testing.T) *Sidecar {
	t.Helper()
	dir, err := os.MkdirTemp("", "mt-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	return StartAt(t, filepath.Join(dir, "m.sock"))
}

// StartAt serves a fake sidecar on socket, whose directory must already exist and be private.
func StartAt(t *testing.T, socket string) *Sidecar {
	t.Helper()
	s := &Sidecar{Socket: socket, direct: []string{"127.0.0.1:41641"}, exposures: map[string]meshclient.Exposure{}, links: map[string]meshclient.Link{}, ops: map[string]int{}}
	s.Rekey()
	l, err := (&net.ListenConfig{}).Listen(t.Context(), "unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = l.Close() })
	go func() {
		for {
			conn, err := l.Accept()
			if err != nil {
				return
			}
			go s.serve(conn)
		}
	}()
	return s
}

// Rekey replaces the endpoint key, as `erainfra-mesh init` on a wiped key file would.
func (s *Sidecar) Rekey() {
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		panic(err)
	}
	s.mu.Lock()
	s.key = key
	s.mu.Unlock()
}

func (s *Sidecar) ID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return hex.EncodeToString(s.key.Public().(ed25519.PublicKey))
}

// SetAddr changes the addresses status reports, as a network change or relay reconnect would.
func (s *Sidecar) SetAddr(relays, direct []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.relays, s.direct = relays, direct
}

// Ops reports how many requests of an operation the sidecar answered.
func (s *Sidecar) Ops(op string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ops[op]
}

// Signed returns every message the sidecar signed, in order.
func (s *Sidecar) Signed() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.signed...)
}

// Fleet, Relays, Exposures and Links return what the sidecar currently holds.
func (s *Sidecar) Fleet() []meshclient.Peer {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]meshclient.Peer(nil), s.fleet...)
}
func (s *Sidecar) Relays() meshclient.Relays {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.relayCfg
}
func (s *Sidecar) Exposures() map[string]meshclient.Exposure {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := map[string]meshclient.Exposure{}
	for k, v := range s.exposures {
		out[k] = v
	}
	return out
}
func (s *Sidecar) Links() map[string]meshclient.Link {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := map[string]meshclient.Link{}
	for k, v := range s.links {
		out[k] = v
	}
	return out
}

// Forget drops every exposure and link, as a daemon restarted without --state would.
func (s *Sidecar) Forget() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.exposures = map[string]meshclient.Exposure{}
	s.links = map[string]meshclient.Link{}
}

func (s *Sidecar) serve(conn net.Conn) {
	defer func() { _ = conn.Close() }()
	line, err := bufio.NewReader(conn).ReadBytes('\n')
	if err != nil {
		return
	}
	var req map[string]json.RawMessage
	if json.Unmarshal(line, &req) != nil {
		return
	}
	var op string
	_ = json.Unmarshal(req["op"], &op)
	result, code := s.handle(op, line)
	reply := map[string]any{"v": 1, "id": req["id"], "ok": code == ""}
	if code == "" {
		reply["result"] = result
	} else {
		reply["error"] = map[string]string{"code": code, "message": "refused by the fake sidecar"}
	}
	_ = json.NewEncoder(conn).Encode(reply)
}

func (s *Sidecar) handle(op string, line []byte) (any, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ops[op]++
	id := hex.EncodeToString(s.key.Public().(ed25519.PublicKey))
	switch op {
	case "status":
		exposures := []meshclient.ExposureStatus{}
		for _, name := range sortedKeys(s.exposures) {
			exposures = append(exposures, meshclient.ExposureStatus{Exposure: s.exposures[name]})
		}
		links := []meshclient.LinkStatus{}
		for _, name := range sortedKeys(s.links) {
			l := s.links[name]
			links = append(links, meshclient.LinkStatus{Link: l, Bound: l.Listen})
		}
		relays, direct := s.relays, s.direct
		if relays == nil {
			relays = []string{}
		}
		if direct == nil {
			direct = []string{}
		}
		return map[string]any{"endpoint_id": id, "addr": meshclient.Peer{ID: id, RelayURLs: relays, DirectAddrs: direct}, "exposures": exposures, "links": links, "relay": map[string]any{}}, ""
	case "sign_challenge":
		var r struct {
			Message string `json:"message"`
		}
		if json.Unmarshal(line, &r) != nil || len(r.Message) > 4096 || !strings.HasPrefix(r.Message, "erainfra/node-endpoint/v1\n") {
			return nil, "bad_request"
		}
		s.signed = append(s.signed, r.Message)
		return meshclient.Signature{EndpointID: id, Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(s.key, []byte(r.Message)))}, ""
	case "set_fleet":
		var r struct {
			Peers []meshclient.Peer `json:"peers"`
		}
		if json.Unmarshal(line, &r) != nil {
			return nil, "bad_request"
		}
		for _, p := range r.Peers {
			if p.ID == id {
				return nil, "bad_request"
			}
		}
		s.fleet = r.Peers
	case "set_relays":
		var r meshclient.Relays
		if json.Unmarshal(line, &r) != nil {
			return nil, "bad_request"
		}
		s.relayCfg = r
	case "expose":
		var e meshclient.Exposure
		if json.Unmarshal(line, &e) != nil {
			return nil, "bad_request"
		}
		s.exposures[e.Name] = e
	case "unexpose", "unlink":
		var r struct {
			Name string `json:"name"`
		}
		if json.Unmarshal(line, &r) != nil {
			return nil, "bad_request"
		}
		if op == "unexpose" {
			delete(s.exposures, r.Name)
		} else {
			delete(s.links, r.Name)
		}
	case "link":
		var l meshclient.Link
		if json.Unmarshal(line, &l) != nil {
			return nil, "bad_request"
		}
		s.links[l.Name] = l
		return map[string]string{"listen": l.Listen}, ""
	default:
		return nil, "bad_request"
	}
	return map[string]bool{"changed": true}, ""
}

func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
