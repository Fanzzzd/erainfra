package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
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
}

// do sends one request to /api/v1 and returns the raw body of a 2xx answer.
// Bodies are capped: a fleet listing is kilobytes, and a misconfigured URL that
// answers with something enormous should fail rather than fill memory.
func (c *client) do(ctx context.Context, method, path string, query url.Values) ([]byte, error) {
	target := c.base + "/api/v1" + path
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, target, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", c.userAgent)
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("reach %s: %w", c.base, err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return nil, fmt.Errorf("read the answer from %s: %w", c.base, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		failure := &apiError{Status: resp.StatusCode}
		var envelope struct {
			Error struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(body, &envelope) == nil {
			failure.Code, failure.Message = envelope.Error.Code, envelope.Error.Message
		}
		return nil, failure
	}
	return body, nil
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
