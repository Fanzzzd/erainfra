package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// apiError is a non-2xx answer from the operator API.
type apiError struct {
	Status  int
	Code    string
	Message string
}

func (e *apiError) Error() string {
	if e.Message == "" {
		return fmt.Sprintf("the control plane answered HTTP %d", e.Status)
	}
	return fmt.Sprintf("%s (HTTP %d)", e.Message, e.Status)
}

type client struct {
	http      *http.Client
	base      string
	token     string
	userAgent string
	// sleep waits between retries; warn is where a retry is announced. Either may be nil.
	sleep func(ctx context.Context, d time.Duration) error
	warn  io.Writer
}

// do sends one request to /api/v1 and returns the raw body of a 2xx answer.
// Bodies are capped: a fleet listing is kilobytes, and a misconfigured URL that
// answers with something enormous should fail rather than fill memory.
func (c *client) do(ctx context.Context, method, path string, query url.Values) ([]byte, error) {
	return c.send(ctx, method, path, query, nil)
}

// send is do with a JSON request body; a nil body sends none.
func (c *client) send(ctx context.Context, method, path string, query url.Values, body any) ([]byte, error) {
	reply, _, err := c.exchange(ctx, method, path, query, body)
	return reply, err
}

// poll is a GET that also returns the 2xx status, for a route that answers 202 until it is ready.
func (c *client) poll(ctx context.Context, path string) ([]byte, int, error) {
	return c.exchange(ctx, http.MethodGet, path, nil, nil)
}

// exchange sends one request, and sends an idempotent one again after a transient failure.
func (c *client) exchange(ctx context.Context, method, path string, query url.Values, body any) ([]byte, int, error) {
	if !idempotent(method) {
		return c.exchangeOnce(ctx, method, path, query, body)
	}
	var reply []byte
	var status int
	err := c.retrying(ctx, method+" "+path, func() error {
		var err error
		reply, status, err = c.exchangeOnce(ctx, method, path, query, body)
		return err
	})
	return reply, status, err
}

func (c *client) exchangeOnce(ctx context.Context, method, path string, query url.Values, body any) ([]byte, int, error) {
	target := c.base + "/api/v1" + path
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, 0, err
		}
		reader = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, target, reader)
	if err != nil {
		return nil, 0, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", c.userAgent)
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, 0, fmt.Errorf("reach %s: %w", c.base, err)
	}
	defer func() { _ = resp.Body.Close() }()
	reply, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return nil, 0, fmt.Errorf("read the answer from %s: %w", c.base, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, resp.StatusCode, failureOf(resp.StatusCode, reply)
	}
	return reply, resp.StatusCode, nil
}

func failureOf(status int, reply []byte) *apiError {
	failure := &apiError{Status: status}
	var envelope struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(reply, &envelope) == nil {
		failure.Code, failure.Message = envelope.Error.Code, envelope.Error.Message
	}
	return failure
}

// uploadSource stores a source archive in Convex file storage and returns its storage ID. Each
// attempt asks the control plane for a new upload URL first. A Convex upload URL is a one-use
// capability, and after a lost answer the CLI cannot tell whether the last one was used, so
// reusing it could end in a 4xx that hides the real cause. Minting a URL only writes an audit
// row. An upload whose answer was lost leaves a stored file that no deploy points at.
func (c *client) uploadSource(ctx context.Context, archive []byte) (string, error) {
	var storageID string
	err := c.retrying(ctx, "the source upload", func() error {
		body, _, err := c.exchangeOnce(ctx, http.MethodPost, "/deployments/uploads", nil, map[string]string{})
		if err != nil {
			return err
		}
		var slot struct {
			UploadURL string `json:"uploadUrl"`
		}
		if err := decode(body, &slot); err != nil {
			return err
		}
		storageID, err = c.upload(ctx, slot.UploadURL, archive)
		return err
	})
	return storageID, err
}

// upload sends a source archive to the one-use upload URL the control plane issued. That URL is
// a capability on Convex file storage, so the API token is never sent with it; it must be HTTPS.
// Its token= query is the capability itself, so no error from here quotes the URL.
func (c *client) upload(ctx context.Context, uploadURL string, archive []byte) (string, error) {
	target, err := url.Parse(uploadURL)
	if err != nil || target.Scheme != "https" || target.Host == "" {
		return "", fmt.Errorf("the control plane issued an upload URL that is not HTTPS")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target.String(), bytes.NewReader(archive))
	if err != nil {
		return "", fmt.Errorf("build the upload request to %s: %w", target.Host, withoutURL(err))
	}
	req.Header.Set("Content-Type", "application/gzip")
	req.Header.Set("User-Agent", c.userAgent)
	// An archive of up to 256 MiB outlasts the API's 30-second timeout on a slow uplink; the
	// context still cancels it.
	uploader := *c.http
	uploader.Timeout = 30 * time.Minute
	resp, err := uploader.Do(req)
	if err != nil {
		return "", fmt.Errorf("upload the source to %s: %w", target.Host, withoutURL(err))
	}
	defer func() { _ = resp.Body.Close() }()
	reply, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", fmt.Errorf("read the upload answer: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return "", &uploadStatusError{status: resp.StatusCode}
	}
	var stored struct {
		StorageID string `json:"storageId"`
	}
	if json.Unmarshal(reply, &stored) != nil || stored.StorageID == "" {
		return "", fmt.Errorf("the upload answered without a storageId")
	}
	return stored.StorageID, nil
}

// withoutURL unwraps the *url.Error the HTTP client returns, whose text is the method, the full
// URL and the cause, to just the cause. errors.Is and errors.As still reach the cause.
func withoutURL(err error) error {
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		return urlErr.Err
	}
	return err
}

func (c *client) getJSON(ctx context.Context, path string, query url.Values, into any) error {
	body, err := c.do(ctx, http.MethodGet, path, query)
	if err != nil {
		return err
	}
	return decode(body, into)
}

func decode(body []byte, into any) error {
	if err := json.Unmarshal(body, into); err != nil {
		return fmt.Errorf("the control plane answered with something that is not the operator API: %w", err)
	}
	return nil
}

func isAuthFailure(err error) bool {
	var failure *apiError
	return errors.Is(err, errNotLoggedIn) || errors.Is(err, errIncompleteEnvironment) ||
		(errors.As(err, &failure) && (failure.Status == http.StatusUnauthorized || failure.Status == http.StatusForbidden))
}
