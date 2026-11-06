package firecracker

import (
	"context"
	"errors"
	"net/netip"
	"os"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/egress"
	"github.com/Fanzzzd/erainfra/apps/runtime/internal/netpolicy"
)

// fixtureGuest is the guest the with-guest listing holds: an allowlist guest
// on veth1a2b3c4d with two allowed CIDRs.
var fixtureGuest = netpolicy.GuestEgressState{
	Guest:      netip.MustParseAddr("10.241.0.7"),
	Link:       "veth1a2b3c4d",
	Observed:   true,
	Restricted: true,
	CIDRs: []netip.Prefix{
		netip.MustParsePrefix("93.184.215.14/32"),
		netip.MustParsePrefix("140.82.112.0/20"),
	},
}

func readFixture(t *testing.T, name string) []byte {
	t.Helper()
	listing, err := os.ReadFile("../netpolicy/testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	return listing
}

// A guest is running on veth1a2b3c4d. Someone reloads the table
// (`nft -f nftables.rc.conf`, which starts with `delete table`), so every
// per-guest set is empty. The kernel's disable_ipv6 survives the reload, but
// the nft layer (IPv6 drop, spoof drop) and the guest's allowlist membership
// are gone, and readiness must say so.
func TestReloadedTableWithLiveGuestFailsReadiness(t *testing.T) {
	policy := netpolicy.DefaultPolicy("runner-center")
	reloaded := readFixture(t, "nft-1.0.9-live-table.json")
	withGuest := readFixture(t, "nft-1.0.9-live-table-with-guest.json")
	root := fakeProcSysNet(t, map[string]string{"veth1a2b3c4d": "1"})
	registered := []netpolicy.GuestEgressState{fixtureGuest}

	_, err := verifyNetworkState(policy, reloaded, root, registered)
	if err == nil || !strings.Contains(err.Error(), "10.241.0.7 on veth1a2b3c4d") {
		t.Fatalf("readiness must fail and name the running guest a reload unbound, got %v", err)
	}
	if _, err := verifyNetworkState(policy, withGuest, root, registered); err != nil {
		t.Fatalf("a running guest whose elements are all present must pass: %v", err)
	}
	// One allowed CIDR short is still a guest the table no longer describes.
	extra := fixtureGuest
	extra.CIDRs = append(slices.Clone(extra.CIDRs), netip.MustParsePrefix("1.1.1.0/24"))
	if _, err := verifyNetworkState(policy, withGuest, root, []netpolicy.GuestEgressState{extra}); err == nil {
		t.Fatal("a running guest missing one allowed CIDR must fail readiness")
	}
	// A registered link is checked for IPv6 whatever the table names.
	open := fakeProcSysNet(t, map[string]string{"veth1a2b3c4d": "0"})
	if _, err := verifyNetworkState(policy, withGuest, open, registered); err == nil {
		t.Fatal("a running guest whose link accepts IPv6 must fail readiness")
	}
}

// reloadingKernel is a table that lost its per-guest elements to a reload and
// gets them back when the runtime re-adds them.
type reloadingKernel struct {
	mu      sync.Mutex
	table   []byte
	full    []byte
	batches []string
	fail    error
}

func (k *reloadingKernel) Apply(_ context.Context, batch string) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.fail != nil {
		return k.fail
	}
	k.batches = append(k.batches, batch)
	if strings.Contains(batch, "add element inet runner-center rc_guest_links") {
		k.table = k.full
	}
	return nil
}

func (k *reloadingKernel) ListSet(context.Context, string) ([]byte, error) {
	return []byte(`{"nftables":[{"set":{"elem":[]}}]}`), nil
}

func (k *reloadingKernel) read() ([]byte, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.table, nil
}

func (k *reloadingKernel) reload(table []byte) {
	k.mu.Lock()
	defer k.mu.Unlock()
	k.table = table
	k.batches = nil
}

func (k *reloadingKernel) written() string {
	k.mu.Lock()
	defer k.mu.Unlock()
	return strings.Join(k.batches, "")
}

func registeredGuard(t *testing.T, kernel *reloadingKernel) *egress.Guard {
	t.Helper()
	host := netpolicy.DefaultPolicy("runner-center")
	effective, err := netpolicy.Effective(host, netpolicy.ProfileEgress{
		Mode: netpolicy.EgressAllowlist, CIDRs: []string{"93.184.215.14", "140.82.112.0/20"},
	})
	if err != nil {
		t.Fatal(err)
	}
	guard := egress.NewGuard(host, kernel)
	if err := guard.Register(context.Background(), fixtureGuest.Guest, fixtureGuest.Link, "vm-1", effective); err != nil {
		t.Fatal(err)
	}
	return guard
}

// The runtime owns the per-guest elements, so a reload under a running guest
// is repaired rather than only reported: Preflight writes the elements back,
// re-reads the table, and passes with the repair in its evidence.
func TestPreflightRestoresWhatAReloadTookFromARunningGuest(t *testing.T) {
	policy := netpolicy.DefaultPolicy("runner-center")
	root := fakeProcSysNet(t, map[string]string{"veth1a2b3c4d": "1"})
	full := readFixture(t, "nft-1.0.9-live-table-with-guest.json")
	kernel := &reloadingKernel{table: full, full: full}
	guard := registeredGuard(t, kernel)

	kernel.reload(readFixture(t, "nft-1.0.9-live-table.json"))
	detail, restored, err := verifyAndRestoreNetwork(context.Background(), policy, kernel.read, guard, root)
	if err != nil {
		t.Fatalf("a restorable reload must pass once restored: %v", err)
	}
	if len(restored) != 1 || restored[0].Guest != fixtureGuest.Guest || !strings.Contains(detail, "restored") {
		t.Fatalf("the evidence must say a guest was restored, got %q %+v", detail, restored)
	}
	batch := kernel.written()
	for _, want := range []string{
		`add element inet runner-center rc_guest_sources { "veth1a2b3c4d" . 10.241.0.7 }`,
		`add element inet runner-center rc_guest_links { "veth1a2b3c4d" }`,
		"add element inet runner-center rc_allow_cidr { 10.241.0.7 . 93.184.215.14/32, 10.241.0.7 . 140.82.112.0/20 }",
		"add element inet runner-center rc_restricted { 10.241.0.7 }",
		"add element inet runner-center rc_observed { 10.241.0.7 }",
	} {
		if !strings.Contains(batch, want) {
			t.Fatalf("restore must write back %q, wrote:\n%s", want, batch)
		}
	}
	if strings.Contains(batch, "delete") {
		t.Fatalf("restore must only add:\n%s", batch)
	}

	// The background loop runs the same restore.
	kernel.reload(readFixture(t, "nft-1.0.9-live-table.json"))
	if restored, _, _, err := restoreGuestElements(context.Background(), policy, kernel.read, guard); err != nil || len(restored) != 1 {
		t.Fatalf("the background restore must put the guest back, got %v %+v", err, restored)
	}

	// Intact: nothing is written.
	kernel.reload(full)
	if _, restored, err := verifyAndRestoreNetwork(context.Background(), policy, kernel.read, guard, root); err != nil ||
		len(restored) != 0 || kernel.written() != "" {
		t.Fatalf("an intact table must pass without writes, got %v %+v %q", err, restored, kernel.written())
	}

	// Torn down: an empty table is exactly right.
	if _, err := guard.Unregister(context.Background(), fixtureGuest.Guest, "vm-1"); err != nil {
		t.Fatal(err)
	}
	kernel.reload(readFixture(t, "nft-1.0.9-live-table.json"))
	if _, restored, err := verifyAndRestoreNetwork(context.Background(), policy, kernel.read, guard, root); err != nil ||
		len(restored) != 0 || kernel.written() != "" {
		t.Fatalf("no running guest and no guest elements must pass untouched, got %v %+v", err, restored)
	}
}

func TestPreflightFailsWhenARunningGuestCannotBeRestored(t *testing.T) {
	policy := netpolicy.DefaultPolicy("runner-center")
	root := fakeProcSysNet(t, map[string]string{"veth1a2b3c4d": "1"})
	full := readFixture(t, "nft-1.0.9-live-table-with-guest.json")
	kernel := &reloadingKernel{table: full, full: full}
	guard := registeredGuard(t, kernel)

	kernel.reload(readFixture(t, "nft-1.0.9-live-table.json"))
	kernel.fail = errors.New("Error: Could not process rule: No such file or directory")
	_, restored, err := verifyAndRestoreNetwork(context.Background(), policy, kernel.read, guard, root)
	if err == nil || !strings.Contains(err.Error(), "10.241.0.7 on veth1a2b3c4d") || !strings.Contains(err.Error(), "No such file") {
		t.Fatalf("readiness must fail, name the guest and say why the restore failed, got %v", err)
	}
	if len(restored) != 0 {
		t.Fatalf("nothing was restored, got %+v", restored)
	}
}

// A table that does not match the policy is not written into: readiness fails
// on the table itself.
func TestPreflightDoesNotRestoreIntoAForeignTable(t *testing.T) {
	policy := netpolicy.DefaultPolicy("runner-center")
	root := fakeProcSysNet(t, map[string]string{"veth1a2b3c4d": "1"})
	full := readFixture(t, "nft-1.0.9-live-table-with-guest.json")
	kernel := &reloadingKernel{table: full, full: full}
	guard := registeredGuard(t, kernel)

	kernel.reload([]byte(`{"nftables":[{"metainfo":{"version":"1.0.9"}}]}`))
	if _, _, err := verifyAndRestoreNetwork(context.Background(), policy, kernel.read, guard, root); err == nil ||
		!strings.Contains(err.Error(), "missing") {
		t.Fatalf("a missing table must fail readiness, got %v", err)
	}
	if kernel.written() != "" {
		t.Fatalf("nothing may be written into a table that is not ours:\n%s", kernel.written())
	}
}
