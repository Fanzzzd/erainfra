// Package objectstore is the seam between the cache protocol and the bucket
// behind it. ADR 0007 fixes the store contract at one
// endpoint/bucket/access-key/secret and names no vendor, so everything here is
// plain S3 API over HTTP with a deadline on every call.
package objectstore

import (
	"context"
	"errors"
	"io"
	"time"
)

// ErrNotFound is what every read returns for an object that is not there. It
// is a sentinel rather than a status code because the callers above turn it
// into a cache miss, and a miss is never a 404 on the wire (capture L001,
// L007).
var ErrNotFound = errors.New("object not found")

// Object is one entry of a listing.
type Object struct {
	Key  string
	Size int64
}

// Store is the whole of what the cache needs from a bucket.
type Store interface {
	// PutBytes writes a small object whole. Used for entry metadata.
	PutBytes(ctx context.Context, key, contentType string, body []byte) error
	// GetBytes reads a small object whole, refusing anything over limit so a
	// corrupt or hostile object cannot be read into memory unbounded.
	GetBytes(ctx context.Context, key string, limit int64) ([]byte, error)
	// Open streams an object. The caller closes the reader.
	Open(ctx context.Context, key string) (io.ReadCloser, int64, error)
	// List returns up to max objects under prefix, and whether the listing was
	// cut short. Truncation is reported rather than hidden: a caller that
	// picks "the newest match" out of a truncated page is picking out of the
	// wrong set and should say so in a log line.
	List(ctx context.Context, prefix string, max int) (objects []Object, truncated bool, err error)
	// NewUpload begins a streamed write of an object of unknown final size.
	NewUpload(ctx context.Context, key string) (Upload, error)
	// PresignGet returns a URL that reads exactly this object, by GET only,
	// until ttl elapses. ADR 0007 rule 4 is what constrains the shape.
	PresignGet(ctx context.Context, key string, ttl time.Duration) (string, error)
}

// Upload accumulates an object's bytes and then commits them.
//
// The unit callers hand it is whatever the client sent — a 32 MiB v1 PATCH
// chunk (capture L021) or a 1 MiB Azure block (capture L081) — and the unit S3
// wants is a multipart part of at least 5 MiB. Those do not line up, which is
// the whole reason AddPart takes a size and coalesces rather than mapping one
// call to one part.
type Upload interface {
	// AddPart appends exactly size bytes from body. Bytes arrive in the order
	// the finished object needs them.
	//
	// It does NOT necessarily read body before it returns. An implementation
	// that coalesces holds the reader until it has enough bytes for a part, so
	// **the caller must keep body readable until Complete or Abort returns**.
	// Closing a file handed to AddPart before then produces an upload that
	// fails at the flush, several calls later, with an error that names the
	// part rather than the close.
	AddPart(ctx context.Context, body io.Reader, size int64) error
	// Complete finishes the object. An upload that never grew past one part is
	// written as a single object rather than as a one-part multipart, because
	// most cache entries are small (capture L098: 116 bytes).
	Complete(ctx context.Context) error
	// Abort discards the object and any multipart state behind it. Safe to
	// call after Complete.
	Abort(ctx context.Context) error
}
