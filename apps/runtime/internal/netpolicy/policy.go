// Package netpolicy renders and verifies the job-scoped network policy that
// isolates a Firecracker guest from the host, from private networks, and from
// every other guest.
//
// The policy has two halves and this package owns both, so that what an
// operator installs and what Preflight accepts can never drift:
//
//   - a CNI configuration list, which gives each guest a point-to-point link
//     with no shared layer 2 segment; and
//   - an nftables table, which drops guest traffic aimed at the host, at
//     RFC1918 and other special-purpose ranges, and at other guests, while
//     letting an operator name exceptions explicitly.
//
// Everything here is operating-system independent on purpose: rendering and
// verification are pure functions over bytes, so the isolation contract is unit
// tested on any developer machine rather than only on a provisioned host.
package netpolicy

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"net/netip"
	"regexp"
	"strings"
)

// TableName is the nftables table the policy owns. EraInfra never edits a
// table it does not own, so a host can keep running Docker or Kubernetes
// networking beside it.
const TableName = "runner-center"

// GuestSetName and AllowSetName are the named sets the rules match on. They are
// part of the verified contract because a rule that matched a different set
// would silently stop isolating anything.
const (
	GuestSetName = "rc_guests"
	AllowSetName = "rc_egress_allow"
)

// Per-guest sets. The runtime fills them while a guest is alive and empties
// them at teardown; the rules that read them are static and verified like every
// other rule, so a Profile's egress changes what is in a set, never what the
// table enforces.
const (
	// ObservedSetName holds guests whose DNS is answered by the host resolver
	// and whose new flows are recorded: audit and allowlist guests.
	ObservedSetName = "rc_observed"
	// RestrictedSetName holds guests under a Profile allowlist.
	RestrictedSetName = "rc_restricted"
	// AllowCIDRSetName maps a restricted guest to the CIDRs its Profile allows.
	AllowCIDRSetName = "rc_allow_cidr"
	// AllowDNSSetName maps a restricted guest to the addresses the host
	// resolver handed it for allowed names, each until its DNS TTL runs out.
	AllowDNSSetName = "rc_allow_dns"
	// FlowSetName and BlockedSetName record the new flows observed guests
	// opened, and the subset a Profile allowlist dropped, as
	// guest . destination . protocol . port.
	FlowSetName    = "rc_flows"
	BlockedSetName = "rc_blocked"
)

// RestrictedChain is the regular chain a restricted guest's new flows jump to.
const RestrictedChain = "restricted"

// ResolverPort is where the host resolver listens on the guest gateway
// address. An observed guest's DNS, to whatever server it names, is redirected
// here, so a guest cannot pick a resolver that ignores its allowlist.
const ResolverPort = 10053

// FlowRecordCapacity bounds each flow record set. A set that is full stops
// recording; it never stops forwarding.
const FlowRecordCapacity = 65536

// EgressMode selects how much of the internet a guest may reach once the host,
// private and east-west drops have been applied.
type EgressMode string

const (
	// EgressPublic lets a guest reach public addresses. GitHub, GHCR and the
	// package registries a CI job needs all live there, and every private
	// destination is still denied.
	EgressPublic EgressMode = "public"
	// EgressAllowlist denies every destination that is not listed. On the host
	// policy that is AllowedDestinations, for every guest on the Worker; on a
	// Profile it is the Profile's domains and CIDRs, for that Profile's guests.
	EgressAllowlist EgressMode = "allowlist"
)

// deniedRanges are the destinations a guest must never reach through the host.
// The guest subnet itself is a subset of 10.0.0.0/8, but east-west is dropped by
// its own rule first so that an audit can see the intent separately.
//
// 169.254.0.0/16 is denied even though MMDS lives at 169.254.169.254: MMDS is
// answered inside the VMM before a packet ever reaches the host network stack,
// so denying link-local on the wire costs the guest nothing and closes cloud
// metadata endpoints belonging to the host.
var deniedRanges = []string{
	"10.0.0.0/8",
	"172.16.0.0/12",
	"192.168.0.0/16",
	"100.64.0.0/10",
	"169.254.0.0/16",
	"127.0.0.0/8",
	"0.0.0.0/8",
	"192.0.0.0/24",
	"192.0.2.0/24",
	"198.18.0.0/15",
	"198.51.100.0/24",
	"203.0.113.0/24",
	"224.0.0.0/4",
	"240.0.0.0/4",
}

// Rule identities. Every rule the policy installs carries one as an nftables
// comment, and Verify requires all of them to still be present. Removing a rule
// by hand therefore fails Preflight instead of silently widening the boundary.
const (
	RuleDenyEastWest      = "rc:deny-east-west"
	RuleAllowDestinations = "rc:allow-destinations"
	RuleDenyPrivate       = "rc:deny-private"
	RuleDenyDefault       = "rc:deny-default"
	RuleDenyHostInput     = "rc:deny-host-input"

	RuleRecordFlows           = "rc:record-flows"
	RuleRestrictProfile       = "rc:restrict-profile"
	RuleRestrictedEstablished = "rc:restricted-established"
	RuleRestrictedAllowCIDR   = "rc:restricted-allow-cidr"
	RuleRestrictedAllowDNS    = "rc:restricted-allow-dns"
	RuleRecordBlocked         = "rc:record-blocked"
	RuleRestrictedDeny        = "rc:restricted-deny"
	RuleRedirectDNS           = "rc:redirect-dns"
	RuleAllowResolver         = "rc:allow-resolver"
)

// RequiredKernelArgs are boot arguments the guest kernel must carry for the
// policy to hold. A guest with IPv6 enabled could reach a host or peer address
// the IPv4 rules never see, so the boundary depends on this as much as on
// nftables and Preflight refuses to start without it.
var RequiredKernelArgs = []string{"ipv6.disable=1"}

var networkNamePattern = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$`)

// Policy is the complete, verifiable description of a Profile's job network.
type Policy struct {
	// Name is the CNI network name. The conflist file is 10-<Name>.conflist and
	// the Firecracker network interface refers to the same name.
	Name string
	// Subnet is the address range host-local hands out, one address per guest.
	Subnet string
	// EgressMode is the host operator's override: public, audit, or
	// allowlist-only egress for every guest on this Worker. A Profile's own
	// egress combines with it; see EffectiveEgress.
	EgressMode EgressMode
	// AllowedDestinations are CIDRs the guest may reach even though a deny rule
	// would otherwise cover them, and the only destinations allowed at all under
	// EgressAllowlist. An operator names an internal proxy or registry here.
	AllowedDestinations []string
	// Nameservers are the resolvers written into the guest's CNI DNS section.
	// They must be reachable under the resulting policy, so a private resolver
	// has to appear in AllowedDestinations too.
	Nameservers []string
	// MTU is the guest link MTU. Zero lets CNI choose.
	MTU int
}

// DefaultPolicy denies the host, every private range and east-west traffic,
// and allows the public internet a CI job needs.
func DefaultPolicy(name string) Policy {
	return Policy{
		Name:                name,
		Subnet:              "10.241.0.0/16",
		EgressMode:          EgressPublic,
		AllowedDestinations: nil,
		Nameservers:         []string{"1.1.1.1", "9.9.9.9"},
		MTU:                 1500,
	}
}

// IdentityHash is a stable identity for the exact network contract this build
// expects and Preflight verifies. It covers every policy input plus the kernel
// arguments that keep guests on the verified IPv4 path; changing any of them
// produces a different identity for control-plane readiness evidence.
func (p Policy) IdentityHash() string {
	hash := sha256.New()
	fmt.Fprintf(hash, "runner-center-network-policy/v2\nname=%q\nsubnet=%q\negress=%q\nmtu=%d\n", //nolint:errcheck // hash.Hash.Write never returns an error
		p.Name, p.Subnet, p.EgressMode, p.MTU)
	for _, destination := range p.AllowedDestinations {
		fmt.Fprintf(hash, "allow=%q\n", destination) //nolint:errcheck // hash.Hash.Write never returns an error
	}
	for _, nameserver := range p.Nameservers {
		fmt.Fprintf(hash, "nameserver=%q\n", nameserver) //nolint:errcheck // hash.Hash.Write never returns an error
	}
	for _, argument := range RequiredKernelArgs {
		fmt.Fprintf(hash, "kernel-argument=%q\n", argument) //nolint:errcheck // hash.Hash.Write never returns an error
	}
	return fmt.Sprintf("sha256:%x", hash.Sum(nil))
}

func (p Policy) Validate() error {
	if !networkNamePattern.MatchString(p.Name) {
		return errors.New("network name must be 1-32 lowercase alphanumeric or dash characters")
	}
	subnet, err := netip.ParsePrefix(p.Subnet)
	if err != nil {
		return fmt.Errorf("subnet: %w", err)
	}
	if !subnet.Addr().Is4() {
		return errors.New("subnet must be IPv4; guests have no IPv6 egress")
	}
	if subnet.Bits() > 24 {
		return errors.New("subnet must be /24 or larger to address concurrent guests")
	}
	if !subnet.Addr().IsPrivate() {
		return errors.New("subnet must be a private range so guest addresses are never routable")
	}
	switch p.EgressMode {
	case EgressPublic, EgressAudit, EgressAllowlist:
	default:
		return fmt.Errorf("egress mode must be %q, %q or %q", EgressPublic, EgressAudit, EgressAllowlist)
	}
	for _, destination := range p.AllowedDestinations {
		prefix, parseErr := netip.ParsePrefix(destination)
		if parseErr != nil {
			return fmt.Errorf("allowed destination %q: %w", destination, parseErr)
		}
		if !prefix.Addr().Is4() {
			return fmt.Errorf("allowed destination %q must be IPv4", destination)
		}
		if prefix.Overlaps(subnet) {
			return fmt.Errorf(
				"allowed destination %q overlaps the guest subnet, which would re-enable east-west traffic",
				destination,
			)
		}
	}
	if len(p.Nameservers) == 0 {
		return errors.New("at least one nameserver is required")
	}
	for _, nameserver := range p.Nameservers {
		address, parseErr := netip.ParseAddr(nameserver)
		if parseErr != nil {
			return fmt.Errorf("nameserver %q: %w", nameserver, parseErr)
		}
		if !address.Is4() {
			return fmt.Errorf("nameserver %q must be IPv4", nameserver)
		}
		if reachable, reason := p.reaches(address); !reachable {
			return fmt.Errorf("nameserver %q is unreachable under this policy: %s", nameserver, reason)
		}
	}
	if p.MTU < 0 || p.MTU > 65_535 {
		return errors.New("MTU must be between 0 and 65535")
	}
	return nil
}

// reaches reports whether a guest could open a connection to address, and why
// not when it could not. Validate uses it so a policy cannot ship with a
// resolver its own rules drop.
func (p Policy) reaches(address netip.Addr) (bool, string) {
	for _, destination := range p.AllowedDestinations {
		if prefix, err := netip.ParsePrefix(destination); err == nil && prefix.Contains(address) {
			return true, ""
		}
	}
	if p.EgressMode == EgressAllowlist {
		return false, "allowlist egress denies every destination that is not listed"
	}
	for _, denied := range deniedRanges {
		prefix, err := netip.ParsePrefix(denied)
		if err != nil {
			continue
		}
		if prefix.Contains(address) {
			return false, "it falls inside the denied range " + denied
		}
	}
	return true, ""
}

// ResolverAddress is the guest gateway: the address ptp puts on the host side
// of every guest's link, host-local's default of the subnet's first address.
// The DNS redirect lands there, so the host resolver listens there.
func (p Policy) ResolverAddress() (netip.Addr, error) {
	subnet, err := netip.ParsePrefix(p.Subnet)
	if err != nil {
		return netip.Addr{}, fmt.Errorf("subnet: %w", err)
	}
	return subnet.Masked().Addr().Next(), nil
}

// ConflistFileName is the file the CNI configuration directory must contain.
// firecracker-go-sdk resolves a network by this exact naming convention.
func (p Policy) ConflistFileName() string {
	return "10-" + p.Name + ".conflist"
}

// RequiredPlugins are the CNI binaries the chain executes, in order.
//
// ptp rather than bridge is deliberate: bridge would put every guest on one
// layer 2 segment, where east-west traffic never reaches a routing hook and can
// therefore not be filtered. ptp gives each guest a point-to-point link, so all
// guest-to-guest traffic must traverse the host forward chain, where the policy
// drops it.
func RequiredPlugins() []string {
	return []string{"ptp", "firewall", "host-local", "tc-redirect-tap"}
}

func (p Policy) allowedOrEmpty() []string {
	if len(p.AllowedDestinations) == 0 {
		return nil
	}
	return append([]string(nil), p.AllowedDestinations...)
}

func joinCIDRs(values []string) string {
	return strings.Join(values, ", ")
}
