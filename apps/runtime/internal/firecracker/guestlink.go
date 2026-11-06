package firecracker

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/netpolicy"
)

// procSysNet is where the kernel exposes per-interface network settings.
const procSysNet = "/proc/sys/net"

// The host side of a guest link is closed to IPv6 in two independent places.
// The nftables guest_links chain drops IPv6 arriving on it; and the kernel is
// told, per link, not to run IPv6 there at all, so the link has no IPv6
// address, answers no neighbour discovery and drops every IPv6 frame before
// netfilter. Either one holds without the other: a table someone flushed still
// leaves the kernel refusing IPv6, and a link whose setting was flipped back
// still has the table dropping it.
//
// IPv6 is turned off per link, never host-wide. The host may use IPv6 itself,
// and net.ipv6.conf.default would also reach every container link Docker
// creates afterwards.

// VerifyLiveNetwork checks what the kernel enforces right now: the table, and
// IPv6 off on every guest link the table names. Preflight and
// `runner-center-runtime verify-network` both run it, and either layer
// missing fails it. It returns the evidence readiness reports.
func VerifyLiveNetwork(ctx context.Context, policy netpolicy.Policy, nftBinary string) (string, error) {
	live, err := netpolicy.ReadLiveTable(ctx, nftBinary)
	if err != nil {
		return "", err
	}
	return verifyNetworkState(policy, live, procSysNet)
}

func verifyNetworkState(policy netpolicy.Policy, live []byte, root string) (string, error) {
	if err := policy.VerifyNftables(live); err != nil {
		return "", err
	}
	links, err := netpolicy.GuestLinks(live)
	if err != nil {
		return "", err
	}
	if err := verifyGuestLinksIPv6(root, links); err != nil {
		return "", err
	}
	return fmt.Sprintf(
		"host, RFC1918, east-west, guest IPv6 and spoofed guest sources denied for %s with %s egress; "+
			"%d live guest links bound, IPv6 off on each",
		policy.Subnet, policy.EgressMode, len(links),
	), nil
}

// disableLinkIPv6 turns IPv6 off on one guest link and reads the setting back.
// root is procSysNet outside tests.
func disableLinkIPv6(root, link string) error {
	if err := netpolicy.ValidateLinkName(link); err != nil {
		return err
	}
	present, err := hostHasIPv6(root)
	if err != nil || !present {
		return err
	}
	path := linkIPv6Setting(root, link)
	if err := os.WriteFile(path, []byte("1\n"), 0o600); err != nil {
		return fmt.Errorf("turn IPv6 off on guest link %s: %w", link, err)
	}
	disabled, err := linkIPv6Disabled(root, link)
	if err != nil {
		return err
	}
	if !disabled {
		return fmt.Errorf("guest link %s still has IPv6 on after it was turned off", link)
	}
	return nil
}

// verifyGuestLinksIPv6 reports every live guest link that would accept IPv6.
// links come from rc_guest_links. A link that no longer exists passes: CNI
// removes the veth before teardown takes its name out of the set, and a link
// that is gone carries nothing.
func verifyGuestLinksIPv6(root string, links []string) error {
	present, err := hostHasIPv6(root)
	if err != nil || !present {
		return err
	}
	var open []string
	for _, link := range links {
		if err := netpolicy.ValidateLinkName(link); err != nil {
			return err
		}
		disabled, err := linkIPv6Disabled(root, link)
		switch {
		case errors.Is(err, fs.ErrNotExist):
			continue
		case err != nil:
			return err
		case !disabled:
			open = append(open, link)
		}
	}
	if len(open) > 0 {
		return fmt.Errorf(
			"IPv6 is on for guest link %s, which the runtime turned off before the guest booted; "+
				"set net.ipv6.conf.<link>.disable_ipv6=1 again or stop the guest",
			strings.Join(open, ", "),
		)
	}
	return nil
}

// hostHasIPv6 is false only on a kernel with no IPv6 at all, such as one
// booted with ipv6.disable=1, where there is nothing to turn off.
func hostHasIPv6(root string) (bool, error) {
	if _, err := os.Stat(filepath.Join(root, "ipv6")); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return false, nil
		}
		return false, fmt.Errorf("read the host's IPv6 settings: %w", err)
	}
	return true, nil
}

func linkIPv6Setting(root, link string) string {
	return filepath.Join(root, "ipv6", "conf", link, "disable_ipv6")
}

func linkIPv6Disabled(root, link string) (bool, error) {
	value, err := os.ReadFile(linkIPv6Setting(root, link))
	if err != nil {
		return false, fmt.Errorf("read the IPv6 setting of guest link %s: %w", link, err)
	}
	return string(bytes.TrimSpace(value)) == "1", nil
}
