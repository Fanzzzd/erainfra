package objectstore

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/Fanzzzd/erainfra/apps/cache-service/internal/objectstore/fakes3"
)

// Eviction walks a whole repository a page at a time and reads last access
// from each object's LastModified, so both have to survive the real signer and
// the real XML.
func TestListAfterPagesAndCarriesModificationTime(t *testing.T) {
	fake := fakes3.New()
	defer fake.Close()
	at := time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC)
	fake.SetNow(func() time.Time { return at })
	store := newTestStore(t, fake, 0)
	ctx := context.Background()
	for i := 0; i < 5; i++ {
		if err := store.PutBytes(ctx, fmt.Sprintf("entries/o/r/%d", i), "", []byte("x")); err != nil {
			t.Fatal(err)
		}
	}

	var seen []string
	after := ""
	for {
		page, truncated, err := store.ListAfter(ctx, "entries/o/r/", after, 2)
		if err != nil {
			t.Fatal(err)
		}
		for _, object := range page {
			if !object.LastModified.Equal(at) {
				t.Errorf("%s LastModified = %s, want %s", object.Key, object.LastModified, at)
			}
			seen = append(seen, object.Key)
		}
		if !truncated {
			break
		}
		after = page[len(page)-1].Key
	}
	if len(seen) != 5 || seen[0] != "entries/o/r/0" || seen[4] != "entries/o/r/4" {
		t.Fatalf("paged listing = %v, want all five in order", seen)
	}
}

func TestStatAndDelete(t *testing.T) {
	fake := fakes3.New()
	defer fake.Close()
	store := newTestStore(t, fake, 0)
	ctx := context.Background()
	if err := store.PutBytes(ctx, "blobs/o/r/1", "", []byte("twelve bytes")); err != nil {
		t.Fatal(err)
	}
	object, err := store.Stat(ctx, "blobs/o/r/1")
	if err != nil || object.Size != 12 {
		t.Fatalf("Stat = %+v, %v; want 12 bytes", object, err)
	}
	if err := store.Delete(ctx, "blobs/o/r/1"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Stat(ctx, "blobs/o/r/1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Stat after Delete = %v, want ErrNotFound", err)
	}
	// Two replicas evicting the same entry both delete it; the second must
	// not fail.
	if err := store.Delete(ctx, "blobs/o/r/1"); err != nil {
		t.Fatalf("deleting a deleted object = %v, want success", err)
	}
}
