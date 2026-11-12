package main

import (
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"runtime"

	"github.com/Fanzzzd/erainfra/apps/infra-agent/internal/agent"
	"github.com/Fanzzzd/erainfra/apps/infra-agent/internal/rename"
)

// connectMesh opens the sidecar under two controller locks (the control directory's and the
// sidecar socket's), so only one Infra Agent can drive it at a time. Enabling the local sidecar is
// explicit and does not change the enrollment channel.
func connectMesh(ctx context.Context) (*agent.MeshManager, error) {
	socket := os.Getenv("ERAINFRA_MESH_SOCKET")
	binary := os.Getenv("ERAINFRA_MESH_BIN")
	if socket == "" && binary == "" {
		return agent.NewMeshManager(), nil
	}
	dir := os.Getenv("ERAINFRA_MESH_CONTROL_DIR")
	if dir == "" {
		prefix := rename.Env("ERAINFRA_PREFIX", "PORTLESS_PREFIX")
		if prefix == "" {
			home, err := os.UserHomeDir()
			if err != nil {
				return nil, err
			}
			prefix = filepath.Join(home, ".portless")
		}
		dir = filepath.Join(prefix, "run", "mesh-control")
	}
	if socket == "" {
		socket = filepath.Join(dir, "mesh.sock")
		if runtime.GOOS == "windows" {
			socket = fmt.Sprintf(`\\.\pipe\erainfra-mesh-%x`, sha256.Sum256([]byte(dir)))
		}
	}
	return agent.OpenMesh(ctx, agent.MeshOptions{Socket: socket, Binary: binary, Dir: dir})
}
