//go:build !windows

package meshclient

import (
	"bufio"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A fake control server on a real Unix socket, so the production dialer and its directory check
// run, not the injected net.Pipe the other tests use.
func TestClientOverARealUnixSocket(t *testing.T) {
	dir, err := os.MkdirTemp("", "mc-") // short path: macOS caps socket paths at 104 bytes
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	socket := filepath.Join(dir, "m.sock")
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
			go func() {
				defer func() { _ = conn.Close() }()
				line, err := bufio.NewReader(conn).ReadBytes('\n')
				if err != nil {
					return
				}
				var r map[string]any
				if json.Unmarshal(line, &r) != nil {
					return
				}
				_ = json.NewEncoder(conn).Encode(map[string]any{"v": 1, "id": r["id"], "ok": true, "result": testStatus()})
			}()
		}
	}()
	s, err := New(socket).Status(t.Context())
	if err != nil || s.EndpointID != testID {
		t.Fatalf("status over unix socket: %+v %v", s, err)
	}

	// Anyone who can write the socket's directory can swap the socket for one of their own.
	if err := os.Chmod(dir, 0o770); err != nil {
		t.Fatal(err)
	}
	if _, err := New(socket).Status(t.Context()); err == nil || !strings.Contains(err.Error(), "writable by group or others") {
		t.Fatalf("group-writable socket directory accepted: %v", err)
	}
}

// The Hub connection and the Convex transport take the same controller lock, so whichever starts
// second fails instead of reconciling the sidecar toward a different desired view.
func TestOnlyOneControllerHoldsTheLock(t *testing.T) {
	path := filepath.Join(t.TempDir(), "control", "controller.lock")
	first, err := Acquire(path)
	if err != nil {
		t.Fatal(err)
	}
	if second, err := Acquire(path); err == nil {
		_ = second.Close()
		t.Fatal("a second controller acquired the lock")
	} else if !strings.Contains(err.Error(), "already has a controller") {
		t.Fatalf("unexpected error: %v", err)
	}
	if st, err := os.Stat(filepath.Dir(path)); err != nil || st.Mode().Perm() != 0o700 {
		t.Fatalf("control directory must be private: %v %v", st, err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	again, err := Acquire(path)
	if err != nil {
		t.Fatalf("lock not released on close: %v", err)
	}
	_ = again.Close()
}
