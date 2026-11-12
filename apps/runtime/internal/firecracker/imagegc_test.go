//go:build linux

package firecracker

import (
	"slices"
	"strings"
	"testing"
	"time"
)

func release(digit string) string {
	return "ghcr.io/fanzzzd/runner-center-ubuntu-24.04-full@sha256:" + strings.Repeat(digit, 64)
}

// ubuntu0 on 2026-11-12: seven Image Releases, every Profile on the newest.
func ubuntu0Images() []storedImage {
	day := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	stored := []storedImage{}
	for index, digit := range []string{"1", "2", "3", "4", "5", "6", "7"} {
		stored = append(stored, storedImage{Name: release(digit), CreatedAt: day.AddDate(0, 0, index)})
	}
	return stored
}

func TestPruneKeepsTheCurrentAndThePreviousImageRelease(t *testing.T) {
	plan, err := planImagePrune(ubuntu0Images(), []string{release("7")})
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{release("6"), release("7")}; !slices.Equal(plan.Kept, want) {
		t.Fatalf("kept %q, want %q", plan.Kept, want)
	}
	if want := []string{release("1"), release("2"), release("3"), release("4"), release("5")}; !slices.Equal(plan.Deleted, want) {
		t.Fatalf("deleted %q, want %q", plan.Deleted, want)
	}
}

func TestPruneKeepsEveryCurrentImageReleaseAndOnePrevious(t *testing.T) {
	// A canary Profile ahead of the others: both are current, and the newest other one stays.
	plan, err := planImagePrune(ubuntu0Images(), []string{release("7"), release("4")})
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{release("4"), release("6"), release("7")}; !slices.Equal(plan.Kept, want) {
		t.Fatalf("kept %q, want %q", plan.Kept, want)
	}
	if len(plan.Deleted) != 4 {
		t.Fatalf("deleted %q, want the four others", plan.Deleted)
	}
}

func TestPruneDeletesNothingWithTwoImageReleases(t *testing.T) {
	plan, err := planImagePrune(ubuntu0Images()[5:], []string{release("7")})
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Deleted) != 0 || len(plan.Kept) != 2 {
		t.Fatalf("plan = %+v, want both kept", plan)
	}
}

func TestPruneRefusesWithoutAnImageReleaseToKeep(t *testing.T) {
	if _, err := planImagePrune(ubuntu0Images(), nil); err == nil {
		t.Fatal("planImagePrune with nothing to keep succeeded; it would delete every image")
	}
	if _, err := planImagePrune(ubuntu0Images(), []string{"ubuntu:latest"}); err == nil {
		t.Fatal("planImagePrune accepted a keep entry that is not an Image Release")
	}
}

func TestPruneBreaksCreationTiesByName(t *testing.T) {
	at := time.Date(2026, 11, 12, 0, 0, 0, 0, time.UTC)
	stored := []storedImage{{Name: release("b"), CreatedAt: at}, {Name: release("a"), CreatedAt: at}, {Name: release("c"), CreatedAt: at.Add(time.Hour)}}
	plan, err := planImagePrune(stored, []string{release("c")})
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{release("b")}; !slices.Equal(plan.Deleted, want) {
		t.Fatalf("deleted %q, want %q", plan.Deleted, want)
	}
}

func TestPruneKeepsTheMostRecentlyBootedReleaseOverANewerPull(t *testing.T) {
	// ubuntu0 on 2026-11-12: every Profile ran 7, a canary candidate (8) was
	// pulled later and booted only until 19:06, the other Profiles kept booting 7
	// until the repin to 9. The rollback slot belongs to 7.
	pulled := time.Date(2026, 11, 12, 0, 0, 0, 0, time.UTC)
	stored := []storedImage{
		{Name: release("7"), CreatedAt: pulled, LastUsed: pulled.Add(20 * time.Hour)},
		{Name: release("8"), CreatedAt: pulled.Add(18 * time.Hour), LastUsed: pulled.Add(19 * time.Hour)},
		{Name: release("9"), CreatedAt: pulled.Add(20 * time.Hour)},
	}
	plan, err := planImagePrune(stored, []string{release("9")})
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{release("7"), release("9")}; !slices.Equal(plan.Kept, want) {
		t.Fatalf("kept %q, want %q", plan.Kept, want)
	}
	if want := []string{release("8")}; !slices.Equal(plan.Deleted, want) {
		t.Fatalf("deleted %q, want %q", plan.Deleted, want)
	}
}

func TestPruneFallsBackToThePullTimeForAnImageNoVMBooted(t *testing.T) {
	pulled := time.Date(2026, 11, 12, 0, 0, 0, 0, time.UTC)
	stored := []storedImage{
		{Name: release("1"), CreatedAt: pulled, LastUsed: pulled.Add(time.Hour)},
		{Name: release("2"), CreatedAt: pulled.Add(2 * time.Hour)},
		{Name: release("3"), CreatedAt: pulled.Add(3 * time.Hour)},
	}
	plan, err := planImagePrune(stored, []string{release("3")})
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{release("1")}; !slices.Equal(plan.Deleted, want) {
		t.Fatalf("deleted %q, want %q", plan.Deleted, want)
	}
}
