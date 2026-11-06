package firecracker

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
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
// IPv6 off on every guest link the table names. `runner-center-runtime
// verify-network` runs it. It runs outside the runtime, so it cannot know
// which guests are running; Preflight, inside the runtime, also checks that
// every running guest is still in the per-guest sets (see
// verifyAndRestoreNetwork). It returns the evidence readiness reports.
func VerifyLiveNetwork(ctx context.Context, policy netpolicy.Policy, nftBinary string) (string, error) {
	live, err := netpolicy.ReadLiveTable(ctx, nftBinary)
	if err != nil {
		return "", err
	}
	return verifyNetworkState(policy, live, procSysNet, nil)
}

// guestElementOwner is the part of egress.Guard that knows which guests are
// running and what it wrote for each.
type guestElementOwner interface {
	Registered(read func() ([]byte, error)) ([]netpolicy.GuestEgressState, []byte, error)
	Restore(ctx context.Context, missing []netpolicy.GuestEgressState) ([]netpolicy.GuestEgressState, error)
}

// restoreGuestElements reads the table and writes back the per-guest elements
// of every running guest the table has lost. Loading the table file
// (`nft -f nftables.rc.conf`) starts with `delete table`, so it empties every
// per-guest set under guests that keep running: their links accept IPv6 and
// any source address again, and allowlist guests are no longer restricted. The
// kernel's per-link disable_ipv6 survives a reload, but nothing else does.
//
// Nothing is written into a table that does not match the policy: that is a
// readiness failure of its own, and an operator's to fix.
//
// It returns the guests it restored, and the registrations and listing read
// after the restore, which are what the caller should verify.
func restoreGuestElements(
	ctx context.Context,
	policy netpolicy.Policy,
	read func() ([]byte, error),
	owner guestElementOwner,
) (restored, registered []netpolicy.GuestEgressState, live []byte, err error) {
	registered, live, err = owner.Registered(read)
	if err != nil {
		return nil, nil, nil, err
	}
	if policy.VerifyNftables(live) != nil {
		return nil, registered, live, nil
	}
	missing, err := netpolicy.MissingGuestElements(live, registered)
	if err != nil || len(missing) == 0 {
		return nil, registered, live, err
	}
	restored, restoreErr := owner.Restore(ctx, missing)
	registered, live, err = owner.Registered(read)
	if err != nil {
		return restored, nil, nil, err
	}
	return restored, registered, live, restoreErr
}

// verifyAndRestoreNetwork is Preflight's network check. It restores what a
// table reload took from running guests, then verifies the table, the per-guest
// elements of every running guest, and IPv6 off on their links. Restoring
// first is the runtime putting back state it owns; readiness fails only if the
// state cannot be put back.
func verifyAndRestoreNetwork(
	ctx context.Context,
	policy netpolicy.Policy,
	read func() ([]byte, error),
	owner guestElementOwner,
	root string,
) (string, []netpolicy.GuestEgressState, error) {
	restored, registered, live, err := restoreGuestElements(ctx, policy, read, owner)
	if live == nil {
		return "", restored, err
	}
	// A restore that failed for a guest still missing its elements fails the
	// check below, with the reason joined on. One that failed for a guest torn
	// down meanwhile changes nothing the check can see.
	detail, verifyErr := verifyNetworkState(policy, live, root, registered)
	if verifyErr != nil {
		return "", restored, errors.Join(verifyErr, err)
	}
	if len(restored) > 0 {
		detail += fmt.Sprintf(
			"; restored the link binding and egress membership of %d running guests the table had lost",
			len(restored),
		)
	}
	return detail, restored, nil
}

// verifyNetworkState checks the listing against the policy, against what the
// runtime registered for every running guest, and IPv6 off on every guest
// link. registered is nil outside the runtime, which cannot know it.
func verifyNetworkState(
	policy netpolicy.Policy,
	live []byte,
	root string,
	registered []netpolicy.GuestEgressState,
) (string, error) {
	if err := policy.VerifyNftables(live); err != nil {
		return "", err
	}
	missing, err := netpolicy.MissingGuestElements(live, registered)
	if err != nil {
		return "", err
	}
	if len(missing) > 0 {
		guests := make([]string, 0, len(missing))
		for _, state := range missing {
			guests = append(guests, fmt.Sprintf("%s on %s", state.Guest, state.Link))
		}
		return "", fmt.Errorf(
			"running guest %s is missing its link binding or egress membership in table inet %s, "+
				"so its link accepts IPv6 and borrowed source addresses; the table was reloaded or "+
				"edited under it, and the runtime could not restore it",
			strings.Join(guests, ", "), netpolicy.TableName,
		)
	}
	tableLinks, err := netpolicy.GuestLinks(live)
	if err != nil {
		return "", err
	}
	links := slices.Clone(tableLinks)
	for _, state := range registered {
		links = append(links, state.Link)
	}
	slices.Sort(links)
	links = slices.Compact(links)
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
