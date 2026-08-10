package firecracker

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"
)

type Config struct {
	BinaryPath          string
	KernelImagePath     string
	KernelArgs          string
	ContainerdAddress   string
	ContainerdNamespace string
	Snapshotter         string
	CNIName             string
	CNIConfigDir        string
	CNIBinDir           string
	WorkDir             string
}

func DefaultConfig() Config {
	return Config{
		BinaryPath:          "firecracker",
		KernelImagePath:     "/var/lib/runner-center/kernels/vmlinux",
		KernelArgs:          "console=ttyS0 noapic reboot=k panic=1 pci=off nomodules rw",
		ContainerdAddress:   "/run/containerd/containerd.sock",
		ContainerdNamespace: "runner-center",
		Snapshotter:         "devmapper",
		CNIName:             "runner-center",
		CNIConfigDir:        "/etc/cni/net.d",
		CNIBinDir:           "/opt/cni/bin",
		WorkDir:             "/var/lib/runner-center/attempts",
	}
}

func (c Config) Validate() error {
	values := map[string]string{
		"binary path":          c.BinaryPath,
		"kernel image path":    c.KernelImagePath,
		"kernel arguments":     c.KernelArgs,
		"containerd address":   c.ContainerdAddress,
		"containerd namespace": c.ContainerdNamespace,
		"snapshotter":          c.Snapshotter,
		"CNI name":             c.CNIName,
		"CNI config directory": c.CNIConfigDir,
		"CNI binary directory": c.CNIBinDir,
		"work directory":       c.WorkDir,
	}
	for name, value := range values {
		if strings.TrimSpace(value) == "" {
			return fmt.Errorf("%s is required", name)
		}
	}
	if !filepath.IsAbs(c.KernelImagePath) || !filepath.IsAbs(c.WorkDir) {
		return errors.New("kernel image and work directory must be absolute paths")
	}
	cleanWorkDir := filepath.Clean(c.WorkDir)
	if filepath.Base(cleanWorkDir) != "attempts" || filepath.Dir(cleanWorkDir) == string(filepath.Separator) {
		return errors.New("work directory must be a scoped absolute path ending in /attempts")
	}
	return nil
}
