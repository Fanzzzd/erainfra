package firecracker

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/Fanzzzd/runner-center/apps/runtime/internal/netpolicy"
)

type Config struct {
	BinaryPath          string
	KernelImagePath     string
	KernelArgs          string
	ContainerdAddress   string
	ContainerdNamespace string
	Snapshotter         string
	// Network is the verified job network contract. Its Name is the CNI network
	// name, so the conflist on disk, the nftables table in the kernel and the
	// interface Firecracker attaches all come from one description.
	Network netpolicy.Policy
	// NftBinary lists the live ruleset during Preflight. It is configurable only
	// so tests and unusual layouts can point at a different path.
	NftBinary    string
	CNIConfigDir string
	CNIBinDir    string
	WorkDir      string
	// ThinPoolName is the device-mapper thin-pool backing the devmapper
	// snapshotter, read during Preflight to report real copy-on-write headroom.
	ThinPoolName string
	// MinPoolFreeMiB is the copy-on-write headroom a Worker must still have
	// before it may accept another Attempt. A thin-pool that fills mid-job fails
	// the job with an unhelpful I/O error, so it is admission, not monitoring.
	MinPoolFreeMiB int64
}

func DefaultConfig() Config {
	return Config{
		BinaryPath:      "firecracker",
		KernelImagePath: "/var/lib/runner-center/kernels/vmlinux",
		// ipv6.disable=1 is part of the network policy, not a tuning choice: the
		// nftables rules are IPv4 and a dual-stack guest could route around them.
		KernelArgs:          "console=ttyS0 noapic reboot=k panic=1 pci=off nomodules ipv6.disable=1 rw",
		ContainerdAddress:   "/run/runner-center-containerd/containerd.sock",
		ContainerdNamespace: "runner-center",
		Snapshotter:         "devmapper",
		Network:             netpolicy.DefaultPolicy("runner-center"),
		NftBinary:           "nft",
		// Runner Center owns these directories so a host that also runs Docker or
		// Kubernetes CNI keeps its own plugins and network definitions untouched.
		CNIConfigDir:   "/etc/runner-center/cni/net.d",
		CNIBinDir:      "/opt/runner-center/cni/bin",
		WorkDir:        "/var/lib/runner-center/attempts",
		ThinPoolName:   "runner-center-thinpool",
		MinPoolFreeMiB: 20 * 1024,
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
		"nft binary":           c.NftBinary,
		"CNI config directory": c.CNIConfigDir,
		"CNI binary directory": c.CNIBinDir,
		"work directory":       c.WorkDir,
		"thin-pool name":       c.ThinPoolName,
	}
	for name, value := range values {
		if strings.TrimSpace(value) == "" {
			return fmt.Errorf("%s is required", name)
		}
	}
	if err := c.Network.Validate(); err != nil {
		return fmt.Errorf("job network policy: %w", err)
	}
	if err := netpolicy.VerifyKernelArgs(c.KernelArgs); err != nil {
		return err
	}
	if !filepath.IsAbs(c.KernelImagePath) || !filepath.IsAbs(c.WorkDir) {
		return errors.New("kernel image and work directory must be absolute paths")
	}
	cleanWorkDir := filepath.Clean(c.WorkDir)
	if filepath.Base(cleanWorkDir) != "attempts" || filepath.Dir(cleanWorkDir) == string(filepath.Separator) {
		return errors.New("work directory must be a scoped absolute path ending in /attempts")
	}
	if c.MinPoolFreeMiB < 0 {
		return errors.New("minimum pool headroom cannot be negative")
	}
	return nil
}

// ConflistPath is the file the CNI runtime reads for this Profile's network.
func (c Config) ConflistPath() string {
	return filepath.Join(c.CNIConfigDir, c.Network.ConflistFileName())
}
