package netpolicy

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestDefaultPolicyIsValid(t *testing.T) {
	if err := DefaultPolicy("runner-center").Validate(); err != nil {
		t.Fatalf("default policy must be valid: %v", err)
	}
}

func TestValidateRejectsUnsafePolicies(t *testing.T) {
	cases := map[string]func(Policy) Policy{
		"public subnet would make guest addresses routable": func(p Policy) Policy {
			p.Subnet = "8.8.0.0/16"
			return p
		},
		"a tiny subnet cannot address concurrent guests": func(p Policy) Policy {
			p.Subnet = "10.241.0.0/30"
			return p
		},
		"an allowed destination overlapping the guest subnet re-enables east-west": func(p Policy) Policy {
			p.AllowedDestinations = []string{"10.241.5.0/24"}
			return p
		},
		"a nameserver inside a denied range would be unreachable": func(p Policy) Policy {
			p.Nameservers = []string{"192.168.1.1"}
			return p
		},
		"an allowlist policy with an unlisted nameserver would be unreachable": func(p Policy) Policy {
			p.EgressMode = EgressAllowlist
			return p
		},
		"an unknown egress mode is not a policy": func(p Policy) Policy {
			p.EgressMode = "off"
			return p
		},
		"an empty network name has no conflist file": func(p Policy) Policy {
			p.Name = ""
			return p
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			if err := mutate(DefaultPolicy("runner-center")).Validate(); err == nil {
				t.Fatal("expected the policy to be rejected")
			}
		})
	}
}

func TestValidateAcceptsAnAllowlistedPrivateResolver(t *testing.T) {
	policy := DefaultPolicy("runner-center")
	policy.EgressMode = EgressAllowlist
	policy.Nameservers = []string{"192.168.50.10"}
	policy.AllowedDestinations = []string{"192.168.50.10/32"}
	if err := policy.Validate(); err != nil {
		t.Fatalf("an explicitly allowed resolver must be accepted: %v", err)
	}
}

func TestConflistUsesPointToPointLinksAndTapRedirection(t *testing.T) {
	rendered, err := DefaultPolicy("runner-center").Conflist()
	if err != nil {
		t.Fatalf("render conflist: %v", err)
	}
	var document struct {
		Name    string `json:"name"`
		Plugins []struct {
			Type   string `json:"type"`
			IPMasq bool   `json:"ipMasq"`
			IPAM   struct {
				Type   string `json:"type"`
				Subnet string `json:"subnet"`
			} `json:"ipam"`
		} `json:"plugins"`
	}
	if err := json.Unmarshal(rendered, &document); err != nil {
		t.Fatalf("decode conflist: %v", err)
	}
	if document.Name != "runner-center" {
		t.Fatalf("network name = %q, want runner-center", document.Name)
	}
	types := make([]string, 0, len(document.Plugins))
	for _, plugin := range document.Plugins {
		types = append(types, plugin.Type)
	}
	want := []string{"ptp", "firewall", "tc-redirect-tap"}
	if strings.Join(types, ",") != strings.Join(want, ",") {
		t.Fatalf("plugin chain = %v, want %v", types, want)
	}
	// A bridge would put every guest on one segment where east-west traffic
	// never reaches a routing hook and cannot be filtered.
	if document.Plugins[0].Type != "ptp" {
		t.Fatal("the first plugin must be ptp so guest traffic is routed, not switched")
	}
	if !document.Plugins[0].IPMasq {
		t.Fatal("ipMasq must be set or the guest has no egress at all")
	}
	if document.Plugins[0].IPAM.Type != "host-local" || document.Plugins[0].IPAM.Subnet != "10.241.0.0/16" {
		t.Fatalf("unexpected IPAM %+v", document.Plugins[0].IPAM)
	}
}

func TestConflistFileNameMatchesTheSDKConvention(t *testing.T) {
	if name := DefaultPolicy("runner-center").ConflistFileName(); name != "10-runner-center.conflist" {
		t.Fatalf("conflist file name = %q", name)
	}
}

func TestVerifyConflistAcceptsWhatItRenders(t *testing.T) {
	policy := DefaultPolicy("runner-center")
	rendered, err := policy.Conflist()
	if err != nil {
		t.Fatalf("render conflist: %v", err)
	}
	if err := policy.VerifyConflist(rendered); err != nil {
		t.Fatalf("a freshly rendered conflist must verify: %v", err)
	}
}

func TestVerifyConflistRejectsATamperedChain(t *testing.T) {
	policy := DefaultPolicy("runner-center")
	tampered := []byte(`{
	  "cniVersion": "1.0.0",
	  "name": "runner-center",
	  "plugins": [
	    {"type": "bridge", "bridge": "rc0", "isGateway": true, "ipMasq": true,
	     "ipam": {"type": "host-local", "subnet": "10.241.0.0/16"}},
	    {"type": "tc-redirect-tap"}
	  ]
	}`)
	err := policy.VerifyConflist(tampered)
	if err == nil {
		t.Fatal("a bridged chain without the firewall plugin must be rejected")
	}
	if !strings.Contains(err.Error(), "plugins") {
		t.Fatalf("the error should name the differing key, got %v", err)
	}
}

func TestNftablesRendersEveryRequiredRule(t *testing.T) {
	ruleset, err := DefaultPolicy("runner-center").Nftables()
	if err != nil {
		t.Fatalf("render nftables: %v", err)
	}
	for _, required := range []string{
		RuleDenyEastWest,
		RuleAllowDestinations,
		RuleDenyPrivate,
		RuleDenyHostInput,
		"10.0.0.0/8",
		"172.16.0.0/12",
		"192.168.0.0/16",
		"169.254.0.0/16",
	} {
		if !strings.Contains(ruleset, required) {
			t.Fatalf("rendered ruleset is missing %q", required)
		}
	}
	// A drop policy on a shared host would break unrelated forwarding, so the
	// isolation must come from scoped drop verdicts instead.
	if strings.Contains(ruleset, "policy drop") {
		t.Fatal("the table must not install a drop policy on a shared host")
	}
	if !strings.Contains(ruleset, "delete table inet runner-center") {
		t.Fatal("the ruleset must replace its own table atomically to stay idempotent")
	}
}

func TestPublicEgressHasNoDefaultDenyButAllowlistDoes(t *testing.T) {
	public, err := DefaultPolicy("runner-center").Nftables()
	if err != nil {
		t.Fatalf("render public policy: %v", err)
	}
	if strings.Contains(public, RuleDenyDefault) {
		t.Fatal("public egress must not install a default deny")
	}

	locked := DefaultPolicy("runner-center")
	locked.EgressMode = EgressAllowlist
	locked.Nameservers = []string{"1.1.1.1"}
	locked.AllowedDestinations = []string{"1.1.1.1/32", "140.82.112.0/20"}
	ruleset, err := locked.Nftables()
	if err != nil {
		t.Fatalf("render allowlist policy: %v", err)
	}
	if !strings.Contains(ruleset, RuleDenyDefault) {
		t.Fatal("allowlist egress must install a default deny")
	}
	if !strings.Contains(ruleset, "140.82.112.0/20") {
		t.Fatal("allowlist egress must carry its allowed destinations")
	}
}

// liveTable models `nft --json list table inet runner-center` on a correctly
// provisioned host.
func liveTable(t *testing.T, chains map[string][]string, guests, allowed []string) []byte {
	t.Helper()
	entries := []any{
		map[string]any{"table": map[string]any{"family": "inet", "name": TableName}},
		map[string]any{"set": map[string]any{
			"family": "inet", "table": TableName, "name": GuestSetName,
			"elem": prefixElements(guests),
		}},
		map[string]any{"set": map[string]any{
			"family": "inet", "table": TableName, "name": AllowSetName,
			"elem": prefixElements(allowed),
		}},
	}
	for _, chain := range []string{"forward", "input"} {
		comments, ok := chains[chain]
		if !ok {
			continue
		}
		entries = append(entries, map[string]any{"chain": map[string]any{
			"family": "inet", "table": TableName, "name": chain,
			"type": "filter", "hook": chain, "policy": "accept",
		}})
		for _, comment := range comments {
			entries = append(entries, map[string]any{"rule": map[string]any{
				"family": "inet", "table": TableName, "chain": chain, "comment": comment,
			}})
		}
	}
	encoded, err := json.Marshal(map[string]any{"nftables": entries})
	if err != nil {
		t.Fatalf("encode live table: %v", err)
	}
	return encoded
}

func prefixElements(values []string) []any {
	elements := make([]any, 0, len(values))
	for _, value := range values {
		address, length, found := strings.Cut(value, "/")
		if !found {
			elements = append(elements, value)
			continue
		}
		bits := 0
		for _, digit := range length {
			bits = bits*10 + int(digit-'0')
		}
		elements = append(elements, map[string]any{
			"prefix": map[string]any{"addr": address, "len": float64(bits)},
		})
	}
	return elements
}

func TestVerifyNftablesAcceptsACorrectlyProvisionedHost(t *testing.T) {
	policy := DefaultPolicy("runner-center")
	live := liveTable(t, policy.ExpectedRules(), []string{policy.Subnet}, nil)
	if err := policy.VerifyNftables(live); err != nil {
		t.Fatalf("a correct host must verify: %v", err)
	}
}

func TestVerifyNftablesFailsClosed(t *testing.T) {
	policy := DefaultPolicy("runner-center")

	t.Run("missing table", func(t *testing.T) {
		if err := policy.VerifyNftables([]byte(`{"nftables":[]}`)); err == nil {
			t.Fatal("a host with no table must not be reported ready")
		}
	})

	t.Run("a removed east-west drop", func(t *testing.T) {
		chains := map[string][]string{
			"forward": {RuleAllowDestinations, RuleDenyPrivate},
			"input":   {RuleDenyHostInput},
		}
		err := policy.VerifyNftables(liveTable(t, chains, []string{policy.Subnet}, nil))
		if err == nil || !strings.Contains(err.Error(), "forward") {
			t.Fatalf("removing the east-west drop must fail readiness, got %v", err)
		}
	})

	t.Run("a removed host-input drop", func(t *testing.T) {
		chains := map[string][]string{"forward": policy.ExpectedRules()["forward"], "input": {}}
		if err := policy.VerifyNftables(liveTable(t, chains, []string{policy.Subnet}, nil)); err == nil {
			t.Fatal("a guest able to reach host services must fail readiness")
		}
	})

	t.Run("an unmanaged rule", func(t *testing.T) {
		live := liveTable(t, policy.ExpectedRules(), []string{policy.Subnet}, nil)
		var document map[string]any
		if err := json.Unmarshal(live, &document); err != nil {
			t.Fatalf("decode: %v", err)
		}
		entries := document["nftables"].([]any)
		entries = append(entries, map[string]any{"rule": map[string]any{
			"family": "inet", "table": TableName, "chain": "forward",
		}})
		document["nftables"] = entries
		tampered, err := json.Marshal(document)
		if err != nil {
			t.Fatalf("encode: %v", err)
		}
		if err := policy.VerifyNftables(tampered); err == nil {
			t.Fatal("a rule Runner Center did not install must fail readiness")
		}
	})

	t.Run("a widened guest set", func(t *testing.T) {
		live := liveTable(t, policy.ExpectedRules(), []string{"10.0.0.0/8"}, nil)
		if err := policy.VerifyNftables(live); err == nil {
			t.Fatal("a guest set that does not match the Profile subnet must fail readiness")
		}
	})

	t.Run("an unexpected egress exception", func(t *testing.T) {
		live := liveTable(t, policy.ExpectedRules(), []string{policy.Subnet}, []string{"192.168.0.0/16"})
		err := policy.VerifyNftables(live)
		if err == nil || !strings.Contains(err.Error(), AllowSetName) {
			t.Fatalf("an exception the Profile never declared must fail readiness, got %v", err)
		}
	})
}

func TestVerifyNftablesToleratesSetElementOrder(t *testing.T) {
	policy := DefaultPolicy("runner-center")
	policy.AllowedDestinations = []string{"203.0.113.0/24", "198.51.100.0/24"}
	live := liveTable(
		t,
		policy.ExpectedRules(),
		[]string{policy.Subnet},
		[]string{"198.51.100.0/24", "203.0.113.0/24"},
	)
	if err := policy.VerifyNftables(live); err != nil {
		t.Fatalf("set element order must not matter: %v", err)
	}
}

func TestVerifyKernelArgsRequiresIPv6Disabled(t *testing.T) {
	if err := VerifyKernelArgs("console=ttyS0 ipv6.disable=1 rw"); err != nil {
		t.Fatalf("complete kernel arguments must pass: %v", err)
	}
	err := VerifyKernelArgs("console=ttyS0 rw")
	if err == nil {
		t.Fatal("a guest with IPv6 enabled bypasses the IPv4 policy and must fail readiness")
	}
	if !strings.Contains(err.Error(), "ipv6.disable=1") {
		t.Fatalf("the error must name the missing argument, got %v", err)
	}
}

func TestRequiredPluginsCoverTheRenderedChain(t *testing.T) {
	rendered, err := DefaultPolicy("runner-center").Conflist()
	if err != nil {
		t.Fatalf("render conflist: %v", err)
	}
	for _, plugin := range RequiredPlugins() {
		if !strings.Contains(string(rendered), `"`+plugin+`"`) {
			t.Fatalf("Preflight checks for %q but the chain never runs it", plugin)
		}
	}
}
