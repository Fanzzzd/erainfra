package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"sync"

	"github.com/Fanzzzd/erainfra/apps/infra-agent/internal/meshclient"
)

// MeshManager drives this Node's one erainfra-mesh endpoint. It holds the controller lock for the
// process lifetime, so the Hub connection and the Convex transport can never both reconcile the
// same sidecar. Status and Apply carry the authenticated mesh: the control plane sends a complete
// desired view and the Reconciler converges the sidecar to it, so a removed link or grant is
// revoked by omission.
//
// During the expand release it also serves legacy dumbpipe links (Share, Connect, Drop) for links
// whose other end has no sidecar yet. A name the Hub has put on the mesh is refused there, so a
// link never runs on both transports and never moves back to dumbpipe.
type MeshManager struct {
	client    *meshclient.Client
	reconcile *meshclient.Reconciler
	lock      *meshclient.Lock
	socket    *meshclient.Lock
	child     *meshclient.Supervisor
	legacy    legacyPipes

	namesMu sync.Mutex
	onMesh  map[string]bool // the exposure and link names of the last applied desired view
}
type MeshOptions struct {
	Socket string
	Binary string
	Dir    string
}

func NewMeshManager() *MeshManager {
	return &MeshManager{legacy: legacyPipes{links: map[string]*meshLink{}}, onMesh: map[string]bool{}}
}
func OpenMesh(ctx context.Context, opts MeshOptions) (*MeshManager, error) {
	if opts.Socket == "" && opts.Binary == "" {
		return NewMeshManager(), nil
	}
	if opts.Dir == "" || opts.Socket == "" {
		return nil, fmt.Errorf("mesh socket and private control directory are required")
	}
	lock, err := meshclient.Acquire(filepath.Join(opts.Dir, "controller.lock"))
	if err != nil {
		return nil, err
	}
	// The control-directory lock alone lets two agents configured with different directories
	// drive one sidecar. The socket lock is keyed on the sidecar itself.
	socket, err := meshclient.AcquireSocket(opts.Socket)
	if err != nil {
		_ = lock.Close()
		return nil, err
	}
	m := NewMeshManager()
	m.lock, m.socket, m.client = lock, socket, meshclient.New(opts.Socket)
	if opts.Binary != "" {
		m.child, err = meshclient.Start(ctx, meshclient.SupervisorConfig{Binary: opts.Binary, Dir: filepath.Join(opts.Dir, "sidecar"), Socket: opts.Socket})
		if err != nil {
			_ = socket.Close()
			_ = lock.Close()
			return nil, err
		}
		m.client = m.child.Client
	}
	if _, err := m.client.Status(ctx); err != nil {
		_ = m.Close()
		return nil, err
	}
	m.reconcile = &meshclient.Reconciler{Client: m.client}
	return m, nil
}
func (m *MeshManager) Enabled() bool { return m != nil && m.client != nil }
func (m *MeshManager) Close() error {
	if m == nil {
		return nil
	}
	if m.child != nil {
		_ = m.child.Close()
	}
	if m.socket != nil {
		_ = m.socket.Close()
	}
	if m.lock != nil {
		return m.lock.Close()
	}
	return nil
}
func (m *MeshManager) Status(ctx context.Context) (string, error) {
	if !m.Enabled() {
		return "", meshclient.ErrUnsupported
	}
	s, err := m.client.Status(ctx)
	if err != nil {
		return "", err
	}
	b, err := json.Marshal(s)
	return string(b), err
}
func (m *MeshManager) Apply(ctx context.Context, d meshclient.Desired, stage string) (string, error) {
	s, err := m.apply(ctx, d, stage)
	if err != nil {
		return "", err
	}
	b, err := json.Marshal(s)
	return string(b), err
}

// EndpointStatus, SignChallenge and ApplyDesired are what connect-convex drives: it publishes the
// sidecar's address with a signed challenge and applies Convex's complete snapshot in one stage.
func (m *MeshManager) EndpointStatus(ctx context.Context) (meshclient.Status, error) {
	if !m.Enabled() {
		return meshclient.Status{}, meshclient.ErrUnsupported
	}
	return m.client.Status(ctx)
}
func (m *MeshManager) SignChallenge(ctx context.Context, message string) (meshclient.Signature, error) {
	if !m.Enabled() {
		return meshclient.Signature{}, meshclient.ErrUnsupported
	}
	return m.client.SignChallenge(ctx, message)
}
func (m *MeshManager) ApplyDesired(ctx context.Context, d meshclient.Desired) (meshclient.Status, error) {
	return m.apply(ctx, d, "")
}
func (m *MeshManager) apply(ctx context.Context, d meshclient.Desired, stage string) (meshclient.Status, error) {
	if !m.Enabled() {
		return meshclient.Status{}, meshclient.ErrUnsupported
	}
	// Record the names before applying: from here on this Node refuses dumbpipe for them, even if
	// the apply below fails halfway. The view is complete, so it replaces the previous set: a link
	// the Hub deleted and later re-created with a legacy end is not refused forever.
	names := map[string]bool{}
	for _, e := range d.Exposures {
		names[e.Name] = true
	}
	for _, l := range d.Links {
		names[l.Name] = true
	}
	m.namesMu.Lock()
	m.onMesh = names
	m.namesMu.Unlock()
	return m.reconcile.Apply(ctx, d, stage)
}

// ErrOnMesh refuses a dumbpipe command for a link the Hub has moved to the mesh.
var ErrOnMesh = errors.New("link is on the authenticated mesh; dumbpipe is refused for it")

// onMeshName reports whether name belongs to the mesh: named in a desired view this agent applied,
// or present in the sidecar right now (which also covers names restored from the sidecar's state
// after an agent restart).
func (m *MeshManager) onMeshName(ctx context.Context, name string) bool {
	if !m.Enabled() {
		return false
	}
	m.namesMu.Lock()
	known := m.onMesh[name]
	m.namesMu.Unlock()
	if known {
		return true
	}
	s, err := m.client.Status(ctx)
	if err != nil {
		return false
	}
	for _, e := range s.Exposures {
		if e.Name == name {
			return true
		}
	}
	for _, l := range s.Links {
		if l.Name == name {
			return true
		}
	}
	return false
}

// Share, Connect and Drop serve legacy dumbpipe links during the expand release (see legacyPipes).
func (m *MeshManager) Share(ctx context.Context, name string, port int) (string, error) {
	if m.onMeshName(ctx, name) {
		return "", ErrOnMesh
	}
	return m.legacy.Share(name, port)
}
func (m *MeshManager) Connect(ctx context.Context, name, ticket string, localPort int) (string, error) {
	if m.onMeshName(ctx, name) {
		return "", ErrOnMesh
	}
	return m.legacy.Connect(name, ticket, localPort)
}

// Drop is always allowed: ending a dumbpipe process never weakens a link, and the Hub drops the
// dumbpipe half of a link while migrating it onto the mesh.
func (m *MeshManager) Drop(name string) bool { return m.legacy.Drop(name) }
