package gitmirror

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// authorize asks GitHub whether this client's credential can read repository
// now, with the same ref advertisement request git opens every fetch with.
// It is separate from the mirror's own fetch because that fetch cannot be
// relied on to ask: when every wanted object is already in the mirror, git
// completes a fetch by object name without contacting the remote at all. So
// without this, a client GitHub would refuse could read whatever the seed
// holds.
func (s *Service) authorize(ctx context.Context, repository, authorization string) error {
	if s.recentlyAuthorized(repository, authorization) {
		return nil
	}
	target := *s.config.GitHub
	target.Path = "/" + repository + "/info/refs"
	target.RawQuery = "service=git-upload-pack"
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return err
	}
	if authorization != "" {
		request.Header.Set("Authorization", authorization)
	}
	request.Header.Set("Git-Protocol", "version=2")
	request.Header.Set("User-Agent", "git/erainfra-git-mirror")
	response, err := s.config.Transport.RoundTrip(request)
	if err != nil {
		return err
	}
	defer response.Body.Close() //nolint:errcheck // only the status is read
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 1<<20))
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("GitHub answered %d", response.StatusCode)
	}
	if contentType := response.Header.Get("Content-Type"); contentType != "application/x-git-upload-pack-advertisement" {
		return fmt.Errorf("GitHub answered %q, not a ref advertisement", contentType)
	}
	s.rememberAuthorized(repository, authorization)
	return nil
}

// authorizedFor is how long a ref advertisement GitHub granted a credential
// stands in for asking again. It covers the fetches of one git command, which
// follow its ref listing within milliseconds; a credential GitHub has revoked
// stops working on the mirror at most this long after it stops working on
// GitHub.
const authorizedFor = time.Minute

func authorizationKey(repository, authorization string) string {
	digest := sha256.Sum256([]byte(authorization))
	return strings.ToLower(repository) + "\x00" + hex.EncodeToString(digest[:])
}

func (s *Service) rememberAuthorized(repository, authorization string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.authorized == nil {
		s.authorized = map[string]time.Time{}
	}
	now := s.config.Now()
	for key, at := range s.authorized {
		if now.Sub(at) >= authorizedFor {
			delete(s.authorized, key)
		}
	}
	s.authorized[authorizationKey(repository, authorization)] = now
}

func (s *Service) recentlyAuthorized(repository, authorization string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	at, ok := s.authorized[authorizationKey(repository, authorization)]
	return ok && s.config.Now().Sub(at) < authorizedFor
}
