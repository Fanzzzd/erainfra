package netpolicy

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"net/netip"
	"net/url"
	"regexp"
	"slices"
	"strings"
)

// EgressAudit is public egress plus a host-side record of every DNS name a
// guest queried and every destination it opened. It changes nothing a job can
// reach, which is what makes it the safe first step before an allowlist: run a
// Profile in audit, read what its jobs actually talk to, then switch it to
// allowlist with that list.
const EgressAudit EgressMode = "audit"

// PresetGitHub names the destinations a GitHub Actions job needs to talk to
// GitHub at all. See GitHubPresetDomains.
const PresetGitHub = "github"

// GitHubPresetDomains is what the github preset expands to.
//
// Every entry down to the blank line is copied, heading by heading, from
// GitHub's "Communication requirements" for self-hosted runners
// (https://docs.github.com/en/actions/reference/runners/self-hosted-runners#communication-requirements,
// read 2026-11-05): essential operations, downloading actions, job summaries,
// logs, artifacts and caches, runner version updates, OIDC tokens, GitHub
// Packages, Git LFS, Dependabot, and release assets. The page's "Needed for
// VNet" group is left out: it is for Azure private networking, which a
// Worker never uses.
//
// The same page warns that several of these names are CNAMEs whose targets
// may change and that only the listed names stay constant. The resolver
// therefore allows by the name the guest asked for and admits every address in
// that answer, whatever chain of CNAMEs led to it, so a target that moves does
// not break a job.
//
// *.githubusercontent.com is the one addition. It covers
// raw.githubusercontent.com, which install scripts and many actions fetch from,
// and it subsumes several documented names below; the documented names stay
// listed so the preset reads against GitHub's page line by line.
var GitHubPresetDomains = []string{
	// Needed for essential operations
	"github.com",
	"api.github.com",
	"*.actions.githubusercontent.com",
	// Needed for downloading actions
	"codeload.github.com",
	// Needed for uploading/downloading job summaries, logs, workflow artifacts, and caches
	"results-receiver.actions.githubusercontent.com",
	"*.blob.core.windows.net",
	// Needed for runner version updates
	"objects.githubusercontent.com",
	"objects-origin.githubusercontent.com",
	"github-releases.githubusercontent.com",
	"github-registry-files.githubusercontent.com",
	// Needed for downloading or publishing packages or containers to GitHub Packages
	"*.pkg.github.com",
	"pkg-containers.githubusercontent.com",
	"ghcr.io",
	// Needed for Git Large File Storage
	"github-cloud.githubusercontent.com",
	"github-cloud.s3.amazonaws.com",
	// Needed for jobs for Dependabot updates
	"dependabot-actions.githubapp.com",
	// Needed for downloading release assets
	"release-assets.githubusercontent.com",

	// Not on GitHub's page; see above.
	"*.githubusercontent.com",
}

// Bounds on a Profile's allowlist. They keep the published Profile, the
// readiness evidence and the per-guest nftables state small; a list longer
// than this is a sign the Profile wants public or audit egress instead.
const (
	MaxEgressDomains = 256
	MaxEgressCIDRs   = 256
)

var domainLabel = regexp.MustCompile(`^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$`)

// ProfileEgress is the egress policy a Profile publishes. The controller sets
// it from its own environment, the control plane stores it on the Profile, and
// each Worker renders and verifies it for that Profile's guests.
//
// The zero value is public egress, which is what every Profile published
// before this field existed means.
type ProfileEgress struct {
	Mode    EgressMode `json:"mode,omitempty"`
	Presets []string   `json:"presets,omitempty"`
	Domains []string   `json:"domains,omitempty"`
	CIDRs   []string   `json:"cidrs,omitempty"`
}

// Normalized returns the canonical form two equal policies share: an explicit
// mode, lowercased domains without a trailing dot, masked CIDRs, and every list
// sorted and deduplicated. Validate, Effective and the identity hash all work on
// it, so "GitHub.com." and "github.com" are one policy.
func (e ProfileEgress) Normalized() ProfileEgress {
	normalized := ProfileEgress{Mode: e.Mode}
	if normalized.Mode == "" {
		normalized.Mode = EgressPublic
	}
	for _, preset := range e.Presets {
		if value := strings.ToLower(strings.TrimSpace(preset)); value != "" {
			normalized.Presets = append(normalized.Presets, value)
		}
	}
	for _, domain := range e.Domains {
		if value := NormalizeDomain(domain); value != "" {
			normalized.Domains = append(normalized.Domains, value)
		}
	}
	for _, cidr := range e.CIDRs {
		value := strings.TrimSpace(cidr)
		if value == "" {
			continue
		}
		if prefix, err := parseIPv4Destination(value); err == nil {
			value = prefix.String()
		}
		normalized.CIDRs = append(normalized.CIDRs, value)
	}
	normalized.Presets = sortedUnique(normalized.Presets)
	normalized.Domains = sortedUnique(normalized.Domains)
	normalized.CIDRs = sortedUnique(normalized.CIDRs)
	return normalized
}

// Validate reports whether the policy can be enforced as written.
func (e ProfileEgress) Validate() error {
	e = e.Normalized()
	switch e.Mode {
	case EgressPublic:
		if len(e.Presets)+len(e.Domains)+len(e.CIDRs) > 0 {
			return errors.New("public egress takes no allowlist; use audit or allowlist mode")
		}
	case EgressAudit, EgressAllowlist:
	default:
		return fmt.Errorf("egress mode must be %q, %q or %q", EgressPublic, EgressAudit, EgressAllowlist)
	}
	for _, preset := range e.Presets {
		if preset != PresetGitHub {
			return fmt.Errorf("unknown egress preset %q; the only preset is %q", preset, PresetGitHub)
		}
	}
	if len(e.Domains) > MaxEgressDomains {
		return fmt.Errorf("an egress allowlist holds at most %d domains", MaxEgressDomains)
	}
	if len(e.CIDRs) > MaxEgressCIDRs {
		return fmt.Errorf("an egress allowlist holds at most %d CIDRs", MaxEgressCIDRs)
	}
	for _, domain := range e.Domains {
		if err := validateDomainPattern(domain); err != nil {
			return err
		}
	}
	for _, cidr := range e.CIDRs {
		if _, err := parseIPv4Destination(cidr); err != nil {
			return fmt.Errorf("allowed CIDR %q: %w", cidr, err)
		}
	}
	// An allowlist with nothing on it would deny GitHub itself, so the job
	// could not even fetch its own definition. That is a misconfiguration, not
	// a stricter policy.
	if e.Mode == EgressAllowlist && len(e.Presets)+len(e.Domains)+len(e.CIDRs) == 0 {
		return fmt.Errorf("allowlist egress with nothing allowed denies GitHub itself; add the %q preset", PresetGitHub)
	}
	return nil
}

// NormalizeDomain lowercases a name and strips surrounding space and the
// trailing root dot. It does not validate.
func NormalizeDomain(domain string) string {
	return strings.TrimSuffix(strings.ToLower(strings.TrimSpace(domain)), ".")
}

func validateDomainPattern(domain string) error {
	name := strings.TrimPrefix(domain, "*.")
	if strings.Contains(name, "*") {
		return fmt.Errorf("allowed domain %q: a wildcard is allowed only as the whole first label", domain)
	}
	if len(name) > 253 {
		return fmt.Errorf("allowed domain %q is longer than 253 characters", domain)
	}
	labels := strings.Split(name, ".")
	// A single label is not a public name, and allowing one would let a guest
	// resolve whatever the upstream resolver's search path makes of it.
	if len(labels) < 2 {
		return fmt.Errorf("allowed domain %q must have at least two labels", domain)
	}
	for _, label := range labels {
		if !domainLabel.MatchString(label) {
			return fmt.Errorf("allowed domain %q has an invalid label %q", domain, label)
		}
	}
	if _, err := netip.ParseAddr(name); err == nil {
		return fmt.Errorf("allowed domain %q is an address; list it as a CIDR", domain)
	}
	return nil
}

// parseIPv4Destination accepts an IPv4 CIDR or a bare IPv4 address, which
// means a /32, and returns it masked.
func parseIPv4Destination(value string) (netip.Prefix, error) {
	if !strings.Contains(value, "/") {
		address, err := netip.ParseAddr(value)
		if err != nil {
			return netip.Prefix{}, err
		}
		if !address.Is4() {
			return netip.Prefix{}, errors.New("must be IPv4; guests have no IPv6 egress")
		}
		return netip.PrefixFrom(address, 32), nil
	}
	prefix, err := netip.ParsePrefix(value)
	if err != nil {
		return netip.Prefix{}, err
	}
	if !prefix.Addr().Is4() {
		return netip.Prefix{}, errors.New("must be IPv4; guests have no IPv6 egress")
	}
	return prefix.Masked(), nil
}

func sortedUnique(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	sorted := slices.Clone(values)
	slices.Sort(sorted)
	return slices.Compact(sorted)
}

// egressRank orders modes by how much they restrict or observe. The stricter
// of the host's and the Profile's mode is the one a guest gets.
func egressRank(mode EgressMode) int {
	switch mode {
	case EgressAudit:
		return 1
	case EgressAllowlist:
		return 2
	default:
		return 0
	}
}

// StricterEgress returns the stricter of two modes.
func StricterEgress(left, right EgressMode) EgressMode {
	if egressRank(right) > egressRank(left) {
		return right
	}
	if left == "" {
		return EgressPublic
	}
	return left
}

// EffectiveEgress is what one Profile's guests get on one Worker: the
// Profile's policy combined with the host operator's RC_EGRESS_* override.
//
// The rule is that every layer with an opinion must allow a destination, so
// the stricter one always wins:
//
//   - The mode is the stricter of the two. A host in audit records every
//     guest; a Profile in audit records its own.
//   - A host in allowlist mode keeps its own default deny for every guest, in
//     the shared forward chain, whatever a Profile says. A Profile allowlist is
//     enforced per guest before that chain's accept, so a guest under both
//     reaches only what both allow.
//   - A Profile cannot open a private, host or special-purpose range. Those
//     stay dropped unless the host operator lists them in RC_EGRESS_ALLOW, and
//     a Profile allowlist must name them too.
type EffectiveEgress struct {
	// Mode is the stricter of HostMode and Profile.Mode.
	Mode     EgressMode
	HostMode EgressMode
	// Profile is the published policy, normalized.
	Profile ProfileEgress
	// Observed guests have their DNS answered by the host resolver and their
	// new flows recorded.
	Observed bool
	// Restricted guests may open new flows only to Domains and CIDRs.
	Restricted bool
	// Domains are the Profile's domains with presets expanded, plus the cache
	// service host when it is named rather than addressed.
	Domains []string
	// CIDRs are the Profile's CIDRs, plus the cache service address when the
	// cache service is addressed by IP.
	CIDRs []string
}

// Effective combines the host policy with a Profile's egress. serviceURLs are
// the endpoints the Worker itself hands every guest (its cache service and its
// registry mirror); empty entries are skipped. A job that can reach them only
// through an allowlist the operator has to remember to extend is a job that
// silently runs cold, so they are always allowed.
func Effective(host Policy, profile ProfileEgress, serviceURLs ...string) (EffectiveEgress, error) {
	profile = profile.Normalized()
	if err := profile.Validate(); err != nil {
		return EffectiveEgress{}, err
	}
	hostMode := host.EgressMode
	if hostMode == "" {
		hostMode = EgressPublic
	}
	effective := EffectiveEgress{
		Mode:       StricterEgress(hostMode, profile.Mode),
		HostMode:   hostMode,
		Profile:    profile,
		Observed:   egressRank(hostMode) >= 1 || egressRank(profile.Mode) >= 1,
		Restricted: profile.Mode == EgressAllowlist,
	}
	if profile.Mode == EgressPublic {
		return effective, nil
	}
	domains := slices.Clone(profile.Domains)
	for _, preset := range profile.Presets {
		if preset == PresetGitHub {
			domains = append(domains, GitHubPresetDomains...)
		}
	}
	cidrs := slices.Clone(profile.CIDRs)
	for _, serviceURL := range serviceURLs {
		if serviceURL == "" {
			continue
		}
		domain, cidr, err := serviceDestination(serviceURL)
		if err != nil {
			return EffectiveEgress{}, err
		}
		if domain != "" {
			domains = append(domains, domain)
		}
		if cidr != "" {
			cidrs = append(cidrs, cidr)
		}
	}
	subnet, err := netip.ParsePrefix(host.Subnet)
	if err != nil {
		return EffectiveEgress{}, fmt.Errorf("host subnet: %w", err)
	}
	for _, cidr := range cidrs {
		prefix, parseErr := parseIPv4Destination(cidr)
		if parseErr != nil {
			return EffectiveEgress{}, fmt.Errorf("allowed CIDR %q: %w", cidr, parseErr)
		}
		if prefix.Overlaps(subnet) {
			return EffectiveEgress{}, fmt.Errorf(
				"allowed CIDR %q overlaps the guest subnet %s, which would re-enable east-west traffic",
				cidr, host.Subnet,
			)
		}
	}
	effective.Domains = sortedUnique(domains)
	effective.CIDRs = sortedUnique(cidrs)
	return effective, nil
}

func serviceDestination(serviceURL string) (domain, cidr string, err error) {
	parsed, err := url.Parse(serviceURL)
	if err != nil || parsed.Hostname() == "" {
		return "", "", fmt.Errorf("service URL %q names no host", serviceURL)
	}
	host := parsed.Hostname()
	if address, parseErr := netip.ParseAddr(host); parseErr == nil {
		if !address.Is4() {
			return "", "", fmt.Errorf("service address %s must be IPv4", address)
		}
		return "", netip.PrefixFrom(address, 32).String(), nil
	}
	name := NormalizeDomain(host)
	if err := validateDomainPattern(name); err != nil {
		return "", "", fmt.Errorf("service host: %w", err)
	}
	return name, "", nil
}

// IdentityHash names the exact network contract one Profile's guests get on
// this Worker: the host policy's identity plus everything the Profile's egress
// adds. It is the network policy hash a Worker reports as readiness evidence
// for that Profile, so changing a Profile's egress, the host override, or the
// cache endpoint each produce a different identity.
func (e EffectiveEgress) IdentityHash(host Policy) string {
	hash := sha256.New()
	fmt.Fprintf(hash, "runner-center-profile-egress/v1\nhost=%q\nmode=%q\nprofile-mode=%q\nresolver-port=%d\n", //nolint:errcheck // hash.Hash.Write never returns an error
		host.IdentityHash(), e.Mode, e.Profile.Mode, ResolverPort)
	for _, preset := range e.Profile.Presets {
		fmt.Fprintf(hash, "preset=%q\n", preset) //nolint:errcheck // hash.Hash.Write never returns an error
	}
	for _, domain := range e.Domains {
		fmt.Fprintf(hash, "domain=%q\n", domain) //nolint:errcheck // hash.Hash.Write never returns an error
	}
	for _, cidr := range e.CIDRs {
		fmt.Fprintf(hash, "cidr=%q\n", cidr) //nolint:errcheck // hash.Hash.Write never returns an error
	}
	return fmt.Sprintf("sha256:%x", hash.Sum(nil))
}

// DomainMatcher answers whether a queried name is on an allowlist. An exact
// entry matches only itself; "*.example.com" matches every name under
// example.com at any depth but not example.com itself, which is how TLS
// wildcards and every egress filter in this space read it.
type DomainMatcher struct {
	exact    map[string]struct{}
	suffixes []string
}

func NewDomainMatcher(domains []string) DomainMatcher {
	matcher := DomainMatcher{exact: make(map[string]struct{}, len(domains))}
	for _, domain := range domains {
		domain = NormalizeDomain(domain)
		if suffix, wildcard := strings.CutPrefix(domain, "*."); wildcard {
			matcher.suffixes = append(matcher.suffixes, "."+suffix)
			continue
		}
		matcher.exact[domain] = struct{}{}
	}
	return matcher
}

// Allows reports whether name is on the list. name may carry the trailing
// root dot DNS uses on the wire.
func (m DomainMatcher) Allows(name string) bool {
	name = NormalizeDomain(name)
	if name == "" {
		return false
	}
	if _, ok := m.exact[name]; ok {
		return true
	}
	for _, suffix := range m.suffixes {
		if strings.HasSuffix(name, suffix) {
			return true
		}
	}
	return false
}
