package firecracker

import (
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
)

// Verbatim from ubuntu0 on 2026-09-04 (#143): three masquerade jumps whose
// Attempts had ended two weeks earlier, next to one for the live guest.
var postroutingListing = []string{
	`-P POSTROUTING ACCEPT`,
	`-A POSTROUTING -s 10.241.0.61/32 -m comment --comment "name: \"runner-center\" id: \"mh7dxbnqnjmps282rb940kahpd8cvgrv\"" -j CNI-efb6b5605d4e75de23fb9a96`,
	`-A POSTROUTING -s 10.241.0.62/32 -m comment --comment "name: \"runner-center\" id: \"mh72pp5d1pr68tjdm68mbr7zx58ctnhk\"" -j CNI-bf2a237373fb8bcdebc1a725`,
	`-A POSTROUTING -s 172.17.0.5/32 -m comment --comment "name: \"other-net\" id: \"mh72pp5d1pr68tjdm68mbr7zx58ctnhk\"" -j CNI-000000000000000000000000`,
	`-A POSTROUTING -s 10.241.0.102/32 -m comment --comment "name: \"runner-center\" id: \"mh7dxav8fxshjad4yjkwf114js8ds1yg\"" -j CNI-46496be36767df01141081be`,
	`-A POSTROUTING -s 172.17.0.0/16 ! -o docker0 -j MASQUERADE`,
}

var forwardListing = []string{
	`-N CNI-FORWARD`,
	`-A CNI-FORWARD -m comment --comment "CNI firewall plugin admin overrides" -j CNI-ADMIN`,
	`-A CNI-FORWARD -d 10.241.0.61/32 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT`,
	`-A CNI-FORWARD -s 10.241.0.61/32 -j ACCEPT`,
	`-A CNI-FORWARD -d 10.241.0.102/32 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT`,
	`-A CNI-FORWARD -s 10.241.0.102/32 -j ACCEPT`,
}

func TestSplitRuleSpecKeepsTheCommentWhole(t *testing.T) {
	fields := splitRuleSpec(postroutingListing[1])
	want := []string{
		"-A", "POSTROUTING", "-s", "10.241.0.61/32", "-m", "comment", "--comment",
		`name: "runner-center" id: "mh7dxbnqnjmps282rb940kahpd8cvgrv"`,
		"-j", "CNI-efb6b5605d4e75de23fb9a96",
	}
	if !slices.Equal(fields, want) {
		t.Fatalf("tokenised as %q, want %q", fields, want)
	}
}

func TestParseNATRulesFindsOnlyThisNetworksGuests(t *testing.T) {
	rules := parseNATRules(postroutingListing, "runner-center")
	if len(rules) != 3 {
		t.Fatalf("want the 3 runner-center jumps, not the policy line, docker's rule or another network's guest; got %+v", rules)
	}
	first := rules[0]
	if first.ContainerID != "mh7dxbnqnjmps282rb940kahpd8cvgrv" || first.IP != "10.241.0.61" || first.Chain != "CNI-efb6b5605d4e75de23fb9a96" {
		t.Fatalf("first rule misparsed: %+v", first)
	}
	// The spec is what `-D POSTROUTING` needs: the rule without its `-A
	// POSTROUTING` prefix, comment intact so iptables matches the same rule.
	if first.Spec[0] != "-s" || !slices.Contains(first.Spec, `name: "runner-center" id: "mh7dxbnqnjmps282rb940kahpd8cvgrv"`) {
		t.Fatalf("spec is not deletable as printed: %q", first.Spec)
	}
}

func TestParseForwardRulesSkipsTheAdminJump(t *testing.T) {
	rules := parseForwardRules(forwardListing)
	if len(rules) != 4 {
		t.Fatalf("want the 4 per-guest accepts, got %+v", rules)
	}
	var ips []string
	for _, rule := range rules {
		ips = append(ips, rule.IP)
	}
	if !slices.Equal(ips, []string{"10.241.0.61", "10.241.0.61", "10.241.0.102", "10.241.0.102"}) {
		t.Fatalf("addresses misparsed: %v", ips)
	}
}

func TestStrayGuestRulesKeepWhatALiveGuestOrReservationOwns(t *testing.T) {
	nat := parseNATRules(postroutingListing, "runner-center")
	forward := parseForwardRules(forwardListing)
	live := map[string]bool{"mh7dxav8fxshjad4yjkwf114js8ds1yg": true}
	// .62 has a reservation on disk but its forward rules are already gone;
	// .61 has neither. Nothing here says .102's rules are stale.
	strayNAT, strayForward := strayGuestRules(nat, forward, map[string]struct{}{"10.241.0.62": {}}, func(id string) bool { return live[id] })
	var ids []string
	for _, rule := range strayNAT {
		ids = append(ids, rule.ContainerID)
	}
	if !slices.Equal(ids, []string{"mh7dxbnqnjmps282rb940kahpd8cvgrv", "mh72pp5d1pr68tjdm68mbr7zx58ctnhk"}) {
		t.Fatalf("stray masquerade jumps: %v", ids)
	}
	var ips []string
	for _, rule := range strayForward {
		ips = append(ips, rule.IP)
	}
	if !slices.Equal(ips, []string{"10.241.0.61", "10.241.0.61"}) {
		t.Fatalf("stray forward rules: %v", ips)
	}
}

// fakeRules is an in-memory iptables holding the two chains the plugins use.
type fakeRules struct {
	chains map[string][]string // "table/chain" -> -S listing
	calls  []string
	refuse string
}

func newFakeRules() *fakeRules {
	chains := map[string][]string{
		"nat/POSTROUTING":    slices.Clone(postroutingListing),
		"filter/CNI-FORWARD": slices.Clone(forwardListing),
	}
	for _, chain := range []string{"CNI-efb6b5605d4e75de23fb9a96", "CNI-bf2a237373fb8bcdebc1a725", "CNI-46496be36767df01141081be"} {
		chains["nat/"+chain] = []string{"-N " + chain, "-A " + chain + " -d 10.241.0.0/24 -j ACCEPT", "-A " + chain + " ! -d 224.0.0.0/4 -j MASQUERADE"}
	}
	return &fakeRules{chains: chains}
}

func (f *fakeRules) ChainExists(table, chain string) (bool, error) {
	_, ok := f.chains[table+"/"+chain]
	return ok, nil
}

func (f *fakeRules) List(table, chain string) ([]string, error) {
	lines, ok := f.chains[table+"/"+chain]
	if !ok {
		return nil, fmt.Errorf("iptables: No chain/target/match by that name")
	}
	return slices.Clone(lines), nil
}

func (f *fakeRules) Delete(table, chain string, rulespec ...string) error {
	key := table + "/" + chain
	line := "-A " + chain + " " + strings.Join(rulespec, " ")
	f.calls = append(f.calls, "delete "+key+" "+rulespec[1])
	if f.refuse != "" && strings.Contains(line, f.refuse) {
		return errors.New("iptables: Bad rule (does a matching rule exist in that chain?)")
	}
	for i, existing := range f.chains[key] {
		if slices.Equal(splitRuleSpec(existing)[2:], rulespec) {
			f.chains[key] = slices.Delete(f.chains[key], i, i+1)
			return nil
		}
	}
	return errors.New("iptables: Bad rule (does a matching rule exist in that chain?)")
}

func (f *fakeRules) ClearAndDeleteChain(table, chain string) error {
	f.calls = append(f.calls, "drop-chain "+table+"/"+chain)
	delete(f.chains, table+"/"+chain)
	return nil
}

func TestDeleteGuestRulesRemovesJumpChainAndAccepts(t *testing.T) {
	table := newFakeRules()
	nat, forward, err := listGuestRules(table, "runner-center")
	if err != nil {
		t.Fatal(err)
	}
	strayNAT, strayForward := strayGuestRules(nat, forward, nil, func(id string) bool {
		return id == "mh7dxav8fxshjad4yjkwf114js8ds1yg"
	})
	if err := deleteGuestRules(table, strayNAT, strayForward); err != nil {
		t.Fatal(err)
	}
	// The jump goes before its chain: iptables refuses to delete a chain that
	// is still referenced.
	want := []string{
		"delete nat/POSTROUTING 10.241.0.61/32",
		"drop-chain nat/CNI-efb6b5605d4e75de23fb9a96",
		"delete nat/POSTROUTING 10.241.0.62/32",
		"drop-chain nat/CNI-bf2a237373fb8bcdebc1a725",
		"delete filter/CNI-FORWARD 10.241.0.61/32",
		"delete filter/CNI-FORWARD 10.241.0.61/32",
	}
	if !slices.Equal(table.calls, want) {
		t.Fatalf("iptables calls:\n%s\nwant:\n%s", strings.Join(table.calls, "\n"), strings.Join(want, "\n"))
	}
	nat, forward, err = listGuestRules(table, "runner-center")
	if err != nil {
		t.Fatal(err)
	}
	if len(nat) != 1 || nat[0].IP != "10.241.0.102" || len(forward) != 2 {
		t.Fatalf("the live guest's rules must survive; left nat=%+v forward=%+v", nat, forward)
	}
	if _, ok := table.chains["nat/CNI-46496be36767df01141081be"]; !ok {
		t.Fatal("the live guest's masquerade chain was dropped")
	}
}

func TestDeleteGuestRulesKeepsGoingPastARefusal(t *testing.T) {
	table := newFakeRules()
	table.refuse = "10.241.0.61/32"
	nat, forward, _ := listGuestRules(table, "runner-center")
	strayNAT, strayForward := strayGuestRules(nat, forward, nil, func(string) bool { return false })
	err := deleteGuestRules(table, strayNAT, strayForward)
	if err == nil {
		t.Fatal("the refused deletes must be reported")
	}
	// A jump that could not be deleted keeps its chain: dropping the chain
	// under a live reference would fail anyway, and the error names the guest.
	if _, ok := table.chains["nat/CNI-efb6b5605d4e75de23fb9a96"]; !ok {
		t.Fatal("chain dropped although its jump survived")
	}
	if _, ok := table.chains["nat/CNI-bf2a237373fb8bcdebc1a725"]; ok {
		t.Fatal("the other stray was not reclaimed")
	}
	if !strings.Contains(err.Error(), "mh7dxbnqnjmps282rb940kahpd8cvgrv") {
		t.Fatalf("error does not name the guest: %v", err)
	}
}

func TestListGuestRulesOnAHostThatNeverRanAGuest(t *testing.T) {
	table := &fakeRules{chains: map[string][]string{"nat/POSTROUTING": {"-P POSTROUTING ACCEPT"}}}
	nat, forward, err := listGuestRules(table, "runner-center")
	if err != nil {
		t.Fatalf("a missing CNI-FORWARD chain is not an error: %v", err)
	}
	if len(nat) != 0 || len(forward) != 0 {
		t.Fatalf("nothing to find, got nat=%v forward=%v", nat, forward)
	}
}
