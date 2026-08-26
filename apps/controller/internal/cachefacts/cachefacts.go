// Package cachefacts publishes a job's identity to the erainfra cache service so
// the service can scope that runner's cache requests to the job's repository.
//
// A runner's VM boots before its repository is known: the JIT runner is
// repo-agnostic and only learns its job once GitHub claims it. So the cache
// bearer names only the runner, and the repository — with the read-versus-write
// decision that depends on the event and head repository — reaches the service
// out of band, here, at JobStarted. The service authenticates this push by an
// HMAC of the request body under a key it shares with the controller: a job,
// which never holds the key, cannot forge one.
package cachefacts

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// factsPath and adminHeader mirror the cache service's admin endpoint. They are a
// cross-service contract rather than an import because the controller and the
// cache service are separate programs that share only this HTTP shape and the
// signing key — the service's handler lives in an internal package the controller
// cannot reach.
const (
	factsPath   = "/_erainfra-cache-admin/facts"
	adminHeader = "X-Erainfra-Cache-Admin"
)

// MinSigningKeyLen mirrors the cache service's own minimum. A key shorter than
// this is refused at construction rather than used, so a misconfiguration fails
// here instead of at the first push — or worse, signs with a weak key.
const MinSigningKeyLen = 32

// Facts is a job's identity as the controller learns it at JobStarted: which
// runner is about to run the job, and the GitHub facts the cache service scopes
// that runner's requests from.
type Facts struct {
	Runner         string
	Repository     string
	HeadRepository string
	Event          string
	Ref            string
	BaseRef        string
	DefaultBranch  string
	Attempt        string
}

// request is the JSON the cache service's registerFactsRequest decodes. The field
// names and their omitempty-ness match it exactly: the body is signed, so both
// sides must serialize the same bytes.
type request struct {
	Runner         string `json:"runner"`
	Repository     string `json:"repository"`
	HeadRepository string `json:"headRepository,omitempty"`
	Event          string `json:"event,omitempty"`
	Ref            string `json:"ref"`
	BaseRef        string `json:"baseRef,omitempty"`
	DefaultBranch  string `json:"defaultBranch,omitempty"`
	Attempt        string `json:"attempt,omitempty"`
	ExpiresUnix    int64  `json:"expiresUnix"`
}

// Client publishes facts to one cache service.
type Client struct {
	baseURL    string
	signingKey []byte
	ttl        time.Duration
	http       *http.Client
	now        func() time.Time
}

// New builds a client that signs each push with signingKey and gives every pushed
// entry a lifetime of ttl. baseURL is the cache service's address; ttl must
// outlive the longest job whose cache should keep working, because the service
// evicts the facts when it lapses and every later request reads as a cold miss.
func New(baseURL string, signingKey []byte, ttl time.Duration) (*Client, error) {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" {
		return nil, errors.New("cache facts base URL is required")
	}
	if len(signingKey) < MinSigningKeyLen {
		return nil, fmt.Errorf("cache signing key must be at least %d bytes", MinSigningKeyLen)
	}
	if ttl <= 0 {
		return nil, errors.New("cache facts ttl must be positive")
	}
	return &Client{
		baseURL:    baseURL,
		signingKey: append([]byte(nil), signingKey...),
		ttl:        ttl,
		http:       &http.Client{Timeout: 10 * time.Second},
		now:        time.Now,
	}, nil
}

// Push registers a runner's facts. The entry expires ttl from now, which the
// service uses to evict it; the controller does not delete it, because a runner
// name is never reused and the VM is gone once the job ends.
func (c *Client) Push(ctx context.Context, facts Facts) error {
	body, err := json.Marshal(request{
		Runner:         facts.Runner,
		Repository:     facts.Repository,
		HeadRepository: facts.HeadRepository,
		Event:          facts.Event,
		Ref:            facts.Ref,
		BaseRef:        facts.BaseRef,
		DefaultBranch:  facts.DefaultBranch,
		Attempt:        facts.Attempt,
		ExpiresUnix:    c.now().Add(c.ttl).Unix(),
	})
	if err != nil {
		return fmt.Errorf("encode cache facts: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+factsPath, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build cache facts request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(adminHeader, c.sign(body))

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("push cache facts: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	// Drain a bounded amount so the keep-alive connection can be reused.
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))
	if resp.StatusCode != http.StatusNoContent {
		return fmt.Errorf("cache facts push returned %d", resp.StatusCode)
	}
	return nil
}

// sign is the same HMAC the cache service checks: sha256 of the exact body under
// the shared key, hex encoded.
func (c *Client) sign(body []byte) string {
	mac := hmac.New(sha256.New, c.signingKey)
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}
