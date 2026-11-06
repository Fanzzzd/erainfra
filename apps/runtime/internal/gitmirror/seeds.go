package gitmirror

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// seedPath is the cache service's git seed endpoint
// (apps/cache-service/internal/server/gitseed.go).
const seedPath = "/_erainfra-git-seed/v1"

// SeedInfo is what the cache service says about this job's seed.
type SeedInfo struct {
	// Repository is the job's own repository, "owner/name", from the job
	// facts the controller pushed. It is the only repository the mirror
	// serves: every other fetch passes through to GitHub untouched.
	Repository string
	// Writable reports whether this job should save a seed. A fork pull
	// request's job may not, so it never builds one; nor does any job while
	// the cache service is backing off from a seed it refused (RefusedUntil).
	Writable bool
	// RefusedUntil is set when the cache service refused this repository's
	// last seed, for being over its entry size limit, and is not taking
	// another before then. Zero otherwise.
	RefusedUntil time.Time
	// Found reports whether a seed exists for the job's scope.
	Found bool
	// Created is when the seed was saved. Zero when none was found.
	Created time.Time
}

// SeedStore is where seeds live. The cache service implements it over HTTP;
// tests implement it in memory.
type SeedStore interface {
	// Open returns this job's seed. The body is nil when no seed was found.
	Open(ctx context.Context) (SeedInfo, io.ReadCloser, error)
	// Save uploads the bundle at path as this job's seed.
	Save(ctx context.Context, path string) error
}

// ErrSeedUnavailable is an answer that says nothing about the job: the cache
// service refused the runner (its job facts have not arrived yet, or it is
// misconfigured) or could not be reached.
var ErrSeedUnavailable = errors.New("gitmirror: the cache service did not answer for this job")

// SeedClient is the cache service's seed endpoint, authenticated with the
// runner-auth bearer the host minted. The bearer never reaches a git process
// or GitHub.
type SeedClient struct {
	endpoint string
	token    string
	client   *http.Client
}

// NewSeedClient builds a client for the cache service at baseURL.
func NewSeedClient(baseURL, token string, transport http.RoundTripper) (*SeedClient, error) {
	parsed, err := url.Parse(baseURL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return nil, fmt.Errorf("gitmirror: cache service URL %q is not an absolute http(s) URL", baseURL)
	}
	if token == "" {
		return nil, errors.New("gitmirror: a runner token is required")
	}
	if transport == nil {
		transport = http.DefaultTransport.(*http.Transport).Clone()
	}
	return &SeedClient{
		endpoint: strings.TrimSuffix(baseURL, "/") + seedPath,
		token:    token,
		client:   &http.Client{Transport: transport},
	}, nil
}

func (c *SeedClient) request(ctx context.Context, method string, body io.Reader) (*http.Request, error) {
	request, err := http.NewRequestWithContext(ctx, method, c.endpoint, body)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+c.token)
	return request, nil
}

func (c *SeedClient) Open(ctx context.Context) (SeedInfo, io.ReadCloser, error) {
	request, err := c.request(ctx, http.MethodGet, nil)
	if err != nil {
		return SeedInfo{}, nil, err
	}
	response, err := c.client.Do(request)
	if err != nil {
		return SeedInfo{}, nil, fmt.Errorf("%w: %w", ErrSeedUnavailable, err)
	}
	info := SeedInfo{
		Repository: response.Header.Get("X-Erainfra-Repository"),
		Writable:   response.Header.Get("X-Erainfra-Git-Seed-Writable") == "true",
	}
	if until, err := strconv.ParseInt(response.Header.Get("X-Erainfra-Git-Seed-Refused-Until"), 10, 64); err == nil {
		info.RefusedUntil = time.Unix(until, 0)
	}
	switch response.StatusCode {
	case http.StatusOK:
		if created, err := strconv.ParseInt(response.Header.Get("X-Erainfra-Git-Seed-Created"), 10, 64); err == nil {
			info.Created = time.Unix(created, 0)
		}
		info.Found = true
		if info.Repository == "" {
			_ = response.Body.Close()
			return SeedInfo{}, nil, fmt.Errorf("%w: a seed came back without its repository", ErrSeedUnavailable)
		}
		return info, response.Body, nil
	case http.StatusNotFound:
		_ = response.Body.Close()
		if info.Repository == "" {
			// A 404 with no repository is not the seed endpoint answering: a
			// cache service from before seeds existed says this.
			return SeedInfo{}, nil, fmt.Errorf("%w: the cache service has no git seed endpoint", ErrSeedUnavailable)
		}
		return info, nil, nil
	default:
		_ = response.Body.Close()
		return SeedInfo{}, nil, fmt.Errorf("%w: status %d", ErrSeedUnavailable, response.StatusCode)
	}
}

func (c *SeedClient) Save(ctx context.Context, path string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close() //nolint:errcheck // read-only file; a close error loses nothing
	stat, err := file.Stat()
	if err != nil {
		return err
	}
	request, err := c.request(ctx, http.MethodPut, file)
	if err != nil {
		return err
	}
	request.ContentLength = stat.Size()
	request.Header.Set("Content-Type", "application/x-git-bundle")
	response, err := c.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close() //nolint:errcheck // the status is the answer
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64<<10))
	if response.StatusCode != http.StatusCreated {
		return fmt.Errorf("gitmirror: saving the seed answered %d", response.StatusCode)
	}
	return nil
}
