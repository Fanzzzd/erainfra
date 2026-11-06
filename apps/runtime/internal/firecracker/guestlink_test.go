package firecracker

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/netpolicy"
)

// fakeProcSysNet lays out /proc/sys/net/ipv6/conf/<link>/disable_ipv6 for
// each link with the given value.
func fakeProcSysNet(t *testing.T, links map[string]string) string {
	t.Helper()
	root := t.TempDir()
	for link, value := range links {
		dir := filepath.Join(root, "ipv6", "conf", link)
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "disable_ipv6"), []byte(value+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if len(links) == 0 {
		if err := os.MkdirAll(filepath.Join(root, "ipv6", "conf"), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func TestDisableLinkIPv6TurnsItOffOnThatLinkOnly(t *testing.T) {
	root := fakeProcSysNet(t, map[string]string{"veth1a2b3c4d": "0", "veth9f8e7d6": "0", "all": "0", "default": "0"})
	if err := disableLinkIPv6(root, "veth1a2b3c4d"); err != nil {
		t.Fatal(err)
	}
	read := func(link string) string {
		value, err := os.ReadFile(filepath.Join(root, "ipv6", "conf", link, "disable_ipv6"))
		if err != nil {
			t.Fatal(err)
		}
		return strings.TrimSpace(string(value))
	}
	if read("veth1a2b3c4d") != "1" {
		t.Fatal("the guest link must have IPv6 off")
	}
	// The host may use IPv6, and default would reach every link Docker
	// creates after this one.
	for _, other := range []string{"veth9f8e7d6", "all", "default"} {
		if read(other) != "0" {
			t.Fatalf("%s must keep its IPv6 setting", other)
		}
	}
}

func TestDisableLinkIPv6FailsClosed(t *testing.T) {
	root := fakeProcSysNet(t, nil)
	if err := disableLinkIPv6(root, "veth1a2b3c4d"); err == nil {
		t.Fatal("a guest link the kernel does not know must not boot a guest")
	}
	if err := disableLinkIPv6(root, "../../../etc"); err == nil {
		t.Fatal("a name that is not an interface name must be refused before it reaches a path")
	}
	// A kernel with no IPv6 at all has nothing to turn off.
	if err := disableLinkIPv6(t.TempDir(), "veth1a2b3c4d"); err != nil {
		t.Fatalf("a host without IPv6 must pass: %v", err)
	}
}

func TestVerifyGuestLinksIPv6(t *testing.T) {
	root := fakeProcSysNet(t, map[string]string{"veth1a2b3c4d": "1", "veth00000002": "0"})
	if err := verifyGuestLinksIPv6(root, []string{"veth1a2b3c4d"}); err != nil {
		t.Fatalf("a closed link must pass: %v", err)
	}
	err := verifyGuestLinksIPv6(root, []string{"veth1a2b3c4d", "veth00000002"})
	if err == nil || !strings.Contains(err.Error(), "veth00000002") || strings.Contains(err.Error(), "veth1a2b3c4d") {
		t.Fatalf("readiness must name exactly the link that accepts IPv6, got %v", err)
	}
	// CNI deletes the veth before teardown unbinds it.
	if err := verifyGuestLinksIPv6(root, []string{"veth0000dead"}); err != nil {
		t.Fatalf("a link that is already gone carries nothing: %v", err)
	}
	if err := verifyGuestLinksIPv6(t.TempDir(), []string{"veth00000002"}); err != nil {
		t.Fatalf("a host without IPv6 must pass: %v", err)
	}
}

// Readiness fails when either layer is missing: the table, or IPv6 off on a
// live guest link.
func TestVerifyNetworkStateNeedsBothLayers(t *testing.T) {
	policy := netpolicy.DefaultPolicy("runner-center")
	withGuest, err := os.ReadFile("../netpolicy/testdata/nft-1.0.9-live-table-with-guest.json")
	if err != nil {
		t.Fatal(err)
	}
	closed := fakeProcSysNet(t, map[string]string{"veth1a2b3c4d": "1"})
	detail, err := verifyNetworkState(policy, withGuest, closed, nil)
	if err != nil {
		t.Fatalf("both layers in place must pass: %v", err)
	}
	if !strings.Contains(detail, "guest IPv6") || !strings.Contains(detail, "1 live guest links") {
		t.Fatalf("readiness evidence must say what it checked, got %q", detail)
	}

	open := fakeProcSysNet(t, map[string]string{"veth1a2b3c4d": "0"})
	if _, err := verifyNetworkState(policy, withGuest, open, nil); err == nil {
		t.Fatal("a live guest link that accepts IPv6 must fail readiness even with the table intact")
	}

	noTable := []byte(`{"nftables":[{"metainfo":{"version":"1.0.9"}}]}`)
	if _, err := verifyNetworkState(policy, noTable, closed, nil); err == nil {
		t.Fatal("a host with no table must fail readiness even with every link closed")
	}
}
