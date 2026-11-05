package githubscale

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/actions/scaleset"
	"github.com/golang-jwt/jwt/v4"
)

func mustTokenSource(t *testing.T, fetch func(context.Context) (string, time.Time, error)) *TokenSource {
	t.Helper()
	source, err := NewTokenSource(fetch)
	if err != nil {
		t.Fatal(err)
	}
	return source
}

func TestTokenSourceRefreshAndFailureExpiry(t *testing.T) {
	now := time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)
	var attempts int
	var unavailable bool
	source := mustTokenSource(t, func(ctx context.Context) (string, time.Time, error) {
		if deadline, ok := ctx.Deadline(); !ok || time.Until(deadline) > fetchTimeout {
			t.Error("fetch has no bounded deadline")
		}
		attempts++
		if unavailable {
			return "", time.Time{}, errors.New("upstream body contains secret-ghs")
		}
		return fmt.Sprintf("token-%d", attempts), now.Add(time.Hour), nil
	})
	source.now = func() time.Time { return now }
	get := func(want string) {
		t.Helper()
		token, err := source.Token(t.Context())
		if err != nil || token != want {
			t.Fatalf("Token = %q, %v; want %q", token, err, want)
		}
	}
	get("token-1")
	now = now.Add(55*time.Minute - time.Nanosecond)
	get("token-1")
	if attempts != 1 {
		t.Fatal("refreshed before refresh margin")
	}
	now = now.Add(time.Nanosecond)
	get("token-2")
	if attempts != 2 {
		t.Fatal("did not refresh at five minutes remaining")
	}
	unavailable = true
	now = now.Add(55 * time.Minute)
	get("token-2")
	for range 20 {
		get("token-2")
	}
	if attempts != 3 {
		t.Fatalf("refresh failure was not throttled: %d attempts", attempts)
	}
	for _, delay := range []time.Duration{10, 20, 40, 60, 60} {
		now = now.Add(delay * time.Second)
		get("token-2")
	}
	if source.backoff != maxRetryDelay {
		t.Fatalf("backoff = %v", source.backoff)
	}
	now = now.Add(5 * time.Minute)
	token, err := source.Token(t.Context())
	if token != "" || !errors.Is(err, ErrTokenUnavailable) || strings.Contains(err.Error(), "secret-ghs") {
		t.Fatalf("expired Token = %q, %v", token, err)
	}
	unavailable = false
	now = now.Add(maxRetryDelay)
	get(fmt.Sprintf("token-%d", attempts+1))
	if source.backoff != 0 {
		t.Fatal("successful refresh did not reset backoff")
	}
}

func TestTokenSourceRejectsInvalidFetches(t *testing.T) {
	if _, err := NewTokenSource(nil); err == nil {
		t.Fatal("accepted nil fetch")
	}
	for _, value := range []struct {
		name, token string
		expires     time.Time
	}{
		{name: "empty", expires: time.Now().Add(time.Hour)},
		{name: "expired", token: "secret", expires: time.Now().Add(-time.Second)},
		{name: "no expiry", token: "secret"},
		{name: "header injection", token: "secret\r\nX-Secret: yes", expires: time.Now().Add(time.Hour)},
	} {
		t.Run(value.name, func(t *testing.T) {
			source := mustTokenSource(t, func(context.Context) (string, time.Time, error) {
				return value.token, value.expires, nil
			})
			if token, err := source.Token(t.Context()); token != "" || !errors.Is(err, ErrTokenUnavailable) {
				t.Fatalf("Token = %q, %v", token, err)
			}
		})
	}
}

func TestTokenSourceConcurrentFetchAndCanceledWaiter(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	source := mustTokenSource(t, func(context.Context) (string, time.Time, error) {
		calls.Add(1)
		close(started)
		<-release
		return "shared-token", time.Now().Add(time.Hour), nil
	})
	var group sync.WaitGroup
	for range 20 {
		group.Go(func() {
			token, err := source.Token(t.Context())
			if err != nil || token != "shared-token" {
				t.Errorf("Token = %q, %v", token, err)
			}
		})
	}
	<-started
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := source.Token(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled waiter = %v", err)
	}
	close(release)
	group.Wait()
	if calls.Load() != 1 {
		t.Fatalf("made %d concurrent fetches", calls.Load())
	}
}

func TestTokenSourceRunProactivelyRefreshesAndBoundsFetch(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var calls atomic.Int32
		source := mustTokenSource(t, func(context.Context) (string, time.Time, error) {
			n := calls.Add(1)
			return fmt.Sprintf("token-%d", n), time.Now().Add(time.Hour), nil
		})
		ctx, cancel := context.WithCancel(t.Context())
		done := make(chan error, 1)
		go func() { done <- source.Run(ctx) }()
		synctest.Wait()
		if calls.Load() != 1 {
			t.Fatal("Run did not fetch initially")
		}
		time.Sleep(55*time.Minute - time.Nanosecond)
		synctest.Wait()
		if calls.Load() != 1 {
			t.Fatal("Run refreshed too early")
		}
		time.Sleep(time.Nanosecond)
		synctest.Wait()
		if calls.Load() != 2 {
			t.Fatal("Run did not refresh proactively")
		}
		cancel()
		if err := <-done; !errors.Is(err, context.Canceled) {
			t.Fatalf("Run returned %v", err)
		}

		blocked := mustTokenSource(t, func(ctx context.Context) (string, time.Time, error) {
			<-ctx.Done()
			return "", time.Time{}, ctx.Err()
		})
		start := time.Now()
		if _, err := blocked.Token(t.Context()); !errors.Is(err, ErrTokenUnavailable) {
			t.Fatalf("timed-out fetch = %v", err)
		}
		if elapsed := time.Since(start); elapsed != fetchTimeout {
			t.Fatalf("fetch took %v; want %v", elapsed, fetchTimeout)
		}
	})
}

func TestRegistrationTokenEndpoint(t *testing.T) {
	for registration, want := range map[string]string{
		"https://github.com/acme":                 "https://api.github.com/orgs/acme/actions/runners/registration-token",
		"https://www.github.com/acme/repo/":       "https://api.github.com/repos/acme/repo/actions/runners/registration-token",
		"https://tenant.ghe.com/enterprises/acme": "https://api.tenant.ghe.com/enterprises/acme/actions/runners/registration-token",
		"https://ghes.example/acme":               "https://ghes.example/api/v3/orgs/acme/actions/runners/registration-token",
	} {
		got, err := registrationTokenEndpoint(registration)
		if err != nil || got.String() != want {
			t.Fatalf("endpoint(%q) = %v, %v; want %s", registration, got, err, want)
		}
	}
	for _, invalid := range []string{"bad", "ftp://github.com/acme", "https://github.com/", "https://github.com/a/b/c", "https://user:secret@github.com/a", "https://github.com/a?secret=1", "https://github.com/a#secret"} {
		if _, err := registrationTokenEndpoint(invalid); err == nil || strings.Contains(err.Error(), "secret") {
			t.Fatalf("invalid endpoint error = %v", err)
		}
	}
	t.Setenv("GITHUB_ACTIONS_FORCE_GHES", "true")
	got, err := registrationTokenEndpoint("https://github.com/acme")
	if err != nil || got.String() != "https://github.com/api/v3/orgs/acme/actions/runners/registration-token" {
		t.Fatalf("forced GHES endpoint = %v, %v", got, err)
	}
}

func readTokenResponse(t *testing.T, client *http.Client, req *http.Request) error {
	t.Helper()
	resp, err := client.Do(req)
	if resp != nil {
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
	}
	return err
}

func TestTokenHTTPClientScopesAuthorizationAndOwnsHeaders(t *testing.T) {
	var fetched atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		want := r.Header.Get("X-Want-Auth")
		if got := r.Header.Get("Authorization"); got != want {
			t.Errorf("%s %s auth = %q; want %q", r.Method, r.URL, got, want)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	other := httptest.NewServer(server.Config.Handler)
	defer other.Close()
	endpoint, _ := url.Parse(server.URL + "/api/v3/orgs/acme/actions/runners/registration-token")
	retry := tokenHTTPClient(endpoint, func(ctx context.Context) (string, error) {
		fetched.Add(1)
		value, _ := ctx.Value(tokenTestKey{}).(string)
		return value, nil
	})
	defer retry.HTTPClient.CloseIdleConnections()
	client := retry.StandardClient()
	for _, test := range []struct{ method, target string }{
		{http.MethodGet, endpoint.String()},
		{http.MethodPost, endpoint.String() + "/extra"},
		{http.MethodPost, endpoint.String() + "?q=1"},
		{http.MethodPost, other.URL + endpoint.Path},
		{http.MethodPost, server.URL + "/api/v3/actions/runner-registration"},
		{http.MethodPost, server.URL + "/tenant/_apis/runtime/runnerscalesets/1/sessions"},
	} {
		req, _ := http.NewRequestWithContext(t.Context(), test.method, test.target, nil)
		req.Header.Set("Authorization", "Bearer actions-token")
		req.Header.Set("X-Want-Auth", "Bearer actions-token")
		if err := readTokenResponse(t, client, req); err != nil {
			t.Fatal(err)
		}
	}
	// Scheme matching is checked without sending plaintext to a TLS endpoint.
	mismatch, _ := http.NewRequestWithContext(t.Context(), http.MethodPost, "https://"+endpoint.Host+endpoint.Path, nil)
	mismatch.Header.Set("Authorization", "Bearer actions-token")
	retry.RequestLogHook(nil, mismatch, 0)
	if mismatch.Header.Get("Authorization") != "Bearer actions-token" || fetched.Load() != 0 {
		t.Fatal("hook replaced auth outside the exact REST origin/path/method")
	}

	shared := http.Header{"Authorization": {"Bearer placeholder"}}
	var group sync.WaitGroup
	for n := range 30 {
		group.Go(func() {
			value := fmt.Sprintf("credential-%d", n)
			ctx := context.WithValue(t.Context(), tokenTestKey{}, value)
			req, _ := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), nil)
			req.Header = shared
			// Clone for this test-only expectation header. The hook's clone is
			// verified separately below using the shared map itself.
			retry.RequestLogHook(nil, req, 0)
			req.Header.Set("X-Want-Auth", "Bearer "+value)
			if err := readTokenResponse(t, client, req); err != nil {
				t.Error(err)
			}
		})
	}
	group.Wait()
	if shared.Get("Authorization") != "Bearer placeholder" || shared.Get("X-Want-Auth") != "" {
		t.Fatalf("hook mutated shared caller headers: %v", shared)
	}
}

type tokenTestKey struct{}

func TestTokenHTTPClientFailsClosedIncludingHTTP2(t *testing.T) {
	for _, http2 := range []bool{false, true} {
		t.Run(fmt.Sprintf("http2=%v", http2), func(t *testing.T) {
			var requests atomic.Int32
			var protocol atomic.Int32
			server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				protocol.Store(int32(r.ProtoMajor))
				if r.Header.Get("Authorization") != "Bearer live-secret" {
					t.Errorf("unexpected Authorization %q", r.Header.Get("Authorization"))
				}
				w.WriteHeader(http.StatusNoContent)
			}))
			server.EnableHTTP2 = http2
			if http2 {
				server.StartTLS()
			} else {
				server.Start()
			}
			defer server.Close()
			now := time.Now()
			var failed atomic.Bool
			source := mustTokenSource(t, func(context.Context) (string, time.Time, error) {
				if failed.Load() {
					return "", time.Time{}, errors.New("leaked-secret")
				}
				return "live-secret", now.Add(time.Hour), nil
			})
			source.now = func() time.Time { return now }
			endpoint, _ := url.Parse(server.URL + "/api/v3/orgs/acme/actions/runners/registration-token")
			retry := tokenHTTPClient(endpoint, source.Token)
			if http2 {
				transport := retry.HTTPClient.Transport.(*http.Transport)
				transport.TLSClientConfig = server.Client().Transport.(*http.Transport).TLSClientConfig.Clone()
				transport.ForceAttemptHTTP2 = true
			}
			defer retry.HTTPClient.CloseIdleConnections()
			client := retry.StandardClient()
			request := func() error {
				req, _ := http.NewRequestWithContext(t.Context(), http.MethodPost, endpoint.String(), nil)
				req.Header.Set("Authorization", "Bearer stale-secret")
				return readTokenResponse(t, client, req)
			}
			// Prime the pool, including a cached HTTP/2 connection.
			if err := request(); err != nil {
				t.Fatal(err)
			}
			if err := request(); err != nil {
				t.Fatal(err)
			}
			if http2 && protocol.Load() != 2 {
				t.Fatal("test did not negotiate HTTP/2")
			}
			failed.Store(true)
			now = now.Add(time.Hour)
			if err := request(); err == nil || strings.Contains(err.Error(), "secret") {
				t.Fatalf("expired request error = %v", err)
			}
			if got := requests.Load(); got != 2 {
				t.Fatalf("expired credential sent a request: %d", got)
			}
			// A source that has never had a credential must also send nothing.
			empty := tokenHTTPClient(endpoint, func(context.Context) (string, error) { return "", errors.New("leaked-secret") })
			defer empty.HTTPClient.CloseIdleConnections()
			req, _ := http.NewRequestWithContext(t.Context(), http.MethodPost, endpoint.String(), nil)
			if err := readTokenResponse(t, empty.StandardClient(), req); err == nil || strings.Contains(err.Error(), "secret") {
				t.Fatalf("unavailable request error = %v", err)
			}
			if requests.Load() != 2 {
				t.Fatal("unavailable source sent a request")
			}
		})
	}
}

func TestTokenHTTPClientRejectsRedirects(t *testing.T) {
	for _, status := range []int{http.StatusFound, http.StatusTemporaryRedirect, http.StatusPermanentRedirect} {
		for _, crossOrigin := range []bool{false, true} {
			t.Run(fmt.Sprintf("%d/cross-origin=%v", status, crossOrigin), func(t *testing.T) {
				var redirected atomic.Int32
				target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { redirected.Add(1); w.WriteHeader(http.StatusNoContent) }))
				defer target.Close()
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.URL.Path == "/target" {
						redirected.Add(1)
						w.WriteHeader(http.StatusNoContent)
						return
					}
					location := "/target"
					if crossOrigin {
						location = target.URL + "/target"
					}
					http.Redirect(w, r, location, status)
				}))
				defer server.Close()
				endpoint, _ := url.Parse(server.URL + "/registration-token")
				retry := tokenHTTPClient(endpoint, func(context.Context) (string, error) { return "secret", nil })
				defer retry.HTTPClient.CloseIdleConnections()
				req, _ := http.NewRequestWithContext(t.Context(), http.MethodPost, endpoint.String(), nil)
				if err := readTokenResponse(t, retry.StandardClient(), req); err == nil {
					t.Fatal("redirect was accepted")
				}
				if redirected.Load() != 0 {
					t.Fatal("redirect target received a request")
				}
			})
		}
	}
}

func TestTokenRefreshPreservesMessageSession(t *testing.T) {
	var clock sync.Mutex
	now := time.Now()
	var fetched, registrations, created, deleted, polled atomic.Int32
	source := mustTokenSource(t, func(context.Context) (string, time.Time, error) {
		clock.Lock()
		defer clock.Unlock()
		return fmt.Sprintf("github-%d", fetched.Add(1)), now.Add(time.Hour), nil
	})
	source.now = func() time.Time { clock.Lock(); defer clock.Unlock(); return now }
	var authMu sync.Mutex
	var registrationAuth []string
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v3/orgs/acme/actions/runners/registration-token":
			registrations.Add(1)
			authMu.Lock()
			registrationAuth = append(registrationAuth, r.Header.Get("Authorization"))
			authMu.Unlock()
			w.WriteHeader(http.StatusCreated)
			_, _ = io.WriteString(w, `{"token":"registration"}`)
		case "/api/v3/actions/runner-registration":
			if r.Header.Get("Authorization") != "RemoteAuth registration" {
				t.Errorf("RemoteAuth replaced: %q", r.Header.Get("Authorization"))
			}
			// Force an admin refresh on every parent operation without sleeping.
			claims := jwt.RegisteredClaims{ExpiresAt: jwt.NewNumericDate(time.Now().Add(30 * time.Second))}
			admin, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte("test"))
			if err != nil {
				t.Error(err)
				w.WriteHeader(http.StatusInternalServerError)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]string{"url": server.URL + "/tenant/", "token": admin})
		case "/tenant/_apis/runtime/runnerscalesets/1/sessions":
			created.Add(1)
			_ = json.NewEncoder(w).Encode(map[string]string{
				"sessionId": "12345678-1234-1234-1234-123456789abc", "messageQueueUrl": server.URL + "/queue", "messageQueueAccessToken": "queue-token",
			})
		case "/tenant/_apis/runtime/runnerscalesets/1/sessions/12345678-1234-1234-1234-123456789abc":
			deleted.Add(1)
			w.WriteHeader(http.StatusNoContent)
		case "/tenant/_apis/runtime/runnerscalesets":
			if strings.HasPrefix(r.Header.Get("Authorization"), "Bearer github-") {
				t.Error("GitHub token leaked into Actions request")
			}
			_, _ = io.WriteString(w, `{"count":0,"value":[]}`)
		case "/queue":
			if r.Header.Get("Authorization") != "Bearer queue-token" {
				t.Errorf("queue auth replaced: %q", r.Header.Get("Authorization"))
			}
			polled.Add(1)
			w.WriteHeader(http.StatusAccepted)
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	client, err := NewClientWithTokenSource(server.URL+"/acme", source.Token, scaleset.SystemInfo{})
	if err != nil {
		t.Fatal(err)
	}
	inner := client.Client
	session, err := client.MessageSessionClient(t.Context(), 1, "controller")
	if err != nil {
		t.Fatal(err)
	}
	initial := session.Session()
	if _, err := session.GetMessage(t.Context(), 0, 1); err != nil {
		t.Fatal(err)
	}
	clock.Lock()
	now = now.Add(55 * time.Minute)
	clock.Unlock()
	if value, err := source.Token(t.Context()); err != nil || value != "github-2" {
		t.Fatalf("refresh = %q, %v", value, err)
	}
	// Parent calls refresh admin auth while the same session polls concurrently.
	// This catches sharing a retryablehttp.Client between those two paths.
	var group sync.WaitGroup
	group.Go(func() {
		for range 20 {
			if _, err := client.GetRunnerScaleSet(t.Context(), 1, "fleet"); err != nil {
				t.Error(err)
				return
			}
		}
	})
	group.Go(func() {
		for range 20 {
			if _, err := session.GetMessage(t.Context(), 0, 1); err != nil {
				t.Error(err)
				return
			}
		}
	})
	group.Wait()
	if client.Client != inner || session.Session().SessionID != initial.SessionID || created.Load() != 1 || deleted.Load() != 0 || polled.Load() != 21 {
		t.Fatalf("refresh changed session: created=%d deleted=%d polled=%d", created.Load(), deleted.Load(), polled.Load())
	}
	authMu.Lock()
	auth := append([]string(nil), registrationAuth...)
	authMu.Unlock()
	if len(auth) != 21 || auth[0] != "Bearer github-1" {
		t.Fatalf("registration auth = %v", auth)
	}
	for _, value := range auth[1:] {
		if value != "Bearer github-2" {
			t.Fatalf("registration used stale auth: %q", value)
		}
	}
	if registrations.Load() != 21 || fetched.Load() != 2 {
		t.Fatalf("registrations=%d fetches=%d", registrations.Load(), fetched.Load())
	}
	if err := session.Close(t.Context()); err != nil {
		t.Fatal(err)
	}
	if deleted.Load() != 1 {
		t.Fatal("explicit session close did not delete exactly once")
	}
}
