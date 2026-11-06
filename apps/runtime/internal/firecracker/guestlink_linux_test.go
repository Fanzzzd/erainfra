//go:build linux

package firecracker

import (
	"net"
	"net/netip"
	"os"
	"runtime"
	"strings"
	"testing"

	"github.com/vishvananda/netlink"
	"github.com/vishvananda/netns"
)

// inScratchNetns runs body on a thread moved into a new, empty network
// namespace, so the test builds links and routes without touching the host's.
// It needs root, and skips without it.
func inScratchNetns(t *testing.T, body func()) {
	t.Helper()
	if os.Geteuid() != 0 {
		t.Skip("needs root to create a network namespace")
	}
	runtime.LockOSThread()
	origin, err := netns.Get()
	if err != nil {
		runtime.UnlockOSThread()
		t.Fatalf("read the current network namespace: %v", err)
	}
	defer origin.Close() //nolint:errcheck // a test handle
	scratch, err := netns.New()
	if err != nil {
		runtime.UnlockOSThread()
		t.Skipf("cannot create a network namespace here: %v", err)
	}
	defer scratch.Close() //nolint:errcheck // a test handle
	defer func() {
		// A thread that cannot return to the host namespace stays locked, and
		// the Go runtime retires it when this goroutine ends.
		if netns.Set(origin) == nil {
			runtime.UnlockOSThread()
		}
	}()
	body()
}

func TestHostLinkOfFindsOnlyTheGuestsOwnVeth(t *testing.T) {
	inScratchNetns(t, func() {
		must := func(err error) {
			if err != nil {
				t.Fatal(err)
			}
		}
		veth := &netlink.Veth{LinkAttrs: netlink.LinkAttrs{Name: "veth1a2b3c4d"}, PeerName: "guest0"}
		must(netlink.LinkAdd(veth))
		must(netlink.LinkSetUp(veth))
		hostSide, err := netlink.LinkByName("veth1a2b3c4d")
		must(err)
		must(netlink.RouteAdd(&netlink.Route{
			LinkIndex: hostSide.Attrs().Index, Scope: netlink.SCOPE_LINK,
			Dst: &net.IPNet{IP: net.ParseIP("10.241.0.7").To4(), Mask: net.CIDRMask(32, 32)},
		}))
		uplink := &netlink.Dummy{LinkAttrs: netlink.LinkAttrs{Name: "uplink0"}}
		must(netlink.LinkAdd(uplink))
		must(netlink.LinkSetUp(uplink))
		address, err := netlink.ParseAddr("192.0.2.1/24")
		must(err)
		must(netlink.AddrAdd(uplink, address))
		must(netlink.RouteAdd(&netlink.Route{LinkIndex: uplink.Attrs().Index, Gw: net.ParseIP("192.0.2.254")}))
		must(netlink.RouteAdd(&netlink.Route{
			LinkIndex: uplink.Attrs().Index, Scope: netlink.SCOPE_LINK,
			Dst: &net.IPNet{IP: net.ParseIP("10.241.0.9").To4(), Mask: net.CIDRMask(32, 32)},
		}))

		link, err := hostLinkOf(netip.MustParseAddr("10.241.0.7"))
		if err != nil || link != "veth1a2b3c4d" {
			t.Fatalf("host link = %q, %v; want the guest's veth", link, err)
		}
		// Without its /32 a guest address would resolve through the default
		// route to the uplink, which must never be treated as a guest link.
		if link, err := hostLinkOf(netip.MustParseAddr("10.241.0.8")); err == nil {
			t.Fatalf("a guest with no /32 route must fail, got %q", link)
		}
		if link, err := hostLinkOf(netip.MustParseAddr("10.241.0.9")); err == nil || !strings.Contains(err.Error(), "uplink0") {
			t.Fatalf("a /32 through something other than a veth must fail, got %q %v", link, err)
		}

		// The kernel layer on the real /proc of this namespace.
		if _, err := os.Stat(procSysNet + "/ipv6"); err != nil {
			t.Skipf("this kernel has no IPv6: %v", err)
		}
		must(disableLinkIPv6(procSysNet, "veth1a2b3c4d"))
		must(verifyGuestLinksIPv6(procSysNet, []string{"veth1a2b3c4d"}))
		value, err := os.ReadFile(procSysNet + "/ipv6/conf/uplink0/disable_ipv6")
		must(err)
		if strings.TrimSpace(string(value)) != "0" {
			t.Fatal("turning IPv6 off on a guest link must leave every other link alone")
		}
		must(os.WriteFile(procSysNet+"/ipv6/conf/veth1a2b3c4d/disable_ipv6", []byte("0\n"), 0o600))
		if err := verifyGuestLinksIPv6(procSysNet, []string{"veth1a2b3c4d"}); err == nil {
			t.Fatal("a guest link whose IPv6 was turned back on must fail readiness")
		}
	})
}
