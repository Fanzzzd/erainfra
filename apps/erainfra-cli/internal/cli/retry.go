package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net"
	"net/http"
	"regexp"
	"syscall"
	"time"
)

// A request that failed on the way (a reset connection, an EOF, a timeout) or that the control
// plane answered with a 5xx is sent again, up to maxAttempts in all. The waits between attempts
// grow exponentially from retryBase up to retryCap, each with "equal jitter" (half fixed, half
// random), so CLIs that failed together do not retry together. The three waits between four
// attempts add up to 3.5 to 7 seconds: long enough for a Convex edge to recover from a dropped
// connection, short enough that a real outage still fails fast.
const (
	maxAttempts = 4
	retryBase   = time.Second
	retryCap    = 8 * time.Second
)

// backoff is the wait before attempt number attempt+1, after attempt failed.
func backoff(attempt int) time.Duration {
	ceiling := min(retryCap, retryBase<<(attempt-1))
	half := ceiling / 2
	return half + rand.N(half+1)
}

// idempotent reports whether sending method twice has the effect of sending it once, so the CLI
// may send it again after a lost answer. GET reads. PUT replaces a whole value (roles, labels, a
// set of variables). DELETE is idempotent by RFC 9110 too, but the operator API answers a repeat
// differently (404, or removed=false), so a retry after a lost answer would report a delete
// that happened as one that did not; it is sent once. POST creates (a Node enrollment, a
// registration token, a deploy) and is never sent twice.
func idempotent(method string) bool {
	return method == http.MethodGet || method == http.MethodHead || method == http.MethodPut
}

// uploadStatusError is a non-2xx answer from Convex file storage. It is not an apiError: a 401 or
// 403 from storage means the upload URL lapsed, not that the operator must log in again.
type uploadStatusError struct{ status int }

func (e *uploadStatusError) Error() string {
	return fmt.Sprintf("upload the source: HTTP %d", e.status)
}

// transient reports whether err may go away if the same request is sent again: the connection
// broke or timed out, or the server answered 5xx. A 4xx is an answer about the request itself
// and is not retried; neither is a TLS or certificate failure, nor a name that does not resolve.
func transient(err error) bool {
	var failure *apiError
	if errors.As(err, &failure) {
		return failure.Status >= 500 && failure.Status != http.StatusNotImplemented
	}
	var storage *uploadStatusError
	if errors.As(err, &storage) {
		return storage.status >= 500 && storage.status != http.StatusNotImplemented
	}
	var dns *net.DNSError
	if errors.As(err, &dns) {
		return dns.IsTimeout || dns.IsTemporary
	}
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) ||
		errors.Is(err, syscall.ECONNRESET) || errors.Is(err, syscall.ECONNABORTED) ||
		errors.Is(err, syscall.ECONNREFUSED) || errors.Is(err, syscall.EPIPE) {
		return true
	}
	var netErr net.Error
	return errors.As(err, &netErr) && netErr.Timeout()
}

// retrying runs try until it succeeds, fails with an error that is not transient, or has run
// maxAttempts times. It stops at once when ctx ends: the operator pressed Ctrl-C, or the command
// ran out of time. Each retry is announced on c.warn, so a slow command says why it is slow.
func (c *client) retrying(ctx context.Context, what string, try func() error) error {
	for attempt := 1; ; attempt++ {
		err := try()
		if err == nil || ctx.Err() != nil || !transient(err) {
			return err
		}
		if attempt == maxAttempts {
			return fmt.Errorf("%w (failed %d times)", err, attempt)
		}
		wait := backoff(attempt)
		if c.warn != nil {
			_, _ = fmt.Fprintf(c.warn, "erainfra: %s failed: %s; trying again in %s (attempt %d of %d)\n",
				what, redactSecrets(err.Error()), wait.Round(10*time.Millisecond), attempt+1, maxAttempts)
		}
		if c.sleep != nil {
			if sleepErr := c.sleep(ctx, wait); sleepErr != nil {
				return err
			}
		}
	}
}

// tokenQuery matches the value of a token= query parameter. Convex file storage puts the upload
// capability there (…/api/storage/upload?token=…), and Go's HTTP client prints the whole URL in
// its errors ("Post \"https://…?token=…\": EOF").
var tokenQuery = regexp.MustCompile(`([?&](?:access_)?token=)[^&\s"'<>]+`)

// redactSecrets removes token query values from text the CLI prints.
func redactSecrets(s string) string {
	return tokenQuery.ReplaceAllString(s, "${1}REDACTED")
}
