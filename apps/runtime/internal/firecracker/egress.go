package firecracker

import (
	"fmt"
	"slices"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/executor"
	"github.com/Fanzzzd/erainfra/apps/runtime/internal/netpolicy"
)

// egressReadiness is the network evidence and the egress-policy check for one
// Profile on this host. It is pure apart from health, which reports whether
// the host resolver is serving, so the rule is unit tested off Linux.
//
// The policy hash changes with the Profile's egress: the control plane sees a
// different identity for a Profile whose egress changed, and for two Profiles
// on one Worker whose guests get different networks.
func egressReadiness(
	host netpolicy.Policy,
	profile netpolicy.ProfileEgress,
	serviceURLs []string,
	health func() error,
) (executor.Network, executor.Check) {
	network := executor.Network{
		PolicyName:          host.Name,
		PolicyHash:          host.IdentityHash(),
		Subnet:              host.Subnet,
		EgressMode:          string(netpolicy.StricterEgress(host.EgressMode, netpolicy.EgressPublic)),
		AllowedDestinations: host.AllowedDestinations,
	}
	effective, err := netpolicy.Effective(host, profile, serviceURLs...)
	if err != nil {
		return network, executor.Check{
			Name: executor.CheckEgressPolicy, Passed: false,
			Detail: fmt.Sprintf("the Profile's egress cannot be enforced on this Worker: %v", err),
		}
	}
	network.PolicyHash = effective.IdentityHash(host)
	network.EgressMode = string(effective.Mode)
	network.Egress = &executor.Egress{
		Mode:               string(effective.Mode),
		HostMode:           string(effective.HostMode),
		ProfileMode:        string(effective.Profile.Mode),
		Presets:            slices.Clone(effective.Profile.Presets),
		Domains:            slices.Clone(effective.Profile.Domains),
		CIDRs:              slices.Clone(effective.Profile.CIDRs),
		AllowedDomainCount: len(effective.Domains),
	}
	if !effective.Observed {
		return network, executor.Check{
			Name: executor.CheckEgressPolicy, Passed: true,
			Detail: "public egress: no per-guest state and no host resolver needed",
		}
	}
	if err := health(); err != nil {
		return network, executor.Check{
			Name: executor.CheckEgressPolicy, Passed: false,
			Detail: fmt.Sprintf("%s egress needs the host resolver: %v", effective.Mode, err),
		}
	}
	detail := fmt.Sprintf("%s egress; DNS redirected to the host resolver on port %d", effective.Mode, netpolicy.ResolverPort)
	if effective.Restricted {
		detail = fmt.Sprintf("allowlist egress to %d domains and %d CIDRs; DNS redirected to the host resolver on port %d",
			len(effective.Domains), len(effective.CIDRs), netpolicy.ResolverPort)
	}
	return network, executor.Check{Name: executor.CheckEgressPolicy, Passed: true, Detail: detail}
}
