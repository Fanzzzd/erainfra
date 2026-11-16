package cacheindex

import (
	"context"
	"encoding/hex"
	"io"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Fanzzzd/erainfra/apps/cache-service/internal/objectstore"
	"github.com/Fanzzzd/erainfra/apps/cache-service/internal/objectstore/fakes3"
	"github.com/Fanzzzd/erainfra/internal/cachetoken"
)

func newTestIndex(t *testing.T) (*Index, *fakes3.Server, func(time.Time)) {
	t.Helper()
	store := fakes3.New()
	t.Cleanup(store.Close)

	backing, err := objectstore.NewS3(objectstore.S3Config{
		Endpoint: store.URL, Bucket: store.Bucket, AccessKey: store.AccessKey,
		Secret: store.Secret, Region: "us-east-1", PathStyle: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	// One clock for the index and the store. The store stamps LastModified,
	// which is what eviction reads last access from, so the two must agree.
	var mu sync.Mutex
	clock := time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC)
	now := func() time.Time {
		mu.Lock()
		defer mu.Unlock()
		return clock
	}
	store.SetNow(now)
	index := New(backing, slog.New(slog.NewTextHandler(io.Discard, nil)))
	index.Now = now
	return index, store, func(at time.Time) {
		mu.Lock()
		defer mu.Unlock()
		clock = at
	}
}

// The prefix match is delegated wholesale to the store's own prefix listing,
// which only works because hex is a byte-for-byte encoding: a prefix of the key
// is exactly a prefix of the encoded key, and never accidentally more.
func TestHexEncodingTurnsAKeyPrefixIntoAStorePrefix(t *testing.T) {
	for _, testCase := range []struct {
		whole  string
		asked  string
		prefix bool
	}{
		// Capture L068-L072: BuildKit writes index-D1-1-f921bd05#1 and asks for
		// index-D1-1-f921bd05.
		{"index-D1-1-f921bd05#1", "index-D1-1-f921bd05", true},
		{"index-D1-1-f921bd05#1", "index-D1-1-f921bd05#", true},
		{"index-D1-1-f921bd05#1", "index-D1-1-f921bd05#1", true},
		{"index-D1-1-f921bd05#1", "index-D1-2-f921bd05", false},
		{"node-cache-linux-pnpm-abc", "node-cache-linux-pnpm-", true},
		{"node-cache-linux-pnpm-abc", "node-cache-linux-pnpn-", false},
		{"buildkit-blob-1-sha256:0af1", "buildkit-blob-1-sha256:", true},
		{"ab", "ac", false},
	} {
		whole := hex.EncodeToString([]byte(testCase.whole))
		asked := hex.EncodeToString([]byte(testCase.asked))
		if got := strings.HasPrefix(whole, asked); got != testCase.prefix {
			t.Errorf("hex(%q) has prefix hex(%q) = %v, want %v",
				testCase.whole, testCase.asked, got, testCase.prefix)
		}
	}
}

// A ref becomes one object-key segment. Two different refs must never become
// the same segment, or one branch's entries would answer another branch's
// restores.
func TestRefSegmentIsPathSafeAndInjective(t *testing.T) {
	if got := refSegment("refs/heads/main"); got != "refs~2Fheads~2Fmain" {
		t.Errorf("refSegment = %q", got)
	}
	refs := []string{
		"refs/heads/main", "refs/heads/feature-x", "refs/pull/7/merge",
		"refs~2Fheads~2Fmain", "refs/heads/feature~x", "refs/heads/../main",
		"refs/heads/main ", "refs/heads/ünïcode",
	}
	seen := map[string]string{}
	for _, ref := range refs {
		segment := refSegment(ref)
		if previous, clash := seen[segment]; clash {
			t.Fatalf("%q and %q both encode to %q", previous, ref, segment)
		}
		seen[segment] = ref
		for i := 0; i < len(segment); i++ {
			c := segment[i]
			safe := (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
				c == '.' || c == '_' || c == '-' || c == '~'
			if !safe {
				t.Fatalf("refSegment(%q) = %q contains %q", ref, segment, string(c))
			}
		}
	}
}

// Recency is encoded into the object's own name so a listing sorts newest-first
// without a read per candidate and without depending on the store's clock.
func TestRecencySuffixSortsNewestFirst(t *testing.T) {
	older := recencySuffix(1_000_000)
	newer := recencySuffix(2_000_000)
	if newer >= older {
		t.Fatalf("newer suffix %q should sort before older %q", newer, older)
	}
	if len(newer) != 16 || len(older) != 16 {
		t.Fatalf("suffixes must be fixed width for a string compare to order them: %q %q", newer, older)
	}
	if got := recencyStamp("6b6579.0123456789abcdef"); got != "0123456789abcdef" {
		t.Errorf("recencyStamp = %q", got)
	}
}

func TestNewestMatchingEntryWins(t *testing.T) {
	index, store, setClock := newTestIndex(t)
	ctx := context.Background()
	claims := cachetoken.Claims{Repository: "Fanzzzd/erainfra", RepositoryID: testRepositoryID, Ref: "refs/heads/main"}

	// A hit has to name bytes that exist, so both blobs are really written.
	store.Overwrite("blobs/old", []byte("old"))
	store.Overwrite("blobs/new", []byte("new"))

	setClock(time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC))
	if err := index.Commit(ctx, Entry{
		Key: "pnpm-old", Version: "v1", Repository: "Fanzzzd/erainfra", RepositoryID: testRepositoryID,
		Ref: "refs/heads/main", Blob: "blobs/old", Size: 1,
	}); err != nil {
		t.Fatal(err)
	}
	setClock(time.Date(2026, 8, 18, 13, 0, 0, 0, time.UTC))
	if err := index.Commit(ctx, Entry{
		Key: "pnpm-new", Version: "v1", Repository: "Fanzzzd/erainfra", RepositoryID: testRepositoryID,
		Ref: "refs/heads/main", Blob: "blobs/new", Size: 1,
	}); err != nil {
		t.Fatal(err)
	}

	entry, err := index.Lookup(ctx, claims, []string{"pnpm-"}, "v1")
	if err != nil {
		t.Fatal(err)
	}
	if entry == nil || entry.Blob != "blobs/new" {
		t.Fatalf("entry = %+v, want the newer one", entry)
	}
}

// The version is an exact-match dimension: a lockfile hash that differs is a
// different entry, never a prefix match on the same key.
func TestLookupIsScopedByVersion(t *testing.T) {
	index, _, _ := newTestIndex(t)
	ctx := context.Background()
	claims := cachetoken.Claims{Repository: "Fanzzzd/erainfra", RepositoryID: testRepositoryID, Ref: "refs/heads/main"}

	if err := index.Commit(ctx, Entry{
		Key: "dep", Version: "version-one", Repository: "Fanzzzd/erainfra", RepositoryID: testRepositoryID,
		Ref: "refs/heads/main", Blob: "blobs/a",
	}); err != nil {
		t.Fatal(err)
	}
	entry, err := index.Lookup(ctx, claims, []string{"dep"}, "version-two")
	if err != nil {
		t.Fatal(err)
	}
	if entry != nil {
		t.Fatalf("entry = %+v, want a miss on a different version", entry)
	}
}

// A token with no readable scope reads nothing, rather than falling back to
// something.
func TestLookupWithNoScopesIsAMiss(t *testing.T) {
	index, _, _ := newTestIndex(t)
	ctx := context.Background()
	if err := index.Commit(ctx, Entry{
		Key: "dep", Version: "v1", Repository: "Fanzzzd/erainfra", RepositoryID: testRepositoryID,
		Ref: "refs/heads/main", Blob: "blobs/a",
	}); err != nil {
		t.Fatal(err)
	}
	entry, err := index.Lookup(ctx, cachetoken.Claims{Repository: "Fanzzzd/erainfra"}, []string{"dep"}, "v1")
	if err != nil {
		t.Fatal(err)
	}
	if entry != nil {
		t.Fatalf("entry = %+v, want a miss", entry)
	}
}

// An entry document that disagrees with where it is stored means the layout and
// the reader have drifted apart, and serving it would be serving another
// scope's bytes.
func TestEntryMetadataThatContradictsItsLocationIsRefused(t *testing.T) {
	index, store, _ := newTestIndex(t)
	ctx := context.Background()
	claims := cachetoken.Claims{Repository: "Fanzzzd/erainfra", RepositoryID: testRepositoryID, Ref: "refs/heads/main"}

	if err := index.Commit(ctx, Entry{
		Key: "dep", Version: "v1", Repository: "Fanzzzd/erainfra", RepositoryID: testRepositoryID,
		Ref: "refs/heads/main", Blob: "blobs/a",
	}); err != nil {
		t.Fatal(err)
	}
	for _, key := range store.Keys() {
		if strings.Contains(key, "entries/") {
			store.Overwrite(key, []byte(`{"key":"dep","version":"v1","repository":"attacker/elsewhere","ref":"refs/heads/main","blob":"blobs/evil"}`))
		}
	}

	entry, err := index.Lookup(ctx, claims, []string{"dep"}, "v1")
	if err != nil {
		t.Fatal(err)
	}
	if entry != nil {
		t.Fatalf("entry = %+v, want the contradiction refused", entry)
	}
}

func TestRepositorySegmentIsCaseFolded(t *testing.T) {
	if repositorySegment("Fanzzzd/EraInfra") != repositorySegment("fanzzzd/erainfra") {
		t.Fatal("two spellings of one repository must share a scope")
	}
	if !strings.Contains(scopePrefix("Fanzzzd/erainfra", "refs/heads/main", "v"), "fanzzzd/erainfra") {
		t.Fatal("the repository should stay readable in the object key")
	}
}

// longKey is a key of n bytes that starts with stem, the shape of a
// restore-keys prefix followed by hashes.
func longKey(stem string, n int) string {
	return stem + strings.Repeat("0123456789abcdef", n/16+1)[:n-len(stem)]
}

// ubuntu0's cache service refused three saves from 2026-11-15 to 16 with
// MinIO's XMinioInvalidObjectName, because a hex-encoded key over 119 bytes
// made one segment longer than 255 bytes. The fake store now refuses those
// names the way MinIO does.
func TestALongKeyIsSavedAndFoundByItselfAndByPrefix(t *testing.T) {
	index, store, _ := newTestIndex(t)
	ctx := context.Background()
	claims := cachetoken.Claims{Repository: "Fanzzzd/erainfra", RepositoryID: testRepositoryID, Ref: "refs/heads/main"}
	store.Overwrite("blobs/long", []byte("long"))
	store.Overwrite("blobs/twin", []byte("twin"))
	key := longKey("node-cache-Linux-x64-pnpm-", 512)
	twin := key[:300] + strings.Repeat("z", 212) // shares the first 300 bytes
	for _, entry := range []Entry{
		{Key: key, Blob: "blobs/long"},
		{Key: twin, Blob: "blobs/twin"},
	} {
		entry.Version, entry.Repository, entry.RepositoryID, entry.Ref, entry.Size = "v1", "Fanzzzd/erainfra", testRepositoryID, "refs/heads/main", 4
		if err := index.Commit(ctx, entry); err != nil {
			t.Fatalf("Commit(%d-byte key): %v", len(entry.Key), err)
		}
	}
	for _, row := range []struct {
		asked []string
		want  string
	}{
		{[]string{key}, "blobs/long"},
		{[]string{twin}, "blobs/twin"},
		{[]string{key[:400]}, "blobs/long"},
		{[]string{twin[:400]}, "blobs/twin"},
		{[]string{key[:300]}, ""}, // both match; either is a correct prefix hit
		{[]string{"node-cache-Linux-x64-pnpm-"}, ""},
		{[]string{key[:399] + "y"}, "miss"},
	} {
		entry, err := index.Lookup(ctx, claims, row.asked, "v1")
		if err != nil {
			t.Fatal(err)
		}
		switch {
		case row.want == "miss" && entry != nil:
			t.Errorf("Lookup(%d bytes) = %s, want a miss", len(row.asked[0]), entry.Blob)
		case row.want == "" && entry == nil:
			t.Errorf("Lookup(%d bytes) missed, want a prefix hit", len(row.asked[0]))
		case row.want != "" && row.want != "miss" && (entry == nil || entry.Blob != row.want):
			t.Errorf("Lookup(%d bytes) = %+v, want %s", len(row.asked[0]), entry, row.want)
		}
	}
	if entry, err := index.LookupExact(ctx, claims, key, "v1"); err != nil || entry == nil || entry.Blob != "blobs/long" {
		t.Fatalf("LookupExact = %+v, %v; want blobs/long", entry, err)
	}
	if exists, err := index.Exists(ctx, claims, key, "v1"); err != nil || !exists {
		t.Fatalf("Exists = %v, %v; want true", exists, err)
	}
}

// Every name an entry can get, with its access and adoption markers, fits the
// store's limits for any key GitHub accepts (512 bytes) beside the longest
// repository (39-byte owner, 100-byte name) and a ref at the one-segment limit.
func TestEveryEntryNameFitsTheObjectStoresLimits(t *testing.T) {
	repository := strings.Repeat("o", 39) + "/" + strings.Repeat("n", 100)
	ref := "refs/heads/" + strings.Repeat("~", 80) // escapes to 255 bytes
	if got := len(refSegment(ref)); got != 255 {
		t.Fatalf("refSegment length = %d, want the 255-byte worst case", got)
	}
	for n := 1; n <= 512; n++ {
		object := scopePrefix(repository, ref, versionSegment("v")) + keyName(longKey("k", n)) + "." + recencySuffix(1)
		for _, name := range []string{object, accessRoot + object, accessRoot + object + adoptedSuffix} {
			if !fakes3.ValidObjectName(name) {
				t.Fatalf("a %d-byte key makes %d-byte name %q, which the store refuses", n, len(name), name)
			}
		}
	}
}

func TestAKeyShortEnoughForOneSegmentIsNamedAsBefore(t *testing.T) {
	for _, n := range []int{1, 64, 115} {
		key := longKey("k", n)
		if got, want := keyName(key), hex.EncodeToString([]byte(key)); got != want {
			t.Errorf("keyName(%d bytes) = %q, want the plain hex %q", n, got, want)
		}
	}
	if got := keyName(longKey("k", 116)); !strings.Contains(got, "/") {
		t.Errorf("keyName(116 bytes) = %q, want it cut into segments", got)
	}
}

func TestARefTooLongForOneSegmentIsHashed(t *testing.T) {
	long := "refs/heads/" + strings.Repeat("a/", 130)
	segment := refSegment(long)
	if !strings.HasPrefix(segment, "~H") || len(segment) != 66 {
		t.Fatalf("refSegment(long) = %q, want ~H and a SHA-256", segment)
	}
	if refSegment(long+"b") == segment {
		t.Fatal("two long refs share a segment")
	}
}
