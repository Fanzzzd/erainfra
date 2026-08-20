package objectstore

import (
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// S3 minimums and maximums, from the API itself rather than from a vendor:
// every part but the last must be at least 5 MiB, and one object is at most
// 10000 parts.
const (
	minPartBytes     = 5 << 20
	defaultPartBytes = 32 << 20
	maxParts         = 10000
)

// S3Config is ADR 0007's store contract, verbatim, plus the knobs an operator
// needs to point it at a store on their own LAN.
type S3Config struct {
	Endpoint  string
	Bucket    string
	Region    string
	AccessKey string
	Secret    string
	// Prefix is prepended to every key, so one bucket can hold more than the
	// cache. Callers never see it.
	Prefix string
	// PathStyle addresses the bucket as a path segment rather than as a
	// subdomain. Every store that runs on an operator's own LAN wants this;
	// hosted stores accept it too.
	PathStyle bool
	// PartBytes is the multipart part size. Below minPartBytes the store would
	// refuse the upload, so it is clamped up.
	PartBytes  int64
	HTTPClient *http.Client
	// Now is the clock used for signing. Tests replace it.
	Now func() time.Time
}

// S3 talks to one bucket on one S3-compatible endpoint.
type S3 struct {
	config S3Config
	creds  credentials
	base   *url.URL
	client *http.Client
}

// NewS3 validates the store contract and resolves the endpoint once, so a
// misconfigured service fails at startup rather than on the first cache miss
// of the first job.
func NewS3(config S3Config) (*S3, error) {
	for name, value := range map[string]string{
		"ERAINFRA_CACHE_S3_ENDPOINT":   config.Endpoint,
		"ERAINFRA_CACHE_S3_BUCKET":     config.Bucket,
		"ERAINFRA_CACHE_S3_ACCESS_KEY": config.AccessKey,
		"ERAINFRA_CACHE_S3_SECRET":     config.Secret,
	} {
		if strings.TrimSpace(value) == "" {
			return nil, fmt.Errorf("%s is required", name)
		}
	}
	base, err := url.Parse(strings.TrimSuffix(config.Endpoint, "/"))
	if err != nil {
		return nil, fmt.Errorf("ERAINFRA_CACHE_S3_ENDPOINT is not a URL: %w", err)
	}
	if base.Scheme != "http" && base.Scheme != "https" {
		return nil, fmt.Errorf("ERAINFRA_CACHE_S3_ENDPOINT must be http or https, got %q", base.Scheme)
	}
	if config.Region == "" {
		config.Region = "us-east-1"
	}
	if config.PartBytes < minPartBytes {
		config.PartBytes = defaultPartBytes
	}
	client := config.HTTPClient
	if client == nil {
		// No client-level timeout: every request carries its own deadline in
		// its context, and a single ceiling here would either cut a 200 MiB
		// upload short or be too loose to bound a lookup.
		client = &http.Client{}
	}
	return &S3{
		config: config,
		creds:  credentials{accessKey: config.AccessKey, secret: config.Secret, region: config.Region},
		base:   base,
		client: client,
	}, nil
}

func (s *S3) now() time.Time {
	if s.config.Now != nil {
		return s.config.Now()
	}
	return time.Now()
}

func (s *S3) objectURL(key string) *url.URL {
	target := *s.base
	full := s.config.Prefix + key
	var path string
	if s.config.PathStyle {
		path = strings.TrimSuffix(target.Path, "/") + "/" + s.config.Bucket + "/" + full
	} else {
		target.Host = s.config.Bucket + "." + target.Host
		path = strings.TrimSuffix(target.Path, "/") + "/" + full
	}
	// Path and RawPath are set together so the bytes on the wire and the bytes
	// the signature covers are the same by construction. Go's own path escaping
	// leaves characters that AWS's rule encodes, and a disagreement there
	// surfaces only as SignatureDoesNotMatch from the store.
	target.Path = path
	target.RawPath = uriEncode(path, false)
	return &target
}

func (s *S3) bucketURL() *url.URL {
	target := *s.base
	if s.config.PathStyle {
		target.Path = strings.TrimSuffix(target.Path, "/") + "/" + s.config.Bucket
	} else {
		target.Host = s.config.Bucket + "." + target.Host
		target.Path = strings.TrimSuffix(target.Path, "/") + "/"
	}
	target.RawPath = uriEncode(target.Path, false)
	return &target
}

func (s *S3) do(ctx context.Context, method string, target *url.URL, query url.Values,
	header http.Header, body io.Reader, size int64, payloadHash string) (*http.Response, error) {
	signed := *target
	if len(query) > 0 {
		signed.RawQuery = canonicalQuery(query)
	}
	req, err := http.NewRequestWithContext(ctx, method, signed.String(), body)
	if err != nil {
		return nil, err
	}
	// Re-attach the escaped path: http.NewRequest reparses the string form and
	// loses the RawPath we set deliberately above.
	req.URL.Path = signed.Path
	req.URL.RawPath = signed.RawPath
	for name, values := range header {
		for _, value := range values {
			req.Header.Add(name, value)
		}
	}
	if size >= 0 {
		req.ContentLength = size
	}
	signRequest(req, s.creds, payloadHash, s.now())
	return s.client.Do(req)
}

// statusError turns a non-2xx response into an error, reading a bounded amount
// of the store's XML so an operator sees the store's own reason.
func statusError(resp *http.Response) error {
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return ErrNotFound
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	var parsed struct {
		Code    string `xml:"Code"`
		Message string `xml:"Message"`
	}
	if err := xml.Unmarshal(body, &parsed); err == nil && parsed.Code != "" {
		if parsed.Code == "NoSuchKey" || parsed.Code == "NoSuchBucket" {
			return ErrNotFound
		}
		return fmt.Errorf("object store returned %d %s: %s", resp.StatusCode, parsed.Code, parsed.Message)
	}
	return fmt.Errorf("object store returned %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
}

func drain(resp *http.Response) {
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
	_ = resp.Body.Close()
}

func (s *S3) PutBytes(ctx context.Context, key, contentType string, body []byte) error {
	header := http.Header{}
	if contentType != "" {
		header.Set("Content-Type", contentType)
	}
	resp, err := s.do(ctx, http.MethodPut, s.objectURL(key), nil, header,
		bytes.NewReader(body), int64(len(body)), hashOf(body))
	if err != nil {
		return err
	}
	if resp.StatusCode/100 != 2 {
		return statusError(resp)
	}
	drain(resp)
	return nil
}

func (s *S3) GetBytes(ctx context.Context, key string, limit int64) ([]byte, error) {
	reader, _, err := s.Open(ctx, key)
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	body, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > limit {
		return nil, fmt.Errorf("object %q is larger than the %d byte limit", key, limit)
	}
	return body, nil
}

func (s *S3) Open(ctx context.Context, key string) (io.ReadCloser, int64, error) {
	resp, err := s.do(ctx, http.MethodGet, s.objectURL(key), nil, nil, nil, -1, emptyPayloadHash)
	if err != nil {
		return nil, 0, err
	}
	if resp.StatusCode/100 != 2 {
		return nil, 0, statusError(resp)
	}
	return resp.Body, resp.ContentLength, nil
}

type listResult struct {
	IsTruncated bool `xml:"IsTruncated"`
	Contents    []struct {
		Key  string `xml:"Key"`
		Size int64  `xml:"Size"`
	} `xml:"Contents"`
}

func (s *S3) List(ctx context.Context, prefix string, max int) ([]Object, bool, error) {
	query := url.Values{}
	query.Set("list-type", "2")
	query.Set("prefix", s.config.Prefix+prefix)
	query.Set("max-keys", strconv.Itoa(max))

	resp, err := s.do(ctx, http.MethodGet, s.bucketURL(), query, nil, nil, -1, emptyPayloadHash)
	if err != nil {
		return nil, false, err
	}
	if resp.StatusCode/100 != 2 {
		return nil, false, statusError(resp)
	}
	defer resp.Body.Close()

	var parsed listResult
	if err := xml.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(&parsed); err != nil {
		return nil, false, fmt.Errorf("decode listing: %w", err)
	}
	objects := make([]Object, 0, len(parsed.Contents))
	for _, item := range parsed.Contents {
		objects = append(objects, Object{Key: strings.TrimPrefix(item.Key, s.config.Prefix), Size: item.Size})
	}
	return objects, parsed.IsTruncated, nil
}

func (s *S3) PresignGet(_ context.Context, key string, ttl time.Duration) (string, error) {
	if ttl <= 0 {
		return "", errors.New("presigned URL lifetime must be positive")
	}
	return presignGet(s.objectURL(key), s.creds, ttl, s.now()), nil
}

func (s *S3) NewUpload(_ context.Context, key string) (Upload, error) {
	return &s3Upload{store: s, key: key}, nil
}

type pendingPart struct {
	body io.Reader
	size int64
}

type completedPart struct {
	Number int    `xml:"PartNumber"`
	ETag   string `xml:"ETag"`
}

// s3Upload maps a stream of arbitrary-sized appends onto S3 multipart parts.
//
// The coalescing is the point. BuildKit stages 1 MiB Azure blocks (capture
// L081-L084) and S3 refuses any part under 5 MiB that is not the last one, so
// one-block-one-part would fail every BuildKit upload. Bytes are held as
// readers rather than copied: the caller's readers are spool files, so a part
// flush streams straight from disk.
type s3Upload struct {
	store    *S3
	key      string
	pending  []pendingPart
	buffered int64
	uploadID string
	parts    []completedPart
	done     bool
}

func (u *s3Upload) AddPart(ctx context.Context, body io.Reader, size int64) error {
	if size <= 0 {
		return nil
	}
	u.pending = append(u.pending, pendingPart{body: body, size: size})
	u.buffered += size
	// Flush in whole PartBytes units, not "everything buffered once we cross the
	// threshold". S3 tolerates parts of any size >= 5 MiB, but R2 refuses a
	// completion whose parts are not all the same size, and an arbitrary chunk
	// stream (BuildKit's 1 MiB Azure blocks) crosses the threshold by a different
	// remainder each time. Emitting exact PartBytes parts and carrying the
	// overshoot forward keeps every part but the last identical.
	for u.buffered >= u.store.config.PartBytes {
		if err := u.flush(ctx, u.store.config.PartBytes); err != nil {
			return err
		}
	}
	return nil
}

// flush uploads exactly n bytes as the next part, leaving any buffered remainder
// for the next part. n must be <= u.buffered.
func (u *s3Upload) flush(ctx context.Context, n int64) error {
	if n <= 0 {
		return nil
	}
	if u.uploadID == "" {
		if err := u.begin(ctx); err != nil {
			return err
		}
	}
	if len(u.parts) >= maxParts {
		return fmt.Errorf("cache entry needs more than %d parts", maxParts)
	}

	number := len(u.parts) + 1
	query := url.Values{}
	query.Set("partNumber", strconv.Itoa(number))
	query.Set("uploadId", u.uploadID)

	resp, err := u.store.do(ctx, http.MethodPut, u.store.objectURL(u.key), query, nil,
		u.takeReaders(n), n, unsignedPayload)
	if err != nil {
		return err
	}
	if resp.StatusCode/100 != 2 {
		return statusError(resp)
	}
	etag := resp.Header.Get("ETag")
	drain(resp)
	if etag == "" {
		return fmt.Errorf("object store returned no ETag for part %d", number)
	}
	u.parts = append(u.parts, completedPart{Number: number, ETag: etag})
	return nil
}

// takeReaders removes exactly n bytes from the front of the pending queue and
// returns a reader over them, leaving the remainder as the new head. A part that
// straddles the boundary is split: its first bytes go now and its underlying
// reader stays as the remainder, so the caller must read the returned reader to
// completion before the next takeReaders. n must be <= u.buffered.
func (u *s3Upload) takeReaders(n int64) io.Reader {
	readers := make([]io.Reader, 0, len(u.pending))
	var taken int64
	i := 0
	for i < len(u.pending) && taken < n {
		part := u.pending[i]
		want := n - taken
		if part.size <= want {
			readers = append(readers, io.LimitReader(part.body, part.size))
			taken += part.size
			i++
			continue
		}
		readers = append(readers, io.LimitReader(part.body, want))
		u.pending[i] = pendingPart{body: part.body, size: part.size - want}
		taken += want
		break
	}
	u.pending = u.pending[i:]
	u.buffered -= n
	return io.MultiReader(readers...)
}

func (u *s3Upload) begin(ctx context.Context) error {
	query := url.Values{}
	query.Set("uploads", "")
	resp, err := u.store.do(ctx, http.MethodPost, u.store.objectURL(u.key), query, nil, nil, 0, emptyPayloadHash)
	if err != nil {
		return err
	}
	if resp.StatusCode/100 != 2 {
		return statusError(resp)
	}
	defer resp.Body.Close()
	var parsed struct {
		UploadID string `xml:"UploadId"`
	}
	if err := xml.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&parsed); err != nil {
		return fmt.Errorf("decode multipart start: %w", err)
	}
	if parsed.UploadID == "" {
		return errors.New("object store started a multipart upload with no upload id")
	}
	u.uploadID = parsed.UploadID
	return nil
}

func (u *s3Upload) Complete(ctx context.Context) error {
	if u.done {
		return nil
	}
	if u.uploadID == "" {
		// Never grew past one part. Most cache entries land here: BuildKit's
		// index blob is about 2 KiB (capture L070) and its empty-layer blob is
		// 116 bytes (capture L058).
		n := u.buffered
		resp, err := u.store.do(ctx, http.MethodPut, u.store.objectURL(u.key), nil, nil,
			u.takeReaders(n), n, unsignedPayload)
		if err != nil {
			return err
		}
		if resp.StatusCode/100 != 2 {
			return statusError(resp)
		}
		drain(resp)
		u.done = true
		return nil
	}
	// The remainder is the last part, which may be any size (S3's floor and R2's
	// uniform-size rule both exempt it). It can also be zero when the stream ended
	// on a PartBytes boundary, in which case the parts already uploaded stand.
	if err := u.flush(ctx, u.buffered); err != nil {
		return err
	}

	body, err := xml.Marshal(struct {
		XMLName xml.Name        `xml:"CompleteMultipartUpload"`
		Parts   []completedPart `xml:"Part"`
	}{Parts: u.parts})
	if err != nil {
		return err
	}
	query := url.Values{}
	query.Set("uploadId", u.uploadID)
	resp, err := u.store.do(ctx, http.MethodPost, u.store.objectURL(u.key), query, nil,
		bytes.NewReader(body), int64(len(body)), hashOf(body))
	if err != nil {
		return err
	}
	if resp.StatusCode/100 != 2 {
		return statusError(resp)
	}
	defer resp.Body.Close()
	// A multipart completion can fail inside a 200 response: the store starts
	// the body, then writes an <Error> element into it. Treating 200 as success
	// here would commit a cache entry that does not exist.
	tail, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if bytes.Contains(tail, []byte("<Error")) {
		return fmt.Errorf("object store failed the multipart completion: %s", strings.TrimSpace(string(tail)))
	}
	u.done = true
	return nil
}

func (u *s3Upload) Abort(ctx context.Context) error {
	u.pending, u.buffered = nil, 0
	if u.uploadID == "" || u.done {
		return nil
	}
	query := url.Values{}
	query.Set("uploadId", u.uploadID)
	resp, err := u.store.do(ctx, http.MethodDelete, u.store.objectURL(u.key), query, nil, nil, 0, emptyPayloadHash)
	u.uploadID = ""
	if err != nil {
		return err
	}
	if resp.StatusCode/100 != 2 && resp.StatusCode != http.StatusNotFound {
		return statusError(resp)
	}
	drain(resp)
	return nil
}
