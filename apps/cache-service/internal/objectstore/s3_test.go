package objectstore

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/Fanzzzd/erainfra/apps/cache-service/internal/objectstore/fakes3"
)

func newTestStore(t *testing.T, store *fakes3.Server, partBytes int64) *S3 {
	t.Helper()
	s3, err := NewS3(S3Config{
		Endpoint:  store.URL,
		Bucket:    store.Bucket,
		AccessKey: store.AccessKey,
		Secret:    store.Secret,
		Region:    "us-east-1",
		Prefix:    "erainfra-cache/v1/",
		PathStyle: true,
		PartBytes: partBytes,
	})
	if err != nil {
		t.Fatal(err)
	}
	return s3
}

func TestPutAndGetRoundTrip(t *testing.T) {
	fake := fakes3.New()
	defer fake.Close()
	store := newTestStore(t, fake, 0)

	if err := store.PutBytes(context.Background(), "entries/a", "application/json", []byte(`{"ok":true}`)); err != nil {
		t.Fatal(err)
	}
	got, err := store.GetBytes(context.Background(), "entries/a", 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != `{"ok":true}` {
		t.Errorf("GetBytes = %q", got)
	}
	// The configured prefix is the store's business, never the caller's.
	if _, ok := fake.Object("erainfra-cache/v1/entries/a"); !ok {
		t.Errorf("object landed under %v, want the configured prefix", fake.Keys())
	}
}

func TestGetMissingObjectIsErrNotFound(t *testing.T) {
	fake := fakes3.New()
	defer fake.Close()
	store := newTestStore(t, fake, 0)

	if _, err := store.GetBytes(context.Background(), "entries/missing", 1<<20); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

func TestListReportsTruncation(t *testing.T) {
	fake := fakes3.New()
	defer fake.Close()
	store := newTestStore(t, fake, 0)

	for _, name := range []string{"entries/a", "entries/b", "entries/c"} {
		if err := store.PutBytes(context.Background(), name, "", []byte("x")); err != nil {
			t.Fatal(err)
		}
	}
	objects, truncated, err := store.List(context.Background(), "entries/", 2)
	if err != nil {
		t.Fatal(err)
	}
	if !truncated {
		t.Error("truncated = false, want true: a caller picking the newest match out of a partial page is picking out of the wrong set")
	}
	if len(objects) != 2 || objects[0].Key != "entries/a" {
		t.Fatalf("objects = %+v", objects)
	}
}

// The Azure block sizes in the capture are 1 MiB (BuildKit, L081-L084) and
// 64 MiB (@actions/cache, L034-L036). S3 refuses any non-final part under
// 5 MiB, so a one-block-one-part translation would fail every BuildKit upload.
// The fake store enforces the 5 MiB floor, so this test fails if the
// coalescing regresses.
func TestUploadCoalescesSmallBlocksIntoLegalParts(t *testing.T) {
	fake := fakes3.New()
	defer fake.Close()
	store := newTestStore(t, fake, 8<<20)

	upload, err := store.NewUpload(context.Background(), "blobs/large")
	if err != nil {
		t.Fatal(err)
	}
	block := bytes.Repeat([]byte("a"), 1<<20)
	want := make([]byte, 0, 20<<20)
	for i := 0; i < 20; i++ {
		if err := upload.AddPart(context.Background(), bytes.NewReader(block), int64(len(block))); err != nil {
			t.Fatal(err)
		}
		want = append(want, block...)
	}
	if err := upload.Complete(context.Background()); err != nil {
		t.Fatal(err)
	}

	got, ok := fake.Object("erainfra-cache/v1/blobs/large")
	if !ok {
		t.Fatal("object was not written")
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("assembled %d bytes, want %d", len(got), len(want))
	}
}

// R2, unlike S3, refuses a completion whose parts are not all the same size.
// An arbitrary chunk stream crosses the PartBytes threshold by a different
// remainder each time, so flushing "everything buffered once we cross" produces
// parts of differing sizes and fails against R2. The fake now enforces R2's
// uniform-part rule, so this test — a deliberately irregular stream that no
// single chunk size could have produced — fails if the client stops emitting
// exact PartBytes parts.
func TestUploadEmitsUniformPartsFromAnIrregularStream(t *testing.T) {
	fake := fakes3.New()
	defer fake.Close()
	const partBytes = 8 << 20
	store := newTestStore(t, fake, partBytes)

	upload, err := store.NewUpload(context.Background(), "blobs/irregular")
	if err != nil {
		t.Fatal(err)
	}
	// Sizes in MiB, none equal to PartBytes and some larger than it, so the
	// straddle path (a single chunk split across two parts) is exercised too.
	sizes := []int{3, 7, 2, 9, 4, 6, 5, 1, 10, 3}
	want := make([]byte, 0)
	for i, mib := range sizes {
		block := bytes.Repeat([]byte{byte('a' + i)}, mib<<20)
		if err := upload.AddPart(context.Background(), bytes.NewReader(block), int64(len(block))); err != nil {
			t.Fatal(err)
		}
		want = append(want, block...)
	}
	if err := upload.Complete(context.Background()); err != nil {
		t.Fatalf("Complete on an irregular stream failed (non-uniform parts?): %v", err)
	}

	got, ok := fake.Object("erainfra-cache/v1/blobs/irregular")
	if !ok {
		t.Fatal("object was not written")
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("assembled %d bytes, want %d", len(got), len(want))
	}
}

func TestSmallUploadIsWrittenWhole(t *testing.T) {
	fake := fakes3.New()
	defer fake.Close()
	store := newTestStore(t, fake, 8<<20)

	upload, err := store.NewUpload(context.Background(), "blobs/small")
	if err != nil {
		t.Fatal(err)
	}
	// 116 bytes is the size BuildKit's empty-layer blob arrives at (capture
	// L058), and most cache entries look more like it than like 200 MiB.
	body := bytes.Repeat([]byte("z"), 116)
	if err := upload.AddPart(context.Background(), bytes.NewReader(body), int64(len(body))); err != nil {
		t.Fatal(err)
	}
	if err := upload.Complete(context.Background()); err != nil {
		t.Fatal(err)
	}
	got, ok := fake.Object("erainfra-cache/v1/blobs/small")
	if !ok || !bytes.Equal(got, body) {
		t.Fatalf("object = %q, ok = %v", got, ok)
	}
}

func TestPresignedURLReadsExactlyOneObjectByGET(t *testing.T) {
	fake := fakes3.New()
	defer fake.Close()
	store := newTestStore(t, fake, 0)
	if err := store.PutBytes(context.Background(), "blobs/one", "", []byte("payload")); err != nil {
		t.Fatal(err)
	}

	signed, err := store.PresignGet(context.Background(), "blobs/one", 5*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	// Rule 4: what a job holds must not be a credential for the bucket.
	if strings.Contains(signed, fake.Secret) {
		t.Fatal("presigned URL leaked the secret key")
	}

	resp, err := http.Get(signed)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK || string(body) != "payload" {
		t.Fatalf("GET presigned = %d %q", resp.StatusCode, body)
	}

	// Same URL, different method. The method is inside the signature, so the
	// store refuses it.
	req, _ := http.NewRequest(http.MethodPut, signed, strings.NewReader("poison"))
	replay, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer replay.Body.Close()
	if replay.StatusCode == http.StatusOK {
		t.Fatal("a GET presigned URL was accepted as a PUT")
	}
	if stored, _ := fake.Object("erainfra-cache/v1/blobs/one"); string(stored) != "payload" {
		t.Fatalf("object was rewritten through the download URL: %q", stored)
	}
}

// The method really is part of what is signed, rather than something the fake
// happens to check.
func TestPresignSignatureIsBoundToTheMethod(t *testing.T) {
	target, _ := url.Parse("https://store.example/bucket/blobs/one")
	creds := credentials{accessKey: "AKIA", secret: "secret-secret-secret", region: "us-east-1"}
	at := time.Date(2026, 8, 18, 0, 0, 0, 0, time.UTC)

	signed := presignGet(target, creds, time.Minute, at)
	parsed, _ := url.Parse(signed)
	query := parsed.Query()
	getSignature := query.Get("X-Amz-Signature")

	query.Del("X-Amz-Signature")
	canonical := strings.Join([]string{
		http.MethodPut,
		canonicalURI(target),
		canonicalQuery(query),
		"host:" + target.Host + "\n",
		"host",
		unsignedPayload,
	}, "\n")
	scope := at.Format(dateLayout) + "/us-east-1/s3/aws4_request"
	putSignature := hexOf(hmacSHA256(signingKey(creds, at), stringToSign(at.Format(isoLayout), scope, canonical)))

	if getSignature == putSignature {
		t.Fatal("the same signature verifies for GET and PUT; the URL is not method-scoped")
	}
}

// The dangerous outage shape is a store that accepts the connection and never
// answers. Every S3 call carries the caller's context, so the deadline the
// handler set is the deadline the socket gets.
func TestEveryStoreCallIsBoundedByItsContext(t *testing.T) {
	blocked := make(chan struct{})
	hung := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { <-blocked }))
	// Release the handler before closing the server: httptest.Close waits for
	// outstanding requests, and a handler still parked on the channel would
	// hang the test rather than the service.
	defer func() {
		close(blocked)
		hung.Close()
	}()

	store, err := NewS3(S3Config{
		Endpoint: hung.URL, Bucket: "b", AccessKey: "a", Secret: "s", PathStyle: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	start := time.Now()
	if _, err := store.GetBytes(ctx, "entries/a", 1<<20); err == nil {
		t.Fatal("a hung store returned no error")
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("GetBytes against a hung store took %s, want the 100ms context deadline", elapsed)
	}
}

func hexOf(raw []byte) string {
	const digits = "0123456789abcdef"
	out := make([]byte, 0, len(raw)*2)
	for _, b := range raw {
		out = append(out, digits[b>>4], digits[b&0xf])
	}
	return string(out)
}
