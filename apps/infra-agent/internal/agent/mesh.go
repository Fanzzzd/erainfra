package agent

import (
	"context"
	"fmt"
	"path/filepath"

	"github.com/Fanzzzd/erainfra/apps/infra-agent/internal/meshclient"
)

// MeshManager drives this Node's one erainfra-mesh endpoint. It holds the controller lock for the
// process lifetime, so no second Infra Agent can reconcile the same sidecar. ApplyDesired carries
// the authenticated mesh: Convex sends a complete desired view and the Reconciler converges the
// sidecar to it, so a removed link or grant is revoked by omission.
type MeshManager struct {
	client    *meshclient.Client
	reconcile *meshclient.Reconciler
	lock      *meshclient.Lock
	socket    *meshclient.Lock
	child     *meshclient.Supervisor
}
type MeshOptions struct {
	Socket string
	Binary string
	Dir    string
}

func NewMeshManager() *MeshManager { return &MeshManager{} }
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
	if !m.Enabled() {
		return meshclient.Status{}, meshclient.ErrUnsupported
	}
	return m.reconcile.Apply(ctx, d)
}
