//go:build linux

package firecracker

import "testing"

func TestFirecrackerWarmSlotClaimState(t *testing.T) {
	t.Run("claimed VM leaves result cleanup to the foreground waiter", func(t *testing.T) {
		slot := &firecrackerWarmSlot{}
		if err := slot.reserveClaim(); err != nil {
			t.Fatalf("reserve claim: %v", err)
		}
		if !slot.markExited() {
			t.Fatal("exit should observe the slot as claimed")
		}
		if err := slot.reserveClaim(); err == nil {
			t.Fatal("second claim unexpectedly succeeded")
		}
	})

	t.Run("exited parked VM cannot be claimed", func(t *testing.T) {
		slot := &firecrackerWarmSlot{}
		if slot.markExited() {
			t.Fatal("unclaimed slot reported itself as claimed")
		}
		if err := slot.reserveClaim(); err == nil {
			t.Fatal("claim after exit unexpectedly succeeded")
		}
	})
}
