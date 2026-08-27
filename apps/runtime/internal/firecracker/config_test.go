package firecracker

import (
	"strings"
	"testing"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/netpolicy"
)

func TestConfigRejectsKernelArgumentsThatBypassTheNetworkPolicy(t *testing.T) {
	config := DefaultConfig()
	config.KernelArgs = "console=ttyS0 reboot=k panic=1 rw"
	err := config.Validate()
	if err == nil {
		t.Fatal("a guest booted with IPv6 enabled can route around the IPv4 policy")
	}
	if !strings.Contains(err.Error(), "ipv6.disable=1") {
		t.Fatalf("the error must name the missing argument, got %v", err)
	}
}

func TestConfigRejectsAnUnenforceableNetworkPolicy(t *testing.T) {
	config := DefaultConfig()
	config.Network.Subnet = "8.8.8.0/24"
	if err := config.Validate(); err == nil {
		t.Fatal("a publicly routable guest subnet must be rejected")
	}
}

func TestDefaultConfigOwnsItsOwnCNIAndContainerdPaths(t *testing.T) {
	config := DefaultConfig()
	// A Worker frequently also runs Docker or Kubernetes networking. Sharing
	// /opt/cni/bin or the system containerd socket would let an unrelated
	// component redefine the network EraInfra just verified.
	for name, value := range map[string]string{
		"CNI binary directory": config.CNIBinDir,
		"CNI config directory": config.CNIConfigDir,
		"containerd address":   config.ContainerdAddress,
	} {
		if !strings.Contains(value, "runner-center") {
			t.Fatalf("%s %q is shared with other components on the host", name, value)
		}
	}
	if config.ConflistPath() != "/etc/runner-center/cni/net.d/10-runner-center.conflist" {
		t.Fatalf("unexpected conflist path %q", config.ConflistPath())
	}
	if config.Network.EgressMode != netpolicy.EgressPublic {
		t.Fatalf("unexpected default egress mode %q", config.Network.EgressMode)
	}
}

func TestConfigRejectsBroadRecoveryDirectory(t *testing.T) {
	for _, path := range []string{"/", "/var", "/home/storage", "/attempts", "relative/attempts"} {
		config := DefaultConfig()
		config.WorkDir = path
		if err := config.Validate(); err == nil {
			t.Fatalf("unsafe work directory %q was accepted", path)
		}
	}
}

func TestConfigAcceptsDedicatedAttemptDirectories(t *testing.T) {
	for _, path := range []string{
		"/var/lib/runner-center/attempts",
		"/home/storage/runner-center/attempts",
	} {
		config := DefaultConfig()
		config.WorkDir = path
		if err := config.Validate(); err != nil {
			t.Fatalf("work directory %q rejected: %v", path, err)
		}
	}
}

func TestConfigHoldsTheCacheURLAndKeyTogether(t *testing.T) {
	// A URL with no key mints no bearer; a key with no URL injects no endpoint.
	// Either half alone is a misconfiguration, not a smaller cache.
	key := []byte(strings.Repeat("k", 32))

	withURL := DefaultConfig()
	withURL.CacheServiceURL = "https://cache.internal:8721"
	if err := withURL.Validate(); err == nil {
		t.Fatal("a cache service URL with no signing key was accepted")
	}

	withKey := DefaultConfig()
	withKey.CacheSigningKey = key
	if err := withKey.Validate(); err == nil {
		t.Fatal("a signing key with no cache service URL was accepted")
	}

	both := DefaultConfig()
	both.CacheServiceURL = "https://cache.internal:8721"
	both.CacheSigningKey = key
	if err := both.Validate(); err != nil {
		t.Fatalf("a fully configured cache was rejected: %v", err)
	}

	// A set URL is still held to being an absolute http(s) URL that names a host,
	// the same rule the per-Attempt path applies, so a typo fails at startup. The
	// daemon injects this value into every claim after the spec is validated, so a
	// URL that slips through here is one no later check can catch.
	for _, malformed := range []string{
		"cache.internal:8721",  // no scheme
		"ftp://cache.internal", // wrong scheme
		"https://?x=1",         // scheme and query but no host
		"https://",             // scheme but empty host
	} {
		bad := DefaultConfig()
		bad.CacheSigningKey = key
		bad.CacheServiceURL = malformed
		if err := bad.Validate(); err == nil {
			t.Fatalf("malformed cache service URL %q was accepted", malformed)
		}
	}
}

func TestDefaultPoolHeadroomIsReachableForTheSmallestSupportedPool(t *testing.T) {
	// The provisioner's smallest evaluation pool is 32 GiB. A default headroom
	// requirement larger than that pool could never be satisfied, so the Worker
	// would install cleanly and then never become ready.
	const smallestSupportedPoolMiB = 32 * 1024
	headroom := DefaultConfig().MinPoolFreeMiB
	if headroom <= 0 || headroom >= smallestSupportedPoolMiB {
		t.Fatalf(
			"default headroom %d MiB cannot be met by the smallest supported %d MiB pool",
			headroom, smallestSupportedPoolMiB,
		)
	}
}
