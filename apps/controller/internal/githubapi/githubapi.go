// Package githubapi reads the few GitHub REST facts the controller needs beyond
// what the scale-set message carries: a job's workflow run, its repository's
// default branch, and whether a ref exists.
//
// The scale-set client authenticates the same way but exposes no REST access and
// keeps no installation token, so this package carries its own small client over
// the controller's existing credentials (a GitHub App installation or a PAT). An
// App's installation token is cached until shortly before it expires, and every
// lookup is memoized for a short time: a matrix starts many jobs from one run,
// and they should cost GitHub one request, not one each.
package githubapi

import (
	"context"
	"crypto/rsa"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/actions/scaleset"
	"github.com/golang-jwt/jwt/v4"
)

const (
	// lookupTTL is how long a workflow run, a default branch, or a ref answer is
	// reused. The facts read from a run (event, head branch, head repository, the
	// pull request it belongs to) do not change while it runs; ten minutes covers
	// a matrix whose jobs start in waves without holding a stale answer for long.
	lookupTTL = 10 * time.Minute
	// lookupEntries bounds each memo. It is far above the number of runs a Profile
	// starts in ten minutes, so it only matters if something goes wrong.
	lookupEntries = 512
	// tokenRefreshMargin renews an installation token this long before GitHub
	// says it expires (GitHub issues them for an hour).
	tokenRefreshMargin = 5 * time.Minute
	// maxResponseBytes caps a decoded response. A workflow run is a few KiB; the
	// cap only stops a misbehaving endpoint from being read without bound.
	maxResponseBytes = 1 << 20
)

// ErrNotFound is GitHub answering 404.
var ErrNotFound = errors.New("not found on GitHub")

// Config is how to reach GitHub and as whom. Exactly one of Token and App is set,
// as for the scale-set client.
type Config struct {
	// APIURL is the REST base, for example https://api.github.com. Use APIURL to
	// derive it from the scale-set registration URL.
	APIURL string
	Token  string
	App    *scaleset.GitHubAppAuth
	// HTTPClient is optional. Requests carry their own deadlines from the caller's
	// context, so the default client has no overall timeout of its own.
	HTTPClient *http.Client
}

// Client is a GitHub REST client. Safe for concurrent use.
type Client struct {
	apiURL string
	token  string
	app    *scaleset.GitHubAppAuth
	key    *rsa.PrivateKey
	http   *http.Client
	now    func() time.Time

	tokenMu      sync.Mutex
	installToken string
	installUntil time.Time

	runs     *memo[WorkflowRun]
	branches *memo[string]
	refs     *memo[bool]
}

// New builds a client. An App's private key is parsed here so a bad key fails at
// startup rather than at the first job.
func New(config Config) (*Client, error) {
	apiURL := strings.TrimRight(strings.TrimSpace(config.APIURL), "/")
	if apiURL == "" {
		return nil, errors.New("GitHub API URL is required")
	}
	if (config.Token == "") == (config.App == nil) {
		return nil, errors.New("exactly one of a GitHub token or a GitHub App is required")
	}
	client := &Client{
		apiURL: apiURL,
		token:  config.Token,
		app:    config.App,
		http:   config.HTTPClient,
		now:    time.Now,
	}
	if client.http == nil {
		client.http = &http.Client{}
	}
	if config.App != nil {
		if err := config.App.Validate(); err != nil {
			return nil, fmt.Errorf("invalid GitHub App credentials: %w", err)
		}
		key, err := jwt.ParseRSAPrivateKeyFromPEM([]byte(config.App.PrivateKey))
		if err != nil {
			return nil, fmt.Errorf("parse GitHub App private key: %w", err)
		}
		client.key = key
	}
	clock := func() time.Time { return client.now() }
	client.runs = newMemo[WorkflowRun](lookupTTL, lookupEntries, clock)
	client.branches = newMemo[string](lookupTTL, lookupEntries, clock)
	client.refs = newMemo[bool](lookupTTL, lookupEntries, clock)
	return client, nil
}

// APIURL derives the REST base from a scale-set registration URL the same way the
// scale-set client does: github.com and GHE.com tenants use the api. host, and a
// GitHub Enterprise Server serves the API under /api/v3 on its own host.
func APIURL(registrationURL string) (string, error) {
	parsed, err := url.Parse(strings.Trim(strings.TrimSpace(registrationURL), "/"))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", fmt.Errorf("invalid GitHub registration URL %q", registrationURL)
	}
	host := parsed.Host
	_, forceGHES := os.LookupEnv("GITHUB_ACTIONS_FORCE_GHES")
	hosted := !forceGHES && (strings.EqualFold(host, "github.com") ||
		strings.EqualFold(host, "www.github.com") ||
		strings.EqualFold(host, "github.localhost") ||
		strings.HasSuffix(strings.ToLower(host), ".ghe.com"))
	if !hosted {
		return parsed.Scheme + "://" + host + "/api/v3", nil
	}
	if strings.EqualFold(host, "www.github.com") {
		host = "github.com"
	}
	return parsed.Scheme + "://api." + host, nil
}

// WorkflowRun is the part of GET /repos/{owner}/{repo}/actions/runs/{run_id} the
// cache scope is derived from.
type WorkflowRun struct {
	ID         int64
	Event      string
	HeadBranch string
	HeadSHA    string
	// Path is the run's top-level workflow file, without any "@ref" suffix.
	Path       string
	Repository Repository
	// HeadRepository is nil when GitHub reports none.
	HeadRepository *Repository
	// PullRequests is what GitHub lists for the run. It can include pull requests
	// whose base is another repository (a fork's own pull requests from the same
	// branch), and it is empty for a pull request from a fork, so it has to be
	// matched rather than indexed.
	PullRequests []PullRequest
}

// Repository identifies a repository by its stable ID and its owner/name.
type Repository struct {
	ID       int64
	FullName string
}

// PullRequest is the minimal pull request a workflow run lists.
type PullRequest struct {
	Number     int
	HeadRef    string
	HeadSHA    string
	HeadRepoID int64
	BaseRef    string
	BaseRepoID int64
}

// WorkflowRun fetches one run of repository ("owner/name").
func (c *Client) WorkflowRun(ctx context.Context, repository string, runID int64) (WorkflowRun, error) {
	path, err := repoPath(repository)
	if err != nil {
		return WorkflowRun{}, err
	}
	if runID <= 0 {
		return WorkflowRun{}, fmt.Errorf("invalid workflow run ID %d", runID)
	}
	key := strings.ToLower(repository) + "#" + strconv.FormatInt(runID, 10)
	return c.runs.get(ctx, key, func() (WorkflowRun, error) {
		var body runResponse
		if err := c.getJSON(ctx, path+"/actions/runs/"+strconv.FormatInt(runID, 10), &body); err != nil {
			return WorkflowRun{}, fmt.Errorf("get workflow run %d: %w", runID, err)
		}
		return body.workflowRun(), nil
	})
}

// DefaultBranch returns the repository's default branch name, for example "main".
// The workflow run's repository object does not carry it.
func (c *Client) DefaultBranch(ctx context.Context, repository string) (string, error) {
	path, err := repoPath(repository)
	if err != nil {
		return "", err
	}
	return c.branches.get(ctx, strings.ToLower(repository), func() (string, error) {
		var body struct {
			DefaultBranch string `json:"default_branch"`
		}
		if err := c.getJSON(ctx, path, &body); err != nil {
			return "", fmt.Errorf("get repository: %w", err)
		}
		if strings.TrimSpace(body.DefaultBranch) == "" {
			return "", errors.New("GitHub reported no default branch")
		}
		return body.DefaultBranch, nil
	})
}

// RefExists reports whether a fully named ref exists, ref being "heads/<branch>"
// or "tags/<tag>". GitHub's single-ref endpoint matches exactly, so a prefix of
// another ref is not mistaken for it.
func (c *Client) RefExists(ctx context.Context, repository, ref string) (bool, error) {
	path, err := repoPath(repository)
	if err != nil {
		return false, err
	}
	if !strings.HasPrefix(ref, "heads/") && !strings.HasPrefix(ref, "tags/") {
		return false, fmt.Errorf("ref %q is neither heads/ nor tags/", ref)
	}
	segments := strings.Split(ref, "/")
	for index, segment := range segments {
		if segment == "" {
			return false, fmt.Errorf("invalid ref %q", ref)
		}
		segments[index] = url.PathEscape(segment)
	}
	return c.refs.get(ctx, strings.ToLower(repository)+"#"+ref, func() (bool, error) {
		var body json.RawMessage
		err := c.getJSON(ctx, path+"/git/ref/"+strings.Join(segments, "/"), &body)
		if errors.Is(err, ErrNotFound) {
			return false, nil
		}
		if err != nil {
			return false, fmt.Errorf("get ref %q: %w", ref, err)
		}
		return true, nil
	})
}

func repoPath(repository string) (string, error) {
	owner, name, found := strings.Cut(strings.TrimSpace(repository), "/")
	if !found || owner == "" || name == "" || strings.Contains(name, "/") {
		return "", fmt.Errorf("repository %q is not owner/name", repository)
	}
	return "/repos/" + url.PathEscape(owner) + "/" + url.PathEscape(name), nil
}

func (c *Client) getJSON(ctx context.Context, path string, into any) error {
	authorization, err := c.authorization(ctx)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.apiURL+path, nil)
	if err != nil {
		return err
	}
	setHeaders(req, authorization)
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	body := io.LimitReader(resp.Body, maxResponseBytes)
	switch {
	case resp.StatusCode == http.StatusNotFound:
		_, _ = io.Copy(io.Discard, body)
		return ErrNotFound
	case resp.StatusCode == http.StatusUnauthorized && c.app != nil:
		// A revoked or rotated installation token: drop it so the next lookup
		// mints a fresh one instead of failing until it would have expired.
		c.forgetInstallationToken()
		_, _ = io.Copy(io.Discard, body)
		return fmt.Errorf("GitHub returned %d", resp.StatusCode)
	case resp.StatusCode != http.StatusOK:
		_, _ = io.Copy(io.Discard, body)
		return fmt.Errorf("GitHub returned %d", resp.StatusCode)
	}
	if err := json.NewDecoder(body).Decode(into); err != nil {
		return fmt.Errorf("decode GitHub response: %w", err)
	}
	return nil
}

func setHeaders(req *http.Request, authorization string) {
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	req.Header.Set("User-Agent", "erainfra-controller")
	req.Header.Set("Authorization", authorization)
}

// authorization returns the Authorization header value: the PAT, or a cached
// installation token minted from the App's JWT when the cached one is near expiry.
func (c *Client) authorization(ctx context.Context) (string, error) {
	if c.app == nil {
		return "Bearer " + c.token, nil
	}
	c.tokenMu.Lock()
	defer c.tokenMu.Unlock()
	if c.installToken != "" && c.now().Before(c.installUntil.Add(-tokenRefreshMargin)) {
		return "Bearer " + c.installToken, nil
	}
	token, expires, err := c.mintInstallationToken(ctx)
	if err != nil {
		return "", err
	}
	c.installToken, c.installUntil = token, expires
	return "Bearer " + token, nil
}

func (c *Client) forgetInstallationToken() {
	c.tokenMu.Lock()
	defer c.tokenMu.Unlock()
	c.installToken = ""
}

func (c *Client) mintInstallationToken(ctx context.Context) (string, time.Time, error) {
	// The same JWT shape the scale-set client signs: backdated a minute for clock
	// skew, under GitHub's ten-minute ceiling.
	issued := c.now().Add(-time.Minute)
	signed, err := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.RegisteredClaims{
		IssuedAt:  jwt.NewNumericDate(issued),
		ExpiresAt: jwt.NewNumericDate(issued.Add(9 * time.Minute)),
		Issuer:    c.app.ClientID,
	}).SignedString(c.key)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("sign GitHub App JWT: %w", err)
	}
	endpoint := c.apiURL + "/app/installations/" + strconv.FormatInt(c.app.InstallationID, 10) + "/access_tokens"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, nil)
	if err != nil {
		return "", time.Time{}, err
	}
	setHeaders(req, "Bearer "+signed)
	resp, err := c.http.Do(req)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("mint installation token: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	body := io.LimitReader(resp.Body, maxResponseBytes)
	if resp.StatusCode != http.StatusCreated {
		_, _ = io.Copy(io.Discard, body)
		return "", time.Time{}, fmt.Errorf("mint installation token: GitHub returned %d", resp.StatusCode)
	}
	var token struct {
		Token     string    `json:"token"`
		ExpiresAt time.Time `json:"expires_at"`
	}
	if err := json.NewDecoder(body).Decode(&token); err != nil {
		return "", time.Time{}, fmt.Errorf("decode installation token: %w", err)
	}
	if token.Token == "" || token.ExpiresAt.IsZero() {
		return "", time.Time{}, errors.New("GitHub returned an empty installation token")
	}
	return token.Token, token.ExpiresAt, nil
}

type runResponse struct {
	ID             int64         `json:"id"`
	Event          string        `json:"event"`
	HeadBranch     string        `json:"head_branch"`
	HeadSHA        string        `json:"head_sha"`
	Path           string        `json:"path"`
	Repository     *repoResponse `json:"repository"`
	HeadRepository *repoResponse `json:"head_repository"`
	PullRequests   []struct {
		Number int        `json:"number"`
		Head   refPointer `json:"head"`
		Base   refPointer `json:"base"`
	} `json:"pull_requests"`
}

type repoResponse struct {
	ID       int64  `json:"id"`
	FullName string `json:"full_name"`
}

type refPointer struct {
	Ref  string `json:"ref"`
	SHA  string `json:"sha"`
	Repo struct {
		ID int64 `json:"id"`
	} `json:"repo"`
}

func (r runResponse) workflowRun() WorkflowRun {
	path, _, _ := strings.Cut(r.Path, "@")
	run := WorkflowRun{
		ID:         r.ID,
		Event:      r.Event,
		HeadBranch: r.HeadBranch,
		HeadSHA:    r.HeadSHA,
		Path:       path,
	}
	if r.Repository != nil {
		run.Repository = Repository{ID: r.Repository.ID, FullName: r.Repository.FullName}
	}
	if r.HeadRepository != nil {
		run.HeadRepository = &Repository{ID: r.HeadRepository.ID, FullName: r.HeadRepository.FullName}
	}
	for _, pr := range r.PullRequests {
		run.PullRequests = append(run.PullRequests, PullRequest{
			Number:     pr.Number,
			HeadRef:    pr.Head.Ref,
			HeadSHA:    pr.Head.SHA,
			HeadRepoID: pr.Head.Repo.ID,
			BaseRef:    pr.Base.Ref,
			BaseRepoID: pr.Base.Repo.ID,
		})
	}
	return run
}

// memo is a small TTL cache with a size bound that also collapses concurrent
// lookups of the same key into one request. Failures are not remembered: a
// timeout should not turn into ten minutes of cold caches.
type memo[V any] struct {
	mu      sync.Mutex
	ttl     time.Duration
	max     int
	now     func() time.Time
	entries map[string]*memoEntry[V]
}

type memoEntry[V any] struct {
	done    chan struct{}
	value   V
	err     error
	expires time.Time
}

func newMemo[V any](ttl time.Duration, maxEntries int, now func() time.Time) *memo[V] {
	return &memo[V]{ttl: ttl, max: maxEntries, now: now, entries: make(map[string]*memoEntry[V])}
}

func (m *memo[V]) get(ctx context.Context, key string, fetch func() (V, error)) (V, error) {
	m.mu.Lock()
	if entry, ok := m.entries[key]; ok {
		select {
		case <-entry.done:
			if m.now().Before(entry.expires) {
				m.mu.Unlock()
				return entry.value, nil
			}
			delete(m.entries, key)
		default:
			m.mu.Unlock()
			select {
			case <-entry.done:
				return entry.value, entry.err
			case <-ctx.Done():
				var zero V
				return zero, ctx.Err()
			}
		}
	}
	entry := &memoEntry[V]{done: make(chan struct{})}
	m.entries[key] = entry
	m.evictLocked()
	m.mu.Unlock()

	value, err := fetch()

	m.mu.Lock()
	entry.value, entry.err = value, err
	entry.expires = m.now().Add(m.ttl)
	if err != nil && m.entries[key] == entry {
		delete(m.entries, key)
	}
	m.mu.Unlock()
	close(entry.done)
	return value, err
}

// evictLocked keeps the memo at its bound: expired entries go first, then the
// ones closest to expiry. Lookups still in flight are never evicted.
func (m *memo[V]) evictLocked() {
	if len(m.entries) <= m.max {
		return
	}
	now := m.now()
	for key, entry := range m.entries {
		if isDone(entry) && !now.Before(entry.expires) {
			delete(m.entries, key)
		}
	}
	for len(m.entries) > m.max {
		oldestKey := ""
		var oldest time.Time
		for key, entry := range m.entries {
			if !isDone(entry) {
				continue
			}
			if oldestKey == "" || entry.expires.Before(oldest) {
				oldestKey, oldest = key, entry.expires
			}
		}
		if oldestKey == "" {
			return
		}
		delete(m.entries, oldestKey)
	}
}

func isDone[V any](entry *memoEntry[V]) bool {
	select {
	case <-entry.done:
		return true
	default:
		return false
	}
}
