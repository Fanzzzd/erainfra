package netpolicy

import (
	"encoding/json"
	"os"
	"testing"
)

func TestVerifierRejectsAcceptInsteadOfDrop(t *testing.T) {
	changed := mutateKernelFixture(t, "rule", RuleRestrictedDeny, func(rule map[string]any) {
		rule["expr"] = []any{map[string]any{"accept": nil}}
	})
	if err := DefaultPolicy("runner-center").VerifyNftables(changed); err == nil {
		t.Fatal("verifier accepts Profile default-deny replaced with unconditional accept while its comment stays unchanged")
	}
}

// Each mutation starts from captured kernel output, not verifier-generated
// expectations. Keeping the comment and rule order unchanged must not hide it.
func TestVerifierRejectsWeakenedEnforcement(t *testing.T) {
	tests := []struct {
		name, kind, target string
		change             func(map[string]any)
	}{
		{"dormant table", "table", TableName, func(v map[string]any) { v["flags"] = []any{"dormant"} }},
		{"unknown enforcement field", "chain", "forward", func(v map[string]any) { v["unknown-enforcement"] = true }},
		{"removed source match", "rule", RuleDenyEastWest, func(v map[string]any) { v["expr"] = v["expr"].([]any)[1:] }},
		{"reversed match operator", "rule", RuleDenyPrivate, func(v map[string]any) { expressionMatch(v, 0)["op"] = "!=" }},
		{"wrong guest set", "rule", RuleRestrictProfile, func(v map[string]any) { expressionMatch(v, 0)["right"] = "@rc_observed" }},
		{"wrong allow set", "rule", RuleRestrictedAllowDNS, func(v map[string]any) { expressionMatch(v, 1)["right"] = "@rc_allow_cidr" }},
		{"missing protocol limit", "rule", RuleRestrictedAllowCIDR, func(v map[string]any) { v["expr"] = v["expr"].([]any)[1:] }},
		{"accept bypasses host policy", "rule", RuleRestrictedAllowDNS, func(v map[string]any) { v["expr"].([]any)[2] = map[string]any{"accept": nil} }},
		{"wrong concatenation order", "rule", RuleRestrictedAllowCIDR, func(v map[string]any) {
			keys := expressionMatch(v, 1)["left"].(map[string]any)["concat"].([]any)
			keys[0], keys[1] = keys[1], keys[0]
		}},
		{"new flows treated as established", "rule", RuleRestrictedEstablished, func(v map[string]any) { expressionMatch(v, 0)["right"] = []any{"new", "established", "related"} }},
		{"wrong redirect port", "rule", RuleRedirectDNS, func(v map[string]any) {
			v["expr"].([]any)[3].(map[string]any)["redirect"].(map[string]any)["port"] = float64(53)
		}},
		{"wrong DNS match port", "rule", RuleRedirectDNS, func(v map[string]any) { expressionMatch(v, 2)["right"] = float64(5353) }},
		{"host service port opened", "rule", RuleAllowResolver, func(v map[string]any) { expressionMatch(v, 2)["right"] = float64(22) }},
		{"wrong blocked record set", "rule", RuleRecordBlocked, func(v map[string]any) {
			v["expr"].([]any)[1].(map[string]any)["set"].(map[string]any)["set"] = "@rc_flows"
		}},
		{"private prefix removed", "rule", RuleDenyPrivate, func(v map[string]any) {
			set := expressionMatch(v, 1)["right"].(map[string]any)
			set["set"] = set["set"].([]any)[1:]
		}},
		{"forward priority", "chain", "forward", func(v map[string]any) { v["prio"] = float64(10) }},
		{"redirect priority", "chain", "prerouting", func(v map[string]any) { v["prio"] = float64(0) }},
		{"missing priority", "chain", "input", func(v map[string]any) { delete(v, "prio") }},
		{"chain policy", "chain", "input", func(v map[string]any) { v["policy"] = "drop" }},
		{"wrong set type", "set", AllowDNSSetName, func(v map[string]any) { v["type"] = "ipv4_addr" }},
		{"wrong set flags", "set", AllowDNSSetName, func(v map[string]any) { v["flags"] = []any{"interval"} }},
		{"static membership timeout", "set", RestrictedSetName, func(v map[string]any) { v["flags"] = []any{"timeout"}; v["timeout"] = float64(1) }},
		{"flow record retention", "set", FlowSetName, func(v map[string]any) { v["timeout"] = float64(1) }},
		{"flow record capacity", "set", BlockedSetName, func(v map[string]any) { v["size"] = float64(1) }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			live := mutateKernelFixture(t, tt.kind, tt.target, tt.change)
			if err := DefaultPolicy("runner-center").VerifyNftables(live); err == nil {
				t.Fatal("changed enforcement must fail readiness")
			}
		})
	}
}

func expressionMatch(rule map[string]any, index int) map[string]any {
	return rule["expr"].([]any)[index].(map[string]any)["match"].(map[string]any)
}

func mutateKernelFixture(t *testing.T, kind, target string, change func(map[string]any)) []byte {
	t.Helper()
	body, err := os.ReadFile("testdata/nft-1.0.9-live-table.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := DefaultPolicy("runner-center").VerifyNftables(body); err != nil {
		t.Fatalf("unaltered kernel fixture: %v", err)
	}
	var document map[string][]map[string]any
	if err := json.Unmarshal(body, &document); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, entry := range document["nftables"] {
		value, ok := entry[kind].(map[string]any)
		if !ok {
			continue
		}
		key := "name"
		if kind == "rule" {
			key = "comment"
		}
		if value[key] == target {
			change(value)
			found = true
		}
	}
	if !found {
		t.Fatalf("fixture lacks %s %s", kind, target)
	}
	changed, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	return changed
}

func TestVerifierIgnoresOnlyNonPolicyDifferences(t *testing.T) {
	tests := []struct {
		name, kind, target string
		change             func(map[string]any)
	}{
		{"counter and handle", "rule", RuleRestrictedDeny, func(v map[string]any) {
			v["handle"] = float64(900)
			v["expr"] = append([]any{map[string]any{"counter": map[string]any{"packets": float64(42), "bytes": float64(1024)}}}, v["expr"].([]any)...)
		}},
		{"anonymous set order", "rule", RuleRedirectDNS, func(v map[string]any) { expressionMatch(v, 1)["right"] = map[string]any{"set": []any{"udp", "tcp"}} }},
		{"conntrack mask order", "rule", RuleRestrictedEstablished, func(v map[string]any) { expressionMatch(v, 0)["right"] = []any{"related", "established"} }},
		{"set flags order", "set", FlowSetName, func(v map[string]any) { v["flags"] = []any{"dynamic", "timeout"} }},
		{"unmerged multicast prefixes", "rule", RuleDenyPrivate, func(v map[string]any) {
			set := expressionMatch(v, 1)["right"].(map[string]any)
			members := set["set"].([]any)
			members = members[:len(members)-1]
			members = append(members, map[string]any{"prefix": map[string]any{"addr": "224.0.0.0", "len": float64(4)}}, map[string]any{"prefix": map[string]any{"addr": "240.0.0.0", "len": float64(4)}})
			set["set"] = members
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			live := mutateKernelFixture(t, tt.kind, tt.target, tt.change)
			if err := DefaultPolicy("runner-center").VerifyNftables(live); err != nil {
				t.Fatal(err)
			}
		})
	}
}
