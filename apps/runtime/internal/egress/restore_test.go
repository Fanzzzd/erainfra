package egress

import (
	"context"
	"errors"
	"net/netip"
	"strings"
	"testing"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/netpolicy"
)

// Registered names only guests whose elements were in the kernel for the whole
// read. A guest torn down or registered while the table is listed could be on
// either side of the listing, and must not be reported as stripped by a reload.
func TestRegisteredExcludesGuestsThatChangeDuringTheRead(t *testing.T) {
	guard, _, _ := setup(t, githubAllowlist)
	second := netip.MustParseAddr("10.241.0.8")
	public := netpolicy.EffectiveEgress{Mode: netpolicy.EgressPublic}

	registered, live, err := guard.Registered(func() ([]byte, error) { return []byte("listing"), nil })
	if err != nil || string(live) != "listing" || len(registered) != 1 || registered[0].Guest != guestAddress ||
		registered[0].Link != guestLink || !registered[0].Restricted {
		t.Fatalf("a guest registered before and after the read is reported with its state, got %+v %v", registered, err)
	}

	registered, _, err = guard.Registered(func() ([]byte, error) {
		if err := guard.Register(context.Background(), second, "veth00000002", "vm-2", public); err != nil {
			return nil, err
		}
		if _, err := guard.Unregister(context.Background(), guestAddress, "vm-1"); err != nil {
			return nil, err
		}
		return []byte("listing"), nil
	})
	if err != nil || len(registered) != 0 {
		t.Fatalf("guests that came or went during the read must be left out, got %+v %v", registered, err)
	}

	if _, _, err := guard.Registered(func() ([]byte, error) { return nil, errors.New("nft: not found") }); err == nil {
		t.Fatal("a failed read must be returned")
	}
}

func TestRestoreWritesBackOnlyGuestsStillRunning(t *testing.T) {
	guard, kernel, _ := setup(t, githubAllowlist)
	registered, _, err := guard.Registered(func() ([]byte, error) { return nil, nil })
	if err != nil || len(registered) != 1 {
		t.Fatalf("fixture: %+v %v", registered, err)
	}

	kernel.reset()
	restored, err := guard.Restore(context.Background(), registered)
	if err != nil || len(restored) != 1 {
		t.Fatalf("a running guest must be restored, got %+v %v", restored, err)
	}
	batch := kernel.all()
	if batch != netpolicy.RestoreBatch(registered[0]) {
		t.Fatalf("restore must write the guest's registration, got:\n%s", batch)
	}

	// A failure is returned and the guest is not counted.
	kernel.reset()
	kernel.failNext = errors.New("nft: busy")
	if restored, err := guard.Restore(context.Background(), registered); err == nil || len(restored) != 0 ||
		!strings.Contains(err.Error(), guestAddress.String()) {
		t.Fatalf("a failed restore must name the guest, got %+v %v", restored, err)
	}

	// A guest at the same address on another link is a different guest: its
	// own registration already wrote its elements.
	moved := registered[0]
	moved.Link = "veth00000002"
	kernel.reset()
	if restored, err := guard.Restore(context.Background(), []netpolicy.GuestEgressState{moved}); err != nil || len(restored) != 0 || kernel.all() != "" {
		t.Fatalf("a guest that is no longer the one listed must be left alone, got %+v %v %q", restored, err, kernel.all())
	}

	// Torn down: nothing to put back, and writing it would undo the teardown.
	if _, err := guard.Unregister(context.Background(), guestAddress, "vm-1"); err != nil {
		t.Fatal(err)
	}
	kernel.reset()
	if restored, err := guard.Restore(context.Background(), registered); err != nil || len(restored) != 0 || kernel.all() != "" {
		t.Fatalf("a torn-down guest must not be restored, got %+v %v %q", restored, err, kernel.all())
	}
}
