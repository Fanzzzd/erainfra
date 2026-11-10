package jobhint

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Path is the cache service endpoint that takes a hint.
const Path = "/_erainfra-cache-job-hint"

const (
	// DefaultBudget bounds all of Send's attempts. Past it the controller's
	// JobStarted facts are about to land anyway, so a hint stops being worth
	// sending.
	DefaultBudget = 20 * time.Second
	// DefaultBackoff is the wait before the first retry; each later wait
	// doubles, so a 20 s budget holds about five attempts.
	DefaultBackoff = 500 * time.Millisecond
	// attemptTimeout bounds one request, so a cache service that accepts the
	// connection and never answers still leaves room for a retry.
	attemptTimeout = 5 * time.Second
)

// Sender posts hints to the cache service with the runner bearer.
type Sender struct {
	endpoint string
	token    string
	client   *http.Client
	// Budget and Backoff are DefaultBudget and DefaultBackoff unless set.
	Budget  time.Duration
	Backoff time.Duration
}

// NewSender builds a Sender for the cache service at baseURL. token is the
// runner bearer the interceptor already presents, which is what the cache
// service resolves the runner from.
func NewSender(baseURL, token string) (*Sender, error) {
	parsed, err := url.Parse(baseURL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return nil, fmt.Errorf("jobhint: cache service URL %q is not an absolute http(s) URL", baseURL)
	}
	if token == "" {
		return nil, errors.New("jobhint: a runner token is required")
	}
	return &Sender{
		endpoint: strings.TrimSuffix(baseURL, "/") + Path,
		token:    token,
		client: &http.Client{
			Transport: http.DefaultTransport.(*http.Transport).Clone(),
			// A redirect would carry the bearer somewhere this guest was not
			// told to send it. The endpoint never redirects; one is an error.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
	}, nil
}

// errPermanent marks an answer a retry cannot change.
var errPermanent = errors.New("refused")

// Send posts the hint once, retrying a transport error or a 5xx with
// doubling backoff until Budget runs out. A 4xx ends it at once: the cache
// service has read the claim and said no, and asking again says the same.
func (s *Sender) Send(ctx context.Context, hint Hint) error {
	if err := hint.Validate(); err != nil {
		return err
	}
	body, err := json.Marshal(hint)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, cmp.Or(s.Budget, DefaultBudget))
	defer cancel()
	backoff := cmp.Or(s.Backoff, DefaultBackoff)
	for {
		err := s.post(ctx, body)
		if err == nil || errors.Is(err, errPermanent) {
			return err
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("%w (gave up: %w)", err, ctx.Err())
		case <-time.After(backoff):
		}
		backoff *= 2
	}
}

func (s *Sender) post(ctx context.Context, body []byte) error {
	ctx, cancel := context.WithTimeout(ctx, attemptTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, s.endpoint, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("%w: %w", errPermanent, err)
	}
	request.Header.Set("Authorization", "Bearer "+s.token)
	request.Header.Set("Content-Type", "application/json")
	response, err := s.client.Do(request)
	if err != nil {
		return err
	}
	// Drain a little so the connection can be reused by a retry; the body is
	// never logged, since it is the cache service's and may echo the claim.
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4<<10))
	_ = response.Body.Close()
	switch {
	case response.StatusCode >= 200 && response.StatusCode < 300:
		return nil
	case response.StatusCode >= 500:
		return fmt.Errorf("cache service answered %s", response.Status)
	default:
		return fmt.Errorf("%w: cache service answered %s", errPermanent, response.Status)
	}
}

// Config is what Run needs from the guest.
type Config struct {
	DiagDir         string
	CacheServiceURL string
	RunnerToken     string
	Logf            func(format string, args ...any)
}

// Run watches for the job, sends its hint once, and logs one line either
// way. It is meant to run in its own goroutine for the life of the runner:
// it returns quietly when ctx ends before a job starts, and nothing it does
// can fail or delay the job.
func Run(ctx context.Context, config Config) {
	sender, err := NewSender(config.CacheServiceURL, config.RunnerToken)
	if err != nil {
		config.Logf("job hint not sent: %v", err)
		return
	}
	hint, err := Watcher{Dir: config.DiagDir}.Watch(ctx)
	if errors.Is(err, ErrNoJob) {
		return
	}
	if err != nil {
		config.Logf("job hint not sent: %v", err)
		return
	}
	if err := sender.Send(ctx, hint); err != nil {
		config.Logf("job hint for %s run %d attempt %d not sent: %v", hint.Repository, hint.RunID, hint.RunAttempt, err)
		return
	}
	config.Logf("job hint sent: %s run %d attempt %d", hint.Repository, hint.RunID, hint.RunAttempt)
}
