package firecracker

import (
	"slices"
	"testing"
)

func TestReserveUsedCreditsAtMostOneReservePerGuest(t *testing.T) {
	const reserve = int64(8 * 1024)
	const mib = int64(1 << 20)
	written := []int64{
		2 * 1024 * mib,     // part of its reserve
		20 * 1024 * mib,    // past its reserve: the rest is not another guest's room
		-mib,               // a guest that discarded more than it wrote: nothing
		512*1024 + mib - 1, // under 2 MiB rounds down to 1 MiB, never up
		0,                  // a guest that has written nothing yet
	}
	if got, want := reserveUsedMiB(written, reserve), 2*1024+reserve+1; got != want {
		t.Fatalf("reserveUsedMiB = %d MiB, want %d MiB", got, want)
	}
	if got := reserveUsedMiB(nil, reserve); got != 0 {
		t.Fatalf("reserveUsedMiB with no guests = %d MiB, want 0", got)
	}
}

func TestLiveRootsCreditsOnlyRootsLiveAcrossThePoolSample(t *testing.T) {
	var roots liveRoots
	roots.add("runner-center-a")
	roots.add("runner-center-b")
	before := roots.list()
	// b's guest ends between the usage read and the pool sample, so the pool may
	// already have its blocks back. c starts in between and was never measured.
	roots.remove("runner-center-b")
	roots.add("runner-center-c")
	got := roots.stillLive(before)
	if want := []string{"runner-center-a"}; !slices.Equal(got, want) {
		t.Fatalf("stillLive = %v, want %v", got, want)
	}
}
