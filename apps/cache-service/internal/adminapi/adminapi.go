// Package adminapi is the cache service's management surface: list a
// repository's entries, delete some of them, or clear the repository. The
// shape follows GitHub's own cache API (GET and DELETE on one collection,
// filtered by key and ref, paginated by page and per_page) and Blacksmith's CLI
// verbs (list, delete, clear), so an operator moving from either recognises it.
//
// It is authenticated the way the controller's facts push is: by proving
// possession of the service's signing key, which a job never holds. It goes
// further than the facts push in one respect. A replayed facts push re-registers
// facts that carry their own expiry, which is harmless; a replayed "clear this
// repository" deletes every entry saved since the original. So every admin
// request is signed over its method, path, query, a timestamp, a nonce and its
// body, and the service refuses one outside a five-minute window or one whose
// nonce it has already seen.
package adminapi

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// EntriesPath is the one collection the admin API serves. It sits beside the
// facts endpoint under the same admin prefix, which a job's cache traffic never
// routes to.
const EntriesPath = "/_erainfra-cache-admin/entries"

// Headers. The signature header is not the facts push's X-Erainfra-Cache-Admin,
// so a facts signature can never be presented here, and the key it is computed
// under is derived (see deriveKey), so no other signature this service checks
// can be either.
const (
	HeaderTimestamp = "X-Erainfra-Cache-Admin-Timestamp"
	HeaderNonce     = "X-Erainfra-Cache-Admin-Nonce"
	HeaderSignature = "X-Erainfra-Cache-Admin-Signature"
)

// MaxSkew is how far a request's timestamp may sit from the service's clock,
// in either direction. It is also how long a nonce is remembered.
const MaxSkew = 5 * time.Minute

// maxRemembered bounds the nonce memory. Only correctly signed requests are
// remembered, so reaching it means a key holder is sending more than three
// hundred admin requests a second for five minutes.
const maxRemembered = 100000

// MinSigningKeyLen mirrors the service's own minimum.
const MinSigningKeyLen = 32

var (
	ErrUnsigned  = errors.New("the request is not signed")
	ErrStale     = errors.New("the request timestamp is outside the replay window")
	ErrForged    = errors.New("the request signature does not match")
	ErrReplayed  = errors.New("the request nonce has already been used")
	ErrMalformed = errors.New("the request signature headers are malformed")
)

// deriveKey separates the admin domain from every other use of the signing
// key: runner tokens, upload and download URL names, and the facts push all
// MAC under the key itself, so none of their MACs is a valid admin signature
// and no admin signature is valid for any of them.
func deriveKey(signingKey []byte) []byte {
	mac := hmac.New(sha256.New, signingKey)
	mac.Write([]byte("erainfra-cache-admin-api-v1"))
	return mac.Sum(nil)
}

// canonical is the exact string a request is signed over. The query is
// re-encoded in sorted order so that the client and the service agree on it
// regardless of how a proxy in between spells it.
func canonical(method, path string, query url.Values, timestamp, nonce string, body []byte) string {
	sum := sha256.Sum256(body)
	return strings.Join([]string{
		"erainfra-cache-admin-v1",
		strings.ToUpper(method),
		path,
		query.Encode(),
		timestamp,
		nonce,
		hex.EncodeToString(sum[:]),
	}, "\n")
}

func signature(key []byte, message string) string {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(message))
	return hex.EncodeToString(mac.Sum(nil))
}

// Sign adds the three admin headers to a request whose body is body.
func Sign(req *http.Request, signingKey, body []byte, now time.Time) error {
	if len(signingKey) < MinSigningKeyLen {
		return fmt.Errorf("the signing key must be at least %d bytes", MinSigningKeyLen)
	}
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return err
	}
	nonce := hex.EncodeToString(raw)
	timestamp := strconv.FormatInt(now.Unix(), 10)
	message := canonical(req.Method, req.URL.EscapedPath(), req.URL.Query(), timestamp, nonce, body)
	req.Header.Set(HeaderTimestamp, timestamp)
	req.Header.Set(HeaderNonce, nonce)
	req.Header.Set(HeaderSignature, signature(deriveKey(signingKey), message))
	return nil
}

// Verifier checks admin signatures and remembers nonces for the replay window.
//
// The memory is per process. A deployment with more than one replica behind a
// balancer could have one request replayed once per other replica inside the
// five minutes; the replay can only repeat the exact signed operation, and the
// timestamp still closes the window.
type Verifier struct {
	key []byte
	Now func() time.Time

	mu   sync.Mutex
	seen map[string]time.Time
}

func NewVerifier(signingKey []byte) (*Verifier, error) {
	if len(signingKey) < MinSigningKeyLen {
		return nil, fmt.Errorf("the signing key must be at least %d bytes", MinSigningKeyLen)
	}
	return &Verifier{key: deriveKey(signingKey), seen: map[string]time.Time{}}, nil
}

func (v *Verifier) now() time.Time {
	if v.Now != nil {
		return v.Now()
	}
	return time.Now()
}

// Verify checks a request whose body has already been read into body.
//
// The signature is compared in constant time. The nonce is recorded only after
// the signature checks out, so a client without the key cannot fill the memory.
func (v *Verifier) Verify(r *http.Request, body []byte) error {
	timestamp := r.Header.Get(HeaderTimestamp)
	nonce := r.Header.Get(HeaderNonce)
	got := r.Header.Get(HeaderSignature)
	if timestamp == "" && nonce == "" && got == "" {
		return ErrUnsigned
	}
	if timestamp == "" || got == "" || len(nonce) < 16 || len(nonce) > 128 {
		return ErrMalformed
	}
	seconds, err := strconv.ParseInt(timestamp, 10, 64)
	if err != nil {
		return ErrMalformed
	}
	now := v.now()
	signedAt := time.Unix(seconds, 0)
	if signedAt.Before(now.Add(-MaxSkew)) || signedAt.After(now.Add(MaxSkew)) {
		return ErrStale
	}
	want := signature(v.key, canonical(r.Method, r.URL.EscapedPath(), r.URL.Query(), timestamp, nonce, body))
	if !hmac.Equal([]byte(got), []byte(want)) {
		return ErrForged
	}

	v.mu.Lock()
	defer v.mu.Unlock()
	for seenNonce, at := range v.seen {
		if now.Sub(at) > 2*MaxSkew {
			delete(v.seen, seenNonce)
		}
	}
	if _, used := v.seen[nonce]; used {
		return ErrReplayed
	}
	if len(v.seen) >= maxRemembered {
		return ErrReplayed
	}
	v.seen[nonce] = now
	return nil
}

// Entry is one cache entry on the wire. The field names are GitHub's, from its
// "list GitHub Actions caches for a repository" response, so a script written
// against that API reads this one.
type Entry struct {
	Key            string    `json:"key"`
	Version        string    `json:"version"`
	Ref            string    `json:"ref"`
	SizeInBytes    int64     `json:"size_in_bytes"`
	CreatedAt      time.Time `json:"created_at"`
	LastAccessedAt time.Time `json:"last_accessed_at"`
	// RepositoryID is GitHub's ID for the repository that saved the entry.
	// Absent for an entry stored before IDs were recorded. No job reads such
	// an entry, and the next sweep removes it.
	RepositoryID int64 `json:"repository_id,omitempty"`
}

// ListResponse is GET EntriesPath.
type ListResponse struct {
	Repository string `json:"repository"`
	// RepositoryID is the GitHub repository ID that holds this name: the last
	// one that saved under it. Jobs of any other ID restore nothing listed
	// here. Absent while the name has no record.
	RepositoryID int64   `json:"repository_id,omitempty"`
	TotalCount   int     `json:"total_count"`
	TotalBytes   int64   `json:"total_bytes"`
	Page         int     `json:"page"`
	PerPage      int     `json:"per_page"`
	Entries      []Entry `json:"entries"`
}

// DeleteResponse is DELETE EntriesPath. The bytes are deleted from the index at
// once and from the bucket once nothing can still be downloading them, which is
// at most the eviction interval plus the blob grace period later.
type DeleteResponse struct {
	Repository   string  `json:"repository"`
	DeletedCount int     `json:"deleted_count"`
	DeletedBytes int64   `json:"deleted_bytes"`
	Entries      []Entry `json:"entries"`
}

// Sort columns and directions. last_used_at is Blacksmith's name and the
// default; last_accessed_at is GitHub's and means the same.
var SortColumns = []string{"last_used_at", "last_accessed_at", "created_at", "size", "key", "version", "ref"}

// ListQuery is the list request.
type ListQuery struct {
	Repository    string
	Prefix        string
	Search        string
	Ref           string
	Version       string
	RepositoryID  int64 // entries saved by this GitHub repository ID; zero is any
	SortBy        string
	SortDirection string
	Page          int
	PerPage       int
}

func (q ListQuery) values() url.Values {
	values := url.Values{}
	values.Set("repository", q.Repository)
	set := func(name, value string) {
		if value != "" {
			values.Set(name, value)
		}
	}
	set("prefix", q.Prefix)
	set("search", q.Search)
	set("ref", q.Ref)
	set("version", q.Version)
	if q.RepositoryID > 0 {
		values.Set("repository_id", strconv.FormatInt(q.RepositoryID, 10))
	}
	set("sort", q.SortBy)
	set("direction", q.SortDirection)
	if q.Page > 0 {
		values.Set("page", strconv.Itoa(q.Page))
	}
	if q.PerPage > 0 {
		values.Set("per_page", strconv.Itoa(q.PerPage))
	}
	return values
}

// DeleteQuery is the delete request. Exactly one of Key, Prefix and All.
type DeleteQuery struct {
	Repository string
	Key        string
	Prefix     string
	All        bool
	Version    string
	Ref        string
	// RepositoryID narrows any of the three to entries saved by that GitHub
	// repository ID, which is how the entries a repository left under a name
	// it no longer holds are cleared without touching the new holder's.
	RepositoryID int64
}

func (q DeleteQuery) values() url.Values {
	values := url.Values{}
	values.Set("repository", q.Repository)
	set := func(name, value string) {
		if value != "" {
			values.Set(name, value)
		}
	}
	set("key", q.Key)
	set("prefix", q.Prefix)
	set("version", q.Version)
	set("ref", q.Ref)
	if q.RepositoryID > 0 {
		values.Set("repository_id", strconv.FormatInt(q.RepositoryID, 10))
	}
	if q.All {
		values.Set("all", "true")
	}
	return values
}

// Client calls one cache service's admin API.
type Client struct {
	BaseURL    string
	SigningKey []byte
	HTTP       *http.Client
	Now        func() time.Time
}

// Error is a non-2xx answer, carrying the service's own message.
type Error struct {
	Status  int
	Message string
}

func (e *Error) Error() string {
	return fmt.Sprintf("cache service answered %d: %s", e.Status, e.Message)
}

func (c *Client) List(ctx context.Context, query ListQuery) (ListResponse, error) {
	var response ListResponse
	err := c.do(ctx, http.MethodGet, query.values(), &response)
	return response, err
}

func (c *Client) Delete(ctx context.Context, query DeleteQuery) (DeleteResponse, error) {
	var response DeleteResponse
	err := c.do(ctx, http.MethodDelete, query.values(), &response)
	return response, err
}

func (c *Client) do(ctx context.Context, method string, query url.Values, target any) error {
	base, err := url.Parse(strings.TrimRight(c.BaseURL, "/"))
	if err != nil || (base.Scheme != "http" && base.Scheme != "https") || base.Host == "" {
		return fmt.Errorf("%q is not an http(s) URL", c.BaseURL)
	}
	base.Path += EntriesPath
	base.RawQuery = query.Encode()
	req, err := http.NewRequestWithContext(ctx, method, base.String(), bytes.NewReader(nil))
	if err != nil {
		return err
	}
	now := time.Now()
	if c.Now != nil {
		now = c.Now()
	}
	if err := Sign(req, c.SigningKey, nil, now); err != nil {
		return err
	}
	client := c.HTTP
	if client == nil {
		client = &http.Client{Timeout: 2 * time.Minute}
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode/100 != 2 {
		var problem struct {
			Message string `json:"message"`
		}
		_ = json.Unmarshal(body, &problem)
		if problem.Message == "" {
			problem.Message = strings.TrimSpace(string(body))
		}
		return &Error{Status: resp.StatusCode, Message: problem.Message}
	}
	if err := json.Unmarshal(body, target); err != nil {
		return fmt.Errorf("the cache service's answer does not decode: %w", err)
	}
	return nil
}
