package firecracker

import (
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"strings"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/admission"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/aptmirror"
	"github.com/Fanzzzd/erainfra/apps/runtime/internal/netpolicy"
	"github.com/Fanzzzd/erainfra/apps/runtime/internal/registrymirror"
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
	// It is required once per guest: a warm pool needs it for every parked VM.
	// Preflight reports it as storage.poolReserveMiB and the control plane
	// places Attempts against that number, so this field is its only owner.
	MinPoolFreeMiB int64
	// StartBudget is how much starting this Worker allows at once. An Attempt
	// over it waits in Start, for at most StartBudget.MaxHold.
	StartBudget admission.Budget
	// CacheSigningKey is the secret the host mints each Attempt's runner-auth
	// cache bearer with, or empty. Empty is the default and mints no bearer,
	// composing exactly the environment a fleet without a cache composes. It is
	// the same key the cache service and controller hold; a set key shorter than
	// the token package's minimum fails New.
	CacheSigningKey []byte
	// CacheServiceURL is EraInfra's cache service, the endpoint the in-guest
	// interceptor forwards the cache path to. Empty is the default and injects
	// nothing, composing exactly the environment a fleet without a cache
	// composes. It is operator configuration, not a secret, and it lives here
	// with the signing key because both are fleet-wide rather than per-job: a key
	// with no URL mints a bearer nothing can use, and a URL with no key hands the
	// guest an endpoint it has no bearer for, so Validate requires them together.
	CacheServiceURL string
	// RegistryMirrorURL is a pull-through mirror for Docker Hub that guests
	// can reach (RC_REGISTRY_MIRROR_URL), or empty. The guest writes it into
	// dockerd's registry-mirrors and BuildKit's default configuration at
	// claim. It needs no key: a mirror serves public images, the same bytes
	// to every job, which is also why it must never hold credentials.
	RegistryMirrorURL string
	// AptMirrorURL is an apt HTTP proxy, such as apt-cacher-ng, that guests
	// can reach (RC_APT_MIRROR_URL), or empty. The guest points apt at it
	// through a probe that falls back to direct fetches when it is down.
	AptMirrorURL string
	// GitMirror turns on the git checkout mirror in every guest
	// (RC_GIT_MIRROR). A guest's checkout of its own repository then fetches
	// from GitHub only what the repository's seed in the cache service lacks.
	// It needs the cache service, which holds the seeds.
	GitMirror bool
}

func DefaultConfig() Config {
	return Config{
		BinaryPath:      "firecracker",
		KernelImagePath: "/var/lib/runner-center/kernels/vmlinux",
		// ipv6.disable=1 is part of the network policy, not a tuning choice: the
		// nftables rules are IPv4 and a dual-stack guest could route around them.
		//
		// noapic and nomodules are deliberately absent, and neither appears in
		// Firecracker's own documented command line. Since Firecracker 1.8.0 --
		// we pin 1.16.1 -- ACPI is how the VMM describes vCPUs, interrupt
		// controllers and VirtIO devices to the guest, and MPTable support is
		// deprecated, so telling the kernel to ignore the APIC is not a
		// configuration Firecracker supports. nomodules is not a kernel
		// parameter at all; the kernel hands words it does not recognise to init
		// as arguments.
		//
		// rootflags are the root mount options GitHub's hosted image sets through
		// GRUB. Our image has no GRUB, so they live here. The root is a
		// per-Attempt snapshot that nothing reads after the VM ends, so
		// durability across a crash buys nothing, and each small write it saves
		// also saves a 64 KiB copy-on-write or zeroing write in the host's thin
		// pool. rootflags carries ext4 options only: a VFS flag such as noatime
		// makes ext4 refuse the mount and the guest kernel panics.
		// images/ubuntu-24.04-js/boot-test.sh reads this line, so keep the value
		// one string literal on one line.
		KernelArgs:          "console=ttyS0 reboot=k panic=1 pci=off ipv6.disable=1 rw rootflags=nobarrier,data=writeback,journal_async_commit,commit=30",
		ContainerdAddress:   "/run/runner-center-containerd/containerd.sock",
		ContainerdNamespace: "runner-center",
		Snapshotter:         "devmapper",
		Network:             netpolicy.DefaultPolicy("runner-center"),
		NftBinary:           "nft",
		// EraInfra owns these directories so a host that also runs Docker or
		// Kubernetes CNI keeps its own plugins and network definitions untouched.
		CNIConfigDir: "/etc/runner-center/cni/net.d",
		CNIBinDir:    "/opt/runner-center/cni/bin",
		WorkDir:      "/var/lib/runner-center/attempts",
		ThinPoolName: "runner-center-thinpool",
		// One Attempt's worth of copy-on-write growth, matching the reserve the
		// control plane applies per running guest. A Worker that cannot hold one
		// more root should decline work rather than fail a job mid-run.
		MinPoolFreeMiB: 8 * 1024,
		StartBudget:    admission.DefaultBudget(),
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
	if err := c.StartBudget.Validate(); err != nil {
		return err
	}
	if err := validateCacheEndpoint(c.CacheServiceURL, len(c.CacheSigningKey) > 0); err != nil {
		return err
	}
	// Caught at startup like the cache URL: the daemon injects this into every
	// claim, and a value dockerd rejects in daemon.json would otherwise first
	// surface as a guest whose dockerd will not restart.
	if c.RegistryMirrorURL != "" {
		if err := registrymirror.Validate(c.RegistryMirrorURL); err != nil {
			return fmt.Errorf("RC_REGISTRY_MIRROR_URL: %w", err)
		}
	}
	if c.AptMirrorURL != "" {
		if err := aptmirror.Validate(c.AptMirrorURL); err != nil {
			return fmt.Errorf("RC_APT_MIRROR_URL: %w", err)
		}
	}
	if c.GitMirror && c.CacheServiceURL == "" {
		return errors.New("RC_GIT_MIRROR needs RC_CACHE_SERVICE_URL: the cache service holds the seeds the mirror starts from")
	}
	return nil
}

// validateCacheEndpoint holds the cache service URL and signing key to the same
// both-or-neither rule the controller applies to its own pair: either is useless
// without the other, so a half-configured cache is a misconfiguration caught at
// startup rather than a guest that silently reaches nothing. The daemon injects
// this URL into every claim after the spec is validated, so a URL that names no
// host has to fail here or it never fails at all.
func validateCacheEndpoint(serviceURL string, hasSigningKey bool) error {
	// Validate the exact bytes Start injects, not a trimmed copy: Runtime.Start
	// hands config.CacheServiceURL to every claim unchanged, so a value that only
	// looks valid after trimming would still reach a guest with the whitespace on
	// it. Surrounding whitespace is a misconfiguration, not something to absorb.
	if (serviceURL != "") != hasSigningKey {
		return errors.New("cache service URL and signing key must be set together")
	}
	if serviceURL == "" {
		return nil
	}
	for _, r := range serviceURL {
		if r <= ' ' || r == 0x7f {
			return errors.New("cache service URL must not contain whitespace or control characters")
		}
	}
	parsed, err := url.Parse(serviceURL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return errors.New("cache service URL must be an absolute http(s) URL that names a host")
	}
	return nil
}

// ConflistPath is the file the CNI runtime reads for this Profile's network.
func (c Config) ConflistPath() string {
	return filepath.Join(c.CNIConfigDir, c.Network.ConflistFileName())
}

// SnapshotterPluginType is containerd's plugin type for snapshotters.
const SnapshotterPluginType = "io.containerd.snapshotter.v1"

// snapshotterFilter selects exactly one containerd snapshotter plugin.
//
// It must stay a single filter string. containerd parses a slice of filters
// with filters.ParseAll, which combines them with Any, so passing "type==..."
// and "id==..." as separate entries asks for every snapshotter the daemon
// loaded *or* anything with that id -- on a real host that is overlayfs,
// native, blockfile and more. Comma-separated selectors inside one string are
// the conjunction this check needs: containerd's own grammar documents that
// all selectors in one filter must match.
func snapshotterFilter(name string) []string {
	return []string{"type==" + SnapshotterPluginType + ",id==" + name}
}
