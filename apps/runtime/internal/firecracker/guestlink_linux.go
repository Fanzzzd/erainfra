//go:build linux

package firecracker

import (
	"errors"
	"fmt"
	"net"
	"net/netip"

	"github.com/vishvananda/netlink"
)

// hostLinkOf finds the host side of a guest's link: the interface ptp routes
// the guest's /32 through. The route is the kernel's own answer, so it names
// the link the guest's packets really arrive on, whatever ptp called it.
//
// Only an exact /32 route to a veth counts. A longest-prefix lookup would fall
// back to the default route when the /32 is missing and hand back the host's
// uplink, which must never be mistaken for a guest link.
func hostLinkOf(address netip.Addr) (string, error) {
	if !address.Is4() {
		return "", fmt.Errorf("guest address %s is not IPv4", address)
	}
	destination := &net.IPNet{IP: net.IP(address.AsSlice()), Mask: net.CIDRMask(32, 32)}
	var (
		routes []netlink.Route
		err    error
	)
	// A dump interrupted by a concurrent route change is incomplete, and a
	// guest booting next to this one is exactly such a change.
	for range 5 {
		routes, err = netlink.RouteListFiltered(netlink.FAMILY_V4, &netlink.Route{Dst: destination}, netlink.RT_FILTER_DST)
		if !errors.Is(err, netlink.ErrDumpInterrupted) {
			break
		}
	}
	if err != nil {
		return "", fmt.Errorf("find the host link of guest %s: %w", address, err)
	}
	if len(routes) != 1 || routes[0].LinkIndex == 0 {
		return "", fmt.Errorf("guest %s has %d host routes, want exactly one through its own link", address, len(routes))
	}
	link, err := netlink.LinkByIndex(routes[0].LinkIndex)
	if err != nil {
		return "", fmt.Errorf("read the host link of guest %s: %w", address, err)
	}
	name := link.Attrs().Name
	if link.Type() != "veth" {
		return "", fmt.Errorf("guest %s is routed through %s, a %s rather than the veth ptp creates", address, name, link.Type())
	}
	return name, nil
}
