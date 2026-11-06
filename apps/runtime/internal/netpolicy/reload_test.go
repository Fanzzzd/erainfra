package netpolicy

import (
	"net/netip"
	"os"
	"strings"
	"testing"
)

var listedGuest = GuestEgressState{
	Guest:      netip.MustParseAddr("10.241.0.7"),
	Link:       "veth1a2b3c4d",
	Observed:   true,
	Restricted: true,
	CIDRs: []netip.Prefix{
		netip.MustParsePrefix("93.184.215.14/32"),
		netip.MustParsePrefix("140.82.112.0/20"),
	},
}

// The listings are nft 1.0.9's own output: the with-guest one holds
// listedGuest, the other is the table straight after `nft -f`.
func TestMissingGuestElementsReadsTheKernelListing(t *testing.T) {
	withGuest, err := os.ReadFile("testdata/nft-1.0.9-live-table-with-guest.json")
	if err != nil {
		t.Fatal(err)
	}
	reloaded, err := os.ReadFile("testdata/nft-1.0.9-live-table.json")
	if err != nil {
		t.Fatal(err)
	}
	if missing, err := MissingGuestElements(withGuest, []GuestEgressState{listedGuest}); err != nil || len(missing) != 0 {
		t.Fatalf("every element is listed, including a /32 printed as a bare address: %v %+v", err, missing)
	}
	if missing, err := MissingGuestElements(reloaded, []GuestEgressState{listedGuest}); err != nil || len(missing) != 1 {
		t.Fatalf("a reloaded table holds none of the guest's elements: %v %+v", err, missing)
	}
	if missing, err := MissingGuestElements(reloaded, nil); err != nil || len(missing) != 0 {
		t.Fatalf("no registered guest, nothing missing: %v %+v", err, missing)
	}

	public := GuestEgressState{Guest: listedGuest.Guest, Link: listedGuest.Link}
	if missing, _ := MissingGuestElements(withGuest, []GuestEgressState{public}); len(missing) != 0 {
		t.Fatal("a public guest needs only its link binding")
	}
	for name, change := range map[string]func(*GuestEgressState){
		"another link":       func(s *GuestEgressState) { s.Link = "veth00000002" },
		"another address":    func(s *GuestEgressState) { s.Guest = netip.MustParseAddr("10.241.0.8") },
		"another CIDR":       func(s *GuestEgressState) { s.CIDRs = append(s.CIDRs, netip.MustParsePrefix("1.1.1.0/24")) },
		"a wider CIDR":       func(s *GuestEgressState) { s.CIDRs = []netip.Prefix{netip.MustParsePrefix("140.82.0.0/16")} },
		"a /32 as a /24":     func(s *GuestEgressState) { s.CIDRs = []netip.Prefix{netip.MustParsePrefix("93.184.215.0/24")} },
	} {
		state := listedGuest
		state.CIDRs = append([]netip.Prefix(nil), listedGuest.CIDRs...)
		change(&state)
		if missing, _ := MissingGuestElements(withGuest, []GuestEgressState{state}); len(missing) != 1 {
			t.Errorf("%s: the listing does not hold this guest's elements", name)
		}
	}
	if _, err := MissingGuestElements([]byte("not json"), []GuestEgressState{listedGuest}); err == nil {
		t.Fatal("an unreadable listing must be an error, not an empty table")
	}
}

// RestoreBatch is what registration wrote, and only adds: an `add element` of
// an element already there is a no-op, so it is safe on a partly intact table.
func TestRestoreBatchIsTheRegistration(t *testing.T) {
	effective, err := Effective(DefaultPolicy("runner-center"), ProfileEgress{
		Mode: EgressAllowlist, CIDRs: []string{"93.184.215.14", "140.82.112.0/20"},
	})
	if err != nil {
		t.Fatal(err)
	}
	registration, state, err := RegistrationBatch(listedGuest.Guest, listedGuest.Link, effective)
	if err != nil {
		t.Fatal(err)
	}
	restore := RestoreBatch(state)
	if restore != registration {
		t.Fatalf("restore must write what registration wrote:\n%s\nvs\n%s", restore, registration)
	}
	for _, line := range strings.Split(strings.TrimSpace(restore), "\n") {
		if !strings.HasPrefix(line, "add element inet runner-center ") {
			t.Fatalf("restore must only add elements, got %q", line)
		}
	}
}
