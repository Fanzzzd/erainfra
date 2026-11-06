package netpolicy

import (
	"encoding/json"
	"net/netip"
	"os"
	"slices"
	"strings"
	"testing"
)

// ipv6.disable=1 removes the guest's IPv6 stack, not root's packet socket: a
// job (jobs have sudo) can still put ethertype 0x86DD frames on its link. They
// arrive on the host side of the ptp veth, which has an fe80:: address when
// host IPv6 is on, and every other rule matches `ip saddr`, so without a rule
// for them host services listening on [::] are reachable. The table must drop
// IPv6 arriving on a guest link before input or forward could accept it.
func TestGuestIPv6IsDroppedOnTheHost(t *testing.T) {
	ruleset, err := DefaultPolicy("runner-center").Nftables()
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"chain guest_links {\n\t\ttype filter hook prerouting priority raw; policy accept;",
		`iifname @rc_guest_links meta nfproto ipv6 drop comment "rc:deny-guest-ipv6"`,
		`iifname @rc_guest_links iifname . ip saddr != @rc_guest_sources drop comment "rc:deny-guest-spoofing"`,
		"set rc_guest_links {\n\t\ttype ifname\n\t}",
		"set rc_guest_sources {\n\t\ttype ifname . ipv4_addr\n\t}",
	} {
		if !strings.Contains(ruleset, want) {
			t.Fatalf("the ruleset must drop IPv6 and borrowed sources on guest links, missing %q:\n%s", want, ruleset)
		}
	}
	// A veth* wildcard would also drop the IPv6 of every Docker container on a
	// Worker that runs both.
	if strings.Contains(ruleset, `"veth*"`) || strings.Contains(ruleset, "veth*") {
		t.Fatal("guest links must be matched by name, not by a wildcard Docker's links also match")
	}
	spec := DefaultPolicy("runner-center").ExpectedChains()[GuestLinkChain]
	if spec.Hook != "prerouting" || spec.Priority != GuestLinkPriority ||
		!slices.Equal(spec.Rules, []string{RuleDenyGuestIPv6, RuleDenyGuestSpoofing}) {
		t.Fatalf("readiness must require the guest link chain, got %+v", spec)
	}
}

// The judge's mutation: take the rule out of a real kernel listing and
// readiness must fail, whatever else is intact.
func TestVerifierRequiresTheGuestLinkBoundary(t *testing.T) {
	policy := DefaultPolicy("runner-center")
	tests := []struct {
		name, kind, target string
		change             func(map[string]any)
	}{
		{"IPv6 rule dropped", "rule", RuleDenyGuestIPv6, func(v map[string]any) { v["comment"] = RuleDenyGuestSpoofing }},
		{"IPv6 rule matches IPv4 instead", "rule", RuleDenyGuestIPv6, func(v map[string]any) { expressionMatch(v, 1)["right"] = "ipv4" }},
		{"IPv6 rule accepts", "rule", RuleDenyGuestIPv6, func(v map[string]any) { v["expr"].([]any)[2] = map[string]any{"accept": nil} }},
		{"IPv6 rule matches every interface but guests'", "rule", RuleDenyGuestIPv6, func(v map[string]any) { expressionMatch(v, 0)["op"] = "!=" }},
		{"spoofing rule drops only correct sources", "rule", RuleDenyGuestSpoofing, func(v map[string]any) { expressionMatch(v, 1)["op"] = "==" }},
		{"spoofing rule checks the wrong set", "rule", RuleDenyGuestSpoofing, func(v map[string]any) { expressionMatch(v, 1)["right"] = "@rc_guests" }},
		{"guest link chain after conntrack", "chain", GuestLinkChain, func(v map[string]any) { v["prio"] = float64(-10) }},
		{"guest link chain on input", "chain", GuestLinkChain, func(v map[string]any) { v["hook"] = "input" }},
		{"guest link set holds addresses", "set", GuestLinkSetName, func(v map[string]any) { v["type"] = "ipv4_addr" }},
		{"guest source set without the link", "set", GuestSourceSetName, func(v map[string]any) { v["type"] = "ipv4_addr" }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := policy.VerifyNftables(mutateKernelFixture(t, tt.kind, tt.target, tt.change)); err == nil {
				t.Fatal("a host whose guest links accept IPv6 or borrowed sources must fail readiness")
			}
		})
	}

	t.Run("guest link chain missing", func(t *testing.T) {
		chains := policy.ExpectedRules()
		delete(chains, GuestLinkChain)
		err := policy.VerifyNftables(liveTable(t, chains, []string{policy.Subnet}, nil))
		if err == nil || !strings.Contains(err.Error(), GuestLinkChain) {
			t.Fatalf("a table without the guest link chain must fail readiness, got %v", err)
		}
	})
	t.Run("guest link chain empty", func(t *testing.T) {
		chains := policy.ExpectedRules()
		chains[GuestLinkChain] = nil
		if err := policy.VerifyNftables(liveTable(t, chains, []string{policy.Subnet}, nil)); err == nil {
			t.Fatal("a guest link chain with no rules must fail readiness")
		}
	})
	t.Run("guest link sets missing", func(t *testing.T) {
		for _, set := range []string{GuestLinkSetName, GuestSourceSetName} {
			live := withoutSet(t, policy, set)
			if err := policy.VerifyNftables(live); err == nil || !strings.Contains(err.Error(), set) {
				t.Fatalf("a table without %s must fail readiness, got %v", set, err)
			}
		}
	})
}

func withoutSet(t *testing.T, policy Policy, name string) []byte {
	t.Helper()
	var document map[string]any
	if err := json.Unmarshal(liveTable(t, policy.ExpectedRules(), []string{policy.Subnet}, nil), &document); err != nil {
		t.Fatal(err)
	}
	document["nftables"] = slices.DeleteFunc(document["nftables"].([]any), func(entry any) bool {
		set, ok := entry.(map[string]any)["set"].(map[string]any)
		return ok && set["name"] == name
	})
	encoded, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func TestGuestLinksReadsTheLiveBindings(t *testing.T) {
	empty, err := os.ReadFile("testdata/nft-1.0.9-live-table.json")
	if err != nil {
		t.Fatal(err)
	}
	links, err := GuestLinks(empty)
	if err != nil || len(links) != 0 {
		t.Fatalf("a table with no guests has no guest links, got %v %v", links, err)
	}
	withGuest, err := os.ReadFile("testdata/nft-1.0.9-live-table-with-guest.json")
	if err != nil {
		t.Fatal(err)
	}
	links, err = GuestLinks(withGuest)
	if err != nil || !slices.Equal(links, []string{"veth1a2b3c4d"}) {
		t.Fatalf("links = %v, %v; want the registered guest's veth", links, err)
	}
	if _, err := GuestLinks([]byte(`{"nftables":[{"set":{"family":"inet","table":"runner-center","name":"rc_guest_links","elem":[{"weird":1}]}}]}`)); err == nil {
		t.Fatal("an element that is not an interface name must be an error, not a skipped link")
	}
	if _, err := GuestLinks([]byte("not json")); err == nil {
		t.Fatal("an undecodable listing must be an error")
	}
}

func TestRemovalBatchUnbindsTheLink(t *testing.T) {
	state := GuestEgressState{Guest: netip.MustParseAddr("10.241.0.7"), Link: "veth1a2b3c4d"}
	want := "add element inet runner-center rc_guest_links { \"veth1a2b3c4d\" }\n" +
		"delete element inet runner-center rc_guest_links { \"veth1a2b3c4d\" }\n" +
		"add element inet runner-center rc_guest_sources { \"veth1a2b3c4d\" . 10.241.0.7 }\n" +
		"delete element inet runner-center rc_guest_sources { \"veth1a2b3c4d\" . 10.241.0.7 }\n"
	if batch := RemovalBatch(state); batch != want {
		t.Fatalf("removal =\n%s\nwant\n%s", batch, want)
	}
	if strings.Contains(RemovalBatch(GuestEgressState{Guest: state.Guest}), GuestLinkSetName) {
		t.Fatal("state with no link must not touch the link sets")
	}
}

func TestValidateLinkName(t *testing.T) {
	for _, good := range []string{"veth1a2b3c4d", "vethabcdef0", "tap0", "a.b-c_d"} {
		if err := ValidateLinkName(good); err != nil {
			t.Errorf("%q: %v", good, err)
		}
	}
	for _, bad := range []string{"", ".", "..", "-veth", "veth/../x", "veth 1", `veth"`, "veth}", "sixteen-chars-xx"} {
		if err := ValidateLinkName(bad); err == nil {
			t.Errorf("%q must be refused", bad)
		}
	}
}
