package netpolicy

import (
	"encoding/json"
	"net/netip"
	"os"
	"slices"
	"strings"
	"testing"
	"time"
)

func allowlist(domains ...string) ProfileEgress {
	return ProfileEgress{Mode: EgressAllowlist, Presets: []string{PresetGitHub}, Domains: domains}
}

func TestProfileEgressZeroValueIsPublic(t *testing.T) {
	// A Profile published before egress existed carries no field at all, and
	// that has to keep meaning exactly what it meant then.
	var unset ProfileEgress
	if err := unset.Validate(); err != nil {
		t.Fatalf("an unset policy must be valid: %v", err)
	}
	if got := unset.Normalized().Mode; got != EgressPublic {
		t.Fatalf("unset mode normalizes to %q, want public", got)
	}
	effective, err := Effective(DefaultPolicy("runner-center"), unset, "")
	if err != nil {
		t.Fatalf("effective: %v", err)
	}
	if effective.Mode != EgressPublic || effective.Observed || effective.Restricted {
		t.Fatalf("unset Profile egress must be inert public egress, got %+v", effective)
	}
}

func TestProfileEgressNormalizesToOneCanonicalForm(t *testing.T) {
	left := ProfileEgress{
		Mode:    EgressAllowlist,
		Presets: []string{" GitHub "},
		Domains: []string{"Registry.NPMJS.org.", "registry.npmjs.org", "*.Example.com"},
		CIDRs:   []string{"140.82.112.7/20", "1.2.3.4"},
	}
	want := ProfileEgress{
		Mode:    EgressAllowlist,
		Presets: []string{"github"},
		Domains: []string{"*.example.com", "registry.npmjs.org"},
		CIDRs:   []string{"1.2.3.4/32", "140.82.112.0/20"},
	}
	got := left.Normalized()
	if got.Mode != want.Mode || !slices.Equal(got.Presets, want.Presets) ||
		!slices.Equal(got.Domains, want.Domains) || !slices.Equal(got.CIDRs, want.CIDRs) {
		t.Fatalf("normalized = %+v, want %+v", got, want)
	}
}

func TestProfileEgressValidateRejectsWhatCannotBeEnforced(t *testing.T) {
	cases := map[string]ProfileEgress{
		"an unknown mode":                   {Mode: "block"},
		"a public policy with an allowlist": {Mode: EgressPublic, Domains: []string{"github.com"}},
		"an allowlist that allows nothing":  {Mode: EgressAllowlist},
		"an unknown preset":                 {Mode: EgressAllowlist, Presets: []string{"gitlab"}},
		"a wildcard in the middle":          {Mode: EgressAllowlist, Domains: []string{"a.*.example.com"}},
		"a bare wildcard":                   {Mode: EgressAllowlist, Domains: []string{"*"}},
		"a single label":                    {Mode: EgressAllowlist, Domains: []string{"localhost"}},
		"an address listed as a domain":     {Mode: EgressAllowlist, Domains: []string{"10.0.0.1"}},
		"an IPv6 CIDR":                      {Mode: EgressAllowlist, CIDRs: []string{"2001:db8::/32"}},
		"a malformed CIDR":                  {Mode: EgressAllowlist, CIDRs: []string{"300.1.1.0/24"}},
		"an underscore-free invalid label":  {Mode: EgressAllowlist, Domains: []string{"-bad.example.com"}},
	}
	for name, policy := range cases {
		t.Run(name, func(t *testing.T) {
			if err := policy.Validate(); err == nil {
				t.Fatalf("%+v must be rejected", policy)
			}
		})
	}
	tooMany := ProfileEgress{Mode: EgressAllowlist}
	for index := range MaxEgressDomains + 1 {
		tooMany.Domains = append(tooMany.Domains, "host"+strings.Repeat("x", index%5)+string(rune('a'+index%26))+
			".example"+strings.Repeat("y", index/26)+".com")
	}
	if err := tooMany.Validate(); err == nil {
		t.Fatal("an allowlist longer than the bound must be rejected")
	}
}

func TestProfileEgressAuditMayCarryTheListItWillLaterEnforce(t *testing.T) {
	// Audit marks which names the list would allow, so an operator can read
	// the record against the list before switching the Profile to allowlist.
	policy := ProfileEgress{Mode: EgressAudit, Presets: []string{PresetGitHub}, Domains: []string{"registry.npmjs.org"}}
	if err := policy.Validate(); err != nil {
		t.Fatalf("audit with a list must be valid: %v", err)
	}
}

func TestGitHubPresetCarriesGitHubsDocumentedRunnerDomains(t *testing.T) {
	for _, documented := range []string{
		"github.com",
		"api.github.com",
		"*.actions.githubusercontent.com",
		"codeload.github.com",
		"results-receiver.actions.githubusercontent.com",
		"*.blob.core.windows.net",
		"objects.githubusercontent.com",
		"objects-origin.githubusercontent.com",
		"github-releases.githubusercontent.com",
		"github-registry-files.githubusercontent.com",
		"*.pkg.github.com",
		"pkg-containers.githubusercontent.com",
		"ghcr.io",
		"github-cloud.githubusercontent.com",
		"github-cloud.s3.amazonaws.com",
		"dependabot-actions.githubapp.com",
		"release-assets.githubusercontent.com",
	} {
		if !slices.Contains(GitHubPresetDomains, documented) {
			t.Errorf("github preset is missing %q from GitHub's communication requirements", documented)
		}
	}
	for _, domain := range GitHubPresetDomains {
		if err := validateDomainPattern(domain); err != nil {
			t.Errorf("preset entry %q is invalid: %v", domain, err)
		}
	}
	matcher := NewDomainMatcher(GitHubPresetDomains)
	for _, name := range []string{
		"github.com.",
		"pipelines.actions.githubusercontent.com",
		"productionresultssa0.blob.core.windows.net",
		"raw.githubusercontent.com",
		"npm.pkg.github.com",
	} {
		if !matcher.Allows(name) {
			t.Errorf("a GitHub job needs %q, which the preset denies", name)
		}
	}
	for _, name := range []string{"registry.npmjs.org", "evil-github.com", "githubusercontent.com.evil.net"} {
		if matcher.Allows(name) {
			t.Errorf("the github preset must not allow %q", name)
		}
	}
}

func TestDomainMatcherReadsWildcardsLikeTLS(t *testing.T) {
	matcher := NewDomainMatcher([]string{"*.example.com", "exact.test"})
	cases := map[string]bool{
		"a.example.com":       true,
		"a.b.example.com":     true,
		"A.Example.COM.":      true,
		"example.com":         false,
		"badexample.com":      false,
		"example.com.evil.io": false,
		"exact.test":          true,
		"sub.exact.test":      false,
		"":                    false,
	}
	for name, want := range cases {
		if got := matcher.Allows(name); got != want {
			t.Errorf("Allows(%q) = %v, want %v", name, got, want)
		}
	}
}

func TestEffectiveEgressTheStricterLayerWins(t *testing.T) {
	host := DefaultPolicy("runner-center")
	auditHost := host
	auditHost.EgressMode = EgressAudit
	allowlistHost := host
	allowlistHost.EgressMode = EgressAllowlist
	allowlistHost.Nameservers = []string{"1.1.1.1"}
	allowlistHost.AllowedDestinations = []string{"1.1.1.1/32"}

	cases := []struct {
		name       string
		host       Policy
		profile    ProfileEgress
		mode       EgressMode
		observed   bool
		restricted bool
	}{
		{"public host, public Profile", host, ProfileEgress{}, EgressPublic, false, false},
		{"public host, audit Profile", host, ProfileEgress{Mode: EgressAudit}, EgressAudit, true, false},
		{"public host, allowlist Profile", host, allowlist(), EgressAllowlist, true, true},
		{"audit host, public Profile", auditHost, ProfileEgress{}, EgressAudit, true, false},
		{"audit host, allowlist Profile", auditHost, allowlist(), EgressAllowlist, true, true},
		// The host's own default deny lives in the shared chain and applies to
		// every guest; a public Profile adds no per-guest restriction of its own.
		{"allowlist host, public Profile", allowlistHost, ProfileEgress{}, EgressAllowlist, true, false},
		{"allowlist host, allowlist Profile", allowlistHost, allowlist(), EgressAllowlist, true, true},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			effective, err := Effective(testCase.host, testCase.profile, "")
			if err != nil {
				t.Fatalf("effective: %v", err)
			}
			if effective.Mode != testCase.mode || effective.Observed != testCase.observed ||
				effective.Restricted != testCase.restricted {
				t.Fatalf("got mode=%s observed=%v restricted=%v, want mode=%s observed=%v restricted=%v",
					effective.Mode, effective.Observed, effective.Restricted,
					testCase.mode, testCase.observed, testCase.restricted)
			}
		})
	}
}

func TestEffectiveEgressExpandsPresetsAndAlwaysAllowsTheCacheService(t *testing.T) {
	host := DefaultPolicy("runner-center")
	named, err := Effective(host, allowlist("registry.npmjs.org"), "https://Cache.Internal:8721")
	if err != nil {
		t.Fatalf("effective: %v", err)
	}
	for _, want := range []string{"github.com", "registry.npmjs.org", "cache.internal"} {
		if !slices.Contains(named.Domains, want) {
			t.Fatalf("effective domains %v are missing %q", named.Domains, want)
		}
	}
	addressed, err := Effective(host, allowlist(), "http://192.168.50.10:8721")
	if err != nil {
		t.Fatalf("effective: %v", err)
	}
	if !slices.Contains(addressed.CIDRs, "192.168.50.10/32") {
		t.Fatalf("an addressed cache service must be allowed as a /32, got %v", addressed.CIDRs)
	}
}

func TestEffectiveEgressAllowsEveryEndpointTheWorkerHandsTheGuest(t *testing.T) {
	effective, err := Effective(DefaultPolicy("runner-center"), allowlist(),
		"https://cache.internal:8721", "", "http://203.0.113.9:5000")
	if err != nil {
		t.Fatalf("effective: %v", err)
	}
	if !slices.Contains(effective.Domains, "cache.internal") || !slices.Contains(effective.CIDRs, "203.0.113.9/32") {
		t.Fatalf("the cache service and the registry mirror must both be allowed, got %v %v",
			effective.Domains, effective.CIDRs)
	}
}

func TestEffectiveEgressRefusesACIDRInsideTheGuestSubnet(t *testing.T) {
	policy := ProfileEgress{Mode: EgressAllowlist, CIDRs: []string{"10.241.3.0/24"}}
	if _, err := Effective(DefaultPolicy("runner-center"), policy, ""); err == nil {
		t.Fatal("a Profile must not be able to re-enable east-west traffic")
	}
}

func TestEffectiveIdentityHashChangesWithEveryPolicyInput(t *testing.T) {
	host := DefaultPolicy("runner-center")
	identity := func(host Policy, profile ProfileEgress, cache string) string {
		t.Helper()
		effective, err := Effective(host, profile, cache)
		if err != nil {
			t.Fatalf("effective: %v", err)
		}
		return effective.IdentityHash(host)
	}
	base := identity(host, allowlist(), "")
	if base != identity(host, allowlist(), "") {
		t.Fatal("the same contract must have a stable identity")
	}
	if base != identity(host, ProfileEgress{Mode: EgressAllowlist, Presets: []string{"GitHub"}}, "") {
		t.Fatal("two spellings of one policy must share an identity")
	}
	otherHost := host
	otherHost.EgressMode = EgressAudit
	changed := map[string]string{
		"public Profile":     identity(host, ProfileEgress{}, ""),
		"audit Profile":      identity(host, ProfileEgress{Mode: EgressAudit, Presets: []string{"github"}}, ""),
		"an added domain":    identity(host, allowlist("registry.npmjs.org"), ""),
		"an added CIDR":      identity(host, ProfileEgress{Mode: EgressAllowlist, Presets: []string{"github"}, CIDRs: []string{"1.2.3.4"}}, ""),
		"a cache service":    identity(host, allowlist(), "https://cache.internal"),
		"a host override":    identity(otherHost, allowlist(), ""),
		"a different subnet": identity(Policy{Name: "runner-center", Subnet: "10.242.0.0/16", EgressMode: EgressPublic, Nameservers: host.Nameservers, MTU: host.MTU}, allowlist(), ""),
	}
	seen := map[string]string{base: "base"}
	for name, hash := range changed {
		if previous, ok := seen[hash]; ok {
			t.Fatalf("%s reuses the identity of %s", name, previous)
		}
		seen[hash] = name
	}
}

func TestNftablesRendersTheProfileEgressRulesOnEveryHost(t *testing.T) {
	ruleset, err := DefaultPolicy("runner-center").Nftables()
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	for _, required := range []string{
		"set rc_observed", "set rc_restricted",
		"set rc_allow_cidr {\n\t\ttype ipv4_addr . ipv4_addr\n\t\tflags interval",
		"set rc_allow_dns {\n\t\ttype ipv4_addr . ipv4_addr\n\t\tflags timeout",
		"set rc_flows {\n\t\ttype ipv4_addr . ipv4_addr . inet_proto . inet_service\n\t\tflags dynamic,timeout",
		"ip saddr @rc_observed ct state new meta l4proto { tcp, udp } add @rc_flows { ip saddr . ip daddr . meta l4proto . th dport }",
		"ip saddr @rc_restricted jump restricted",
		"ct state established,related return",
		"meta l4proto { tcp, udp } ip saddr . ip daddr @rc_allow_dns return",
		"add @rc_blocked",
		"type nat hook prerouting priority dstnat; policy accept;",
		"ip saddr @rc_observed meta l4proto { tcp, udp } th dport 53 redirect to :10053",
		"ip saddr @rc_observed meta l4proto { tcp, udp } th dport 10053 accept",
	} {
		if !strings.Contains(ruleset, required) {
			t.Errorf("ruleset is missing %q", required)
		}
	}
	// Order is the policy: the Profile jump must come before the host accept,
	// or an operator exception would bypass a Profile allowlist, and the
	// resolver accept must come before the host-input drop.
	ordered := func(first, second string) {
		t.Helper()
		if strings.Index(ruleset, first) > strings.Index(ruleset, second) {
			t.Errorf("%q must precede %q", first, second)
		}
	}
	ordered(RuleDenyEastWest, RuleRestrictProfile)
	ordered(RuleRestrictProfile, RuleAllowDestinations)
	ordered(RuleAllowResolver, RuleDenyHostInput)
	ordered(RuleRestrictedAllowDNS, RuleRestrictedDeny)
	if strings.Contains(ruleset, "policy drop") {
		t.Fatal("no chain may carry a drop policy on a shared host")
	}
}

func TestVerifyNftablesRequiresTheProfileEgressMachinery(t *testing.T) {
	policy := DefaultPolicy("runner-center")
	good := liveTable(t, policy.ExpectedRules(), []string{policy.Subnet}, nil)
	if err := policy.VerifyNftables(good); err != nil {
		t.Fatalf("a correct host must verify: %v", err)
	}
	mutate := func(t *testing.T, change func([]any) []any) []byte {
		t.Helper()
		var document map[string]any
		if err := json.Unmarshal(good, &document); err != nil {
			t.Fatalf("decode: %v", err)
		}
		document["nftables"] = change(document["nftables"].([]any))
		encoded, err := json.Marshal(document)
		if err != nil {
			t.Fatalf("encode: %v", err)
		}
		return encoded
	}
	t.Run("a missing per-guest set", func(t *testing.T) {
		live := mutate(t, func(entries []any) []any {
			return slices.DeleteFunc(entries, func(entry any) bool {
				set, ok := entry.(map[string]any)["set"].(map[string]any)
				return ok && set["name"] == AllowDNSSetName
			})
		})
		if err := policy.VerifyNftables(live); err == nil || !strings.Contains(err.Error(), AllowDNSSetName) {
			t.Fatalf("a missing resolver set must fail readiness, got %v", err)
		}
	})
	t.Run("a removed DNS redirect", func(t *testing.T) {
		chains := policy.ExpectedRules()
		chains["prerouting"] = nil
		if err := policy.VerifyNftables(liveTable(t, chains, []string{policy.Subnet}, nil)); err == nil {
			t.Fatal("a restricted guest able to pick its own resolver must fail readiness")
		}
	})
	t.Run("a restricted chain that no longer drops", func(t *testing.T) {
		chains := policy.ExpectedRules()
		chains[RestrictedChain] = chains[RestrictedChain][:4]
		if err := policy.VerifyNftables(liveTable(t, chains, []string{policy.Subnet}, nil)); err == nil {
			t.Fatal("a restricted chain without its drop must fail readiness")
		}
	})
	t.Run("a chain EraInfra did not install", func(t *testing.T) {
		live := mutate(t, func(entries []any) []any {
			return append(entries, map[string]any{"chain": map[string]any{
				"family": "inet", "table": TableName, "name": "output",
				"type": "nat", "hook": "output", "policy": "accept",
			}})
		})
		if err := policy.VerifyNftables(live); err == nil || !strings.Contains(err.Error(), "output") {
			t.Fatalf("an unmanaged chain must fail readiness, got %v", err)
		}
	})
	t.Run("a re-hooked redirect chain", func(t *testing.T) {
		live := mutate(t, func(entries []any) []any {
			for _, entry := range entries {
				if chain, ok := entry.(map[string]any)["chain"].(map[string]any); ok && chain["name"] == "prerouting" {
					chain["type"] = "filter"
				}
			}
			return entries
		})
		if err := policy.VerifyNftables(live); err == nil {
			t.Fatal("a prerouting chain that is not nat cannot redirect DNS and must fail readiness")
		}
	})
}

func TestRegistrationBatchWritesOnlyWhatTheGuestNeeds(t *testing.T) {
	host := DefaultPolicy("runner-center")
	guest := netip.MustParseAddr("10.241.0.7")

	public, err := Effective(host, ProfileEgress{}, "")
	if err != nil {
		t.Fatalf("effective: %v", err)
	}
	batch, state, err := RegistrationBatch(guest, public)
	if err != nil || batch != "" || state.Observed || state.Restricted {
		t.Fatalf("a public guest needs no per-guest state, got %q %+v %v", batch, state, err)
	}

	audit, _ := Effective(host, ProfileEgress{Mode: EgressAudit}, "")
	batch, _, err = RegistrationBatch(guest, audit)
	if err != nil || batch != "add element inet runner-center rc_observed { 10.241.0.7 }\n" {
		t.Fatalf("audit batch = %q, %v", batch, err)
	}

	restricted, _ := Effective(host, ProfileEgress{
		Mode: EgressAllowlist, Presets: []string{"github"}, CIDRs: []string{"140.82.112.0/20", "140.82.113.0/24"},
	}, "")
	batch, state, err = RegistrationBatch(guest, restricted)
	if err != nil {
		t.Fatalf("registration: %v", err)
	}
	want := "add element inet runner-center rc_allow_cidr { 10.241.0.7 . 140.82.112.0/20 }\n" +
		"add element inet runner-center rc_restricted { 10.241.0.7 }\n" +
		"add element inet runner-center rc_observed { 10.241.0.7 }\n"
	if batch != want {
		t.Fatalf("allowlist batch =\n%s\nwant\n%s", batch, want)
	}
	if len(state.CIDRs) != 1 {
		t.Fatalf("a covered CIDR must collapse into its parent, got %v", state.CIDRs)
	}
}

func TestResolvedBatchRefreshesTheTimeoutAtomically(t *testing.T) {
	guest := netip.MustParseAddr("10.241.0.7")
	batch := ResolvedBatch(guest, []netip.Addr{
		netip.MustParseAddr("140.82.112.3"), netip.MustParseAddr("140.82.112.4"),
	}, 90*time.Second)
	want := "add element inet runner-center rc_allow_dns { 10.241.0.7 . 140.82.112.3 timeout 90s, 10.241.0.7 . 140.82.112.4 timeout 90s }\n" +
		"delete element inet runner-center rc_allow_dns { 10.241.0.7 . 140.82.112.3, 10.241.0.7 . 140.82.112.4 }\n" +
		"add element inet runner-center rc_allow_dns { 10.241.0.7 . 140.82.112.3 timeout 90s, 10.241.0.7 . 140.82.112.4 timeout 90s }\n"
	if batch != want {
		t.Fatalf("batch =\n%s\nwant\n%s", batch, want)
	}
	if ResolvedBatch(guest, nil, time.Minute) != "" {
		t.Fatal("no addresses means no batch")
	}
	if !strings.Contains(ResolvedBatch(guest, []netip.Addr{netip.MustParseAddr("1.1.1.1")}, 0), "timeout 1s") {
		t.Fatal("a zero TTL must still produce a valid, minimal timeout")
	}
}

func TestRemovalBatchTakesMembershipAwayFirstAndIsIdempotent(t *testing.T) {
	guest := netip.MustParseAddr("10.241.0.7")
	state := GuestEgressState{
		Guest: guest, Observed: true, Restricted: true,
		CIDRs:    []netip.Prefix{netip.MustParsePrefix("140.82.112.0/20")},
		Resolved: []netip.Addr{netip.MustParseAddr("1.2.3.4")},
		Flows:    []Flow{{Guest: guest, Destination: netip.MustParseAddr("1.2.3.4"), Protocol: "tcp", Port: 443}},
		Blocked:  []Flow{{Guest: guest, Destination: netip.MustParseAddr("5.6.7.8"), Protocol: "udp", Port: 123}},
	}
	batch := RemovalBatch(state)
	lines := strings.Split(strings.TrimSpace(batch), "\n")
	if len(lines) != 12 {
		t.Fatalf("expected an add and a delete for each of six sets, got\n%s", batch)
	}
	if !strings.Contains(lines[0], RestrictedSetName) && !strings.Contains(lines[0], ObservedSetName) {
		t.Fatalf("membership must be removed first, got %q", lines[0])
	}
	for index := 0; index < len(lines); index += 2 {
		add, remove := lines[index], lines[index+1]
		if !strings.HasPrefix(add, "add element") || !strings.HasPrefix(remove, "delete element") ||
			strings.TrimPrefix(add, "add") != strings.TrimPrefix(remove, "delete") {
			t.Fatalf("every delete must be preceded by the same add, got %q then %q", add, remove)
		}
	}
	for _, want := range []string{
		"rc_flows { 10.241.0.7 . 1.2.3.4 . tcp . 443 }",
		"rc_blocked { 10.241.0.7 . 5.6.7.8 . udp . 123 }",
		"rc_allow_cidr { 10.241.0.7 . 140.82.112.0/20 }",
	} {
		if !strings.Contains(batch, want) {
			t.Fatalf("removal batch is missing %q:\n%s", want, batch)
		}
	}
}

func TestCollapsePrefixesDropsCoveredRanges(t *testing.T) {
	got := CollapsePrefixes([]netip.Prefix{
		netip.MustParsePrefix("10.1.0.0/16"),
		netip.MustParsePrefix("10.0.0.0/8"),
		netip.MustParsePrefix("192.0.2.0/24"),
		netip.MustParsePrefix("192.0.2.0/24"),
		netip.MustParsePrefix("1.2.3.4/32"),
	})
	want := []string{"1.2.3.4/32", "10.0.0.0/8", "192.0.2.0/24"}
	var gotText []string
	for _, prefix := range got {
		gotText = append(gotText, prefix.String())
	}
	if !slices.Equal(gotText, want) {
		t.Fatalf("collapsed = %v, want %v", gotText, want)
	}
}

func TestParseFlowSetReadsBothElementShapesAndOnlyThisGuest(t *testing.T) {
	listing := []byte(`{"nftables":[{"metainfo":{"version":"1.0.9"}},{"set":{"family":"inet","name":"rc_flows","table":"runner-center",
		"type":["ipv4_addr","ipv4_addr","inet_proto","inet_service"],"flags":["timeout","dynamic"],"elem":[
		{"elem":{"val":{"concat":["10.241.0.7","140.82.112.3","tcp",443]},"timeout":25200,"expires":25000}},
		{"concat":["10.241.0.7","1.1.1.1",17,"53"]},
		{"concat":["10.241.0.8","9.9.9.9","tcp",443]},
		{"concat":["10.241.0.7","9.9.9.9","sctp",80]},
		{"unexpected":true}
	]}}]}`)
	flows, err := ParseFlowSet(listing, netip.MustParseAddr("10.241.0.7"))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	want := []Flow{
		{Guest: netip.MustParseAddr("10.241.0.7"), Destination: netip.MustParseAddr("140.82.112.3"), Protocol: "tcp", Port: 443},
		{Guest: netip.MustParseAddr("10.241.0.7"), Destination: netip.MustParseAddr("1.1.1.1"), Protocol: "udp", Port: 53},
	}
	if !slices.Equal(flows, want) {
		t.Fatalf("flows = %+v, want %+v", flows, want)
	}
	if _, err := ParseFlowSet([]byte("not json"), netip.MustParseAddr("10.241.0.7")); err == nil {
		t.Fatal("an undecodable listing must be an error, not an empty record")
	}
}

func TestResolverAddressIsTheGuestGateway(t *testing.T) {
	address, err := DefaultPolicy("runner-center").ResolverAddress()
	if err != nil || address.String() != "10.241.0.1" {
		t.Fatalf("resolver address = %v, %v; want 10.241.0.1", address, err)
	}
}

func TestHostPolicyAcceptsAuditMode(t *testing.T) {
	policy := DefaultPolicy("runner-center")
	policy.EgressMode = EgressAudit
	if err := policy.Validate(); err != nil {
		t.Fatalf("audit must be a valid host override: %v", err)
	}
	if policy.IdentityHash() == DefaultPolicy("runner-center").IdentityHash() {
		t.Fatal("an audit host must not share the public host's identity")
	}
}

// The fixtures are `nft --json list table inet runner-center` from nftables
// 1.0.9 (Ubuntu 24.04) on a real kernel, after loading the rendered table, and
// again after registering one allowlist guest and admitting two resolved
// addresses. Verify must accept both: per-guest elements are live state.
func TestVerifyNftablesAcceptsARealKernelListing(t *testing.T) {
	policy := DefaultPolicy("runner-center")
	for _, fixture := range []string{"testdata/nft-1.0.9-live-table.json", "testdata/nft-1.0.9-live-table-with-guest.json"} {
		live, err := os.ReadFile(fixture)
		if err != nil {
			t.Fatalf("read %s: %v", fixture, err)
		}
		if err := policy.VerifyNftables(live); err != nil {
			t.Fatalf("%s must verify: %v", fixture, err)
		}
	}
}

// The control plane validates the same policies in TypeScript. Both suites
// read this file, so a rule changed on one side alone turns one of them red.
func TestProfileEgressMatchesTheControlPlanesCases(t *testing.T) {
	contents, err := os.ReadFile("../../../../testdata/egress-policy-cases.json")
	if err != nil {
		t.Fatalf("read shared cases: %v", err)
	}
	var cases struct {
		Valid []struct {
			Name       string          `json:"name"`
			Input      json.RawMessage `json:"input"`
			Normalized ProfileEgress   `json:"normalized"`
		} `json:"valid"`
		Invalid []struct {
			Name  string          `json:"name"`
			Input json.RawMessage `json:"input"`
		} `json:"invalid"`
	}
	if err := json.Unmarshal(contents, &cases); err != nil {
		t.Fatalf("decode shared cases: %v", err)
	}
	orEmpty := func(values []string) []string {
		if values == nil {
			return []string{}
		}
		return values
	}
	for _, testCase := range cases.Valid {
		var policy ProfileEgress
		if err := json.Unmarshal(testCase.Input, &policy); err != nil {
			t.Fatalf("%s: decode: %v", testCase.Name, err)
		}
		if err := policy.Validate(); err != nil {
			t.Errorf("%s: must be valid: %v", testCase.Name, err)
			continue
		}
		got, want := policy.Normalized(), testCase.Normalized
		if got.Mode != want.Mode || !slices.Equal(orEmpty(got.Presets), orEmpty(want.Presets)) ||
			!slices.Equal(orEmpty(got.Domains), orEmpty(want.Domains)) || !slices.Equal(orEmpty(got.CIDRs), orEmpty(want.CIDRs)) {
			t.Errorf("%s: normalized = %+v, want %+v", testCase.Name, got, want)
		}
	}
	for _, testCase := range cases.Invalid {
		var policy ProfileEgress
		if err := json.Unmarshal(testCase.Input, &policy); err != nil {
			continue
		}
		if err := policy.Validate(); err == nil {
			t.Errorf("%s: must be rejected", testCase.Name)
		}
	}
}
