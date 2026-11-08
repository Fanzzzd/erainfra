package githubscale

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/Fanzzzd/erainfra/apps/controller/internal/githubapi"
	"github.com/actions/scaleset"
)

const (
	refreshMargin = 5 * time.Minute
	fetchTimeout  = 30 * time.Second
	minRetryDelay = 10 * time.Second
	maxRetryDelay = time.Minute
)

// ErrTokenUnavailable means no unexpired GitHub credential is available. Fetch
// errors are deliberately not included: an upstream error might contain a token.
var ErrTokenUnavailable = errors.New("GitHub credential unavailable")

var errRedirectDenied = errors.New("GitHub redirects are disabled")

// TokenSource caches a short-lived GitHub credential fetched from the control
// plane. Safe for concurrent use. A failed refresh preserves a still-valid token,
// but never extends its expiry. Fetches have a 30-second deadline and failures
// back off from ten seconds to one minute.
type TokenSource struct {
	fetch     func(context.Context) (string, time.Time, error)
	now       func() time.Time
	mu        sync.Mutex
	token     string
	expiresAt time.Time
	retryAt   time.Time
	backoff   time.Duration
	fetching  chan struct{}
}

func NewTokenSource(fetch func(context.Context) (string, time.Time, error)) (*TokenSource, error) {
	if fetch == nil {
		return nil, errors.New("GitHub credential fetch function is required")
	}
	return &TokenSource{fetch: fetch, now: time.Now}, nil
}

// Token refreshes within five minutes of expiry. Each call makes at most one
// fetch; concurrent calls share it, and callers can cancel while waiting.
func (s *TokenSource) Token(ctx context.Context) (string, error) {
	for {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		s.mu.Lock()
		now := s.now()
		if s.token != "" && now.Before(s.expiresAt.Add(-refreshMargin)) {
			token := s.token
			s.mu.Unlock()
			return token, nil
		}
		if s.fetching != nil {
			done := s.fetching
			s.mu.Unlock()
			select {
			case <-ctx.Done():
				return "", ctx.Err()
			case <-done:
				continue
			}
		}
		if now.Before(s.retryAt) {
			token, err := s.currentLocked(now)
			s.mu.Unlock()
			return token, err
		}
		done := make(chan struct{})
		s.fetching = done
		s.mu.Unlock()

		fetchCtx, cancel := context.WithTimeout(ctx, fetchTimeout)
		token, expiresAt, err := s.fetch(fetchCtx)
		if fetchCtx.Err() != nil {
			err = fetchCtx.Err()
		}
		cancel()

		s.mu.Lock()
		now = s.now()
		if err == nil && validToken(token) && expiresAt.After(now) {
			s.token, s.expiresAt = token, expiresAt
			s.backoff = 0
			s.retryAt = now.Add(minRetryDelay)
		} else {
			if s.backoff == 0 {
				s.backoff = minRetryDelay
			} else {
				s.backoff = min(s.backoff*2, maxRetryDelay)
			}
			s.retryAt = now.Add(s.backoff)
		}
		s.fetching = nil
		close(done)
		token, err = s.currentLocked(now)
		s.mu.Unlock()
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		return token, err
	}
}

func validToken(token string) bool {
	return token != "" && !strings.ContainsFunc(token, func(r rune) bool {
		return r < '!' || r > '~'
	})
}

func (s *TokenSource) currentLocked(now time.Time) (string, error) {
	if s.token == "" || !now.Before(s.expiresAt) {
		return "", ErrTokenUnavailable
	}
	return s.token, nil
}

// Run refreshes even when no GitHub requests are active. Call Token once before
// startup to check the initial credential, then run Run with the controller's
// lifetime context. Refresh failures are retried at a bounded rate until canceled;
// Token fails closed if the previous credential expires during an outage.
func (s *TokenSource) Run(ctx context.Context) error {
	for {
		_, _ = s.Token(ctx)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		s.mu.Lock()
		next := s.expiresAt.Add(-refreshMargin)
		if next.Before(s.retryAt) {
			next = s.retryAt
		}
		delay := max(next.Sub(s.now()), time.Millisecond)
		s.mu.Unlock()
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}

// TokenClient keeps one inner scaleset.Client while the GitHub credential rotates.
// Each message session gets its own HTTP client from MessageSessionClient below.
// scaleset v0.5.0 no longer writes to a shared client during an admin-token
// refresh, so this is no longer needed for safety; it keeps a session's
// connections apart from the parent client's.
type TokenClient struct {
	*scaleset.Client
	endpoint *url.URL
	token    func(context.Context) (string, error)
}

// NewClientWithTokenSource preserves Actions credentials and message sessions
// across control-plane credential refreshes. The adapter owns the HTTP client
// and the retry policy, so an HTTP option the caller passes for either is
// replaced; other options apply.
func NewClientWithTokenSource(
	registrationURL string,
	token func(context.Context) (string, error),
	systemInfo scaleset.SystemInfo,
	options ...scaleset.HTTPOption,
) (*TokenClient, error) {
	if token == nil {
		return nil, errors.New("GitHub token source is required")
	}
	endpoint, err := registrationTokenEndpoint(registrationURL)
	if err != nil {
		return nil, err
	}
	options = append(options, tokenHTTPOptions(endpoint, token)...)
	inner, err := scaleset.NewClientWithPersonalAccessToken(scaleset.NewClientWithPersonalAccessTokenConfig{
		GitHubConfigURL: registrationURL,
		// No credential is retained by the library. The transport supplies it
		// only at the exact REST endpoint, on each attempt including retries.
		PersonalAccessToken: "dynamic-token",
		SystemInfo:          systemInfo,
	}, options...)
	if err != nil {
		return nil, err
	}
	return &TokenClient{Client: inner, endpoint: endpoint, token: token}, nil
}

func (c *TokenClient) MessageSessionClient(
	ctx context.Context, scaleSetID int, owner string, options ...scaleset.HTTPOption,
) (*scaleset.MessageSessionClient, error) {
	options = append(options, tokenHTTPOptions(c.endpoint, c.token)...)
	return c.Client.MessageSessionClient(ctx, scaleSetID, owner, options...)
}

func tokenHTTPOptions(endpoint *url.URL, token func(context.Context) (string, error)) []scaleset.HTTPOption {
	return []scaleset.HTTPOption{
		scaleset.WithHTTPClient(tokenHTTPClient(endpoint, token)),
		scaleset.WithRetry(tokenRetryConfig()),
	}
}

// tokenRetryConfig is the SDK's default policy (4 retries, waits capped at
// 30 s), except that a denied redirect and a missing credential end the
// request at once: sending either again cannot succeed.
func tokenRetryConfig() scaleset.RetryConfig {
	retry := scaleset.DefaultRetryConfig()
	retry.Max = 4
	retry.WaitMax = 30 * time.Second
	retry.ShouldRetry = func(ctx context.Context, resp *http.Response, err error) (bool, error) {
		if errors.Is(err, errRedirectDenied) || errors.Is(err, ErrTokenUnavailable) {
			return false, err
		}
		return scaleset.DefaultShouldRetry(ctx, resp, err)
	}
	return retry
}

// tokenHTTPClient is the SDK's default HTTP client with redirects refused and
// the rotating GitHub credential injected by tokenTransport.
func tokenHTTPClient(endpoint *url.URL, token func(context.Context) (string, error)) *http.Client {
	client := scaleset.NewHTTPClient(scaleset.HTTPClientConfig{})
	client.Transport = &tokenTransport{base: client.Transport, endpoint: endpoint, token: token}
	// Never forward credentials, even to another path on the same origin.
	client.CheckRedirect = func(*http.Request, []*http.Request) error {
		return errRedirectDenied
	}
	return client
}

// tokenTransport replaces Authorization with the current GitHub credential on
// a POST to the exact registration-token endpoint, and leaves every other
// request alone: the Actions service and the message queue carry their own
// tokens. With no valid credential the request is not sent at all.
type tokenTransport struct {
	base     http.RoundTripper
	endpoint *url.URL
	token    func(context.Context) (string, error)
}

func (t *tokenTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if !t.matches(req) {
		return t.base.RoundTrip(req)
	}
	value, err := t.token(req.Context())
	if err != nil || !validToken(value) {
		// The source's error is dropped on purpose: an upstream error might
		// contain a token. A RoundTripper must close the body it does not send.
		if req.Body != nil {
			_ = req.Body.Close()
		}
		return nil, ErrTokenUnavailable
	}
	// A RoundTripper must not modify the caller's request, and requests may
	// share a header map.
	authorized := req.Clone(req.Context())
	authorized.Header.Set("Authorization", "Bearer "+value)
	return t.base.RoundTrip(authorized)
}

func (t *tokenTransport) matches(req *http.Request) bool {
	return req.Method == http.MethodPost && req.URL.Scheme == t.endpoint.Scheme &&
		strings.EqualFold(req.URL.Host, t.endpoint.Host) && req.URL.Path == t.endpoint.Path &&
		req.URL.RawQuery == "" && req.URL.User == nil
}

func registrationTokenEndpoint(registrationURL string) (*url.URL, error) {
	u, err := url.Parse(registrationURL)
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") ||
		u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("invalid GitHub registration URL")
	}
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	var path string
	switch {
	case len(parts) == 1 && parts[0] != "":
		path = "/orgs/" + parts[0]
	case len(parts) == 2 && parts[0] != "" && parts[1] != "":
		if strings.EqualFold(parts[0], "enterprises") {
			path = "/enterprises/" + parts[1]
		} else {
			path = "/repos/" + strings.Join(parts, "/")
		}
	default:
		return nil, errors.New("GitHub registration URL must identify an organization, repository, or enterprise")
	}
	base, err := githubapi.APIURL(registrationURL)
	if err != nil {
		return nil, err
	}
	endpoint, err := url.Parse(base)
	if err != nil {
		return nil, err
	}
	endpoint.Path += path + "/actions/runners/registration-token"
	return endpoint, nil
}
