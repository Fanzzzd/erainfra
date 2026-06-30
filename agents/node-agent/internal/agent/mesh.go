package agent

import (
	"bufio"
	"fmt"
	"io"
	"os/exec"
	"regexp"
	"sync"
	"time"
)

// MeshManager runs dumbpipe (iroh) sidecars ON THIS NODE to wire it to another NAT'd node with no
// public IP: the box that HAS a service `Share`s it (dumbpipe listen-tcp → a crypto ticket); the box
// that WANTS it `Connect`s that ticket (dumbpipe connect-tcp → a local port). Data flows P2P between
// the two nodes (hole-punched, or via the iroh relay) — NOT through the hub. The hub only brokers the
// ticket. Mirrors the hub-side MeshManager in apps/api/src/runtime/mesh.ts, in Go.
type MeshManager struct {
	mu    sync.Mutex
	links map[string]*meshLink
}

type meshLink struct {
	cmd    *exec.Cmd
	role   string // "share" | "connect"
	port   int
	ticket string
}

func NewMeshManager() *MeshManager { return &MeshManager{links: map[string]*meshLink{}} }

// dumbpipe prints a ready-to-run `dumbpipe connect-tcp <ticket>` line; take that token, else the first
// long base32 run. Matches parseTicket in mesh.ts.
var afterConnectRe = regexp.MustCompile(`(?i)connect(?:-tcp)?\s+([a-z2-7]{48,})`)
var bareTicketRe = regexp.MustCompile(`(?i)\b([a-z2-7]{64,})\b`)

func parseTicket(s string) string {
	if m := afterConnectRe.FindStringSubmatch(s); m != nil {
		return m[1]
	}
	if m := bareTicketRe.FindStringSubmatch(s); m != nil {
		return m[1]
	}
	return ""
}

// Share exposes local 127.0.0.1:<port> on the mesh and returns the ticket to hand to the other node.
func (m *MeshManager) Share(name string, port int) (string, error) {
	_ = m.Drop(name) // replace any prior link with this name
	cmd := exec.Command("dumbpipe", "listen-tcp", "--host", fmt.Sprintf("127.0.0.1:%d", port))
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return "", err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return "", err
	}
	if err := cmd.Start(); err != nil {
		return "", fmt.Errorf("dumbpipe start: %w", err)
	}
	tch := make(chan string, 1)
	// Keep draining after the ticket so dumbpipe never blocks on a full stdout pipe.
	scan := func(r io.Reader) {
		sc := bufio.NewScanner(r)
		sent := false
		for sc.Scan() {
			if !sent {
				if t := parseTicket(sc.Text()); t != "" {
					select {
					case tch <- t:
					default:
					}
					sent = true
				}
			}
		}
	}
	go scan(stdout)
	go scan(stderr)
	select {
	case t := <-tch:
		m.add(name, &meshLink{cmd: cmd, role: "share", port: port, ticket: t})
		go func() { _ = cmd.Wait(); m.removeIf(name, cmd) }()
		return t, nil
	case <-time.After(30 * time.Second):
		_ = cmd.Process.Kill()
		return "", fmt.Errorf("timed out waiting for the mesh ticket")
	}
}

// Connect dials a remote ticket and surfaces it on local 0.0.0.0:<localPort> — bound on all node
// interfaces (not just loopback) so the app's CONTAINERS can reach it via host.docker.internal. Safe
// because the node is NAT'd (no inbound from the internet); this only exposes it on the node's LAN +
// docker bridge. dumbpipe binds the listener at startup, so if it's still alive after a short settle
// it's ready; a bad ticket exits fast.
func (m *MeshManager) Connect(name, ticket string, localPort int) (string, error) {
	_ = m.Drop(name)
	cmd := exec.Command("dumbpipe", "connect-tcp", "--addr", fmt.Sprintf("0.0.0.0:%d", localPort), ticket)
	if err := cmd.Start(); err != nil {
		return "", fmt.Errorf("dumbpipe start: %w", err)
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	select {
	case err := <-exited:
		return "", fmt.Errorf("dumbpipe exited before the listener was ready: %v", err)
	case <-time.After(1500 * time.Millisecond):
	}
	m.add(name, &meshLink{cmd: cmd, role: "connect", port: localPort})
	go func() { <-exited; m.removeIf(name, cmd) }()
	return fmt.Sprintf("127.0.0.1:%d", localPort), nil
}

// Drop kills and forgets a link by name. Returns whether one existed.
func (m *MeshManager) Drop(name string) bool {
	m.mu.Lock()
	l := m.links[name]
	delete(m.links, name)
	m.mu.Unlock()
	if l == nil {
		return false
	}
	if l.cmd.Process != nil {
		_ = l.cmd.Process.Kill()
	}
	return true
}

func (m *MeshManager) add(name string, l *meshLink) {
	m.mu.Lock()
	m.links[name] = l
	m.mu.Unlock()
}

// removeIf forgets a link only if it's still the same process (not already replaced by a re-link).
func (m *MeshManager) removeIf(name string, cmd *exec.Cmd) {
	m.mu.Lock()
	if m.links[name] != nil && m.links[name].cmd == cmd {
		delete(m.links, name)
	}
	m.mu.Unlock()
}
