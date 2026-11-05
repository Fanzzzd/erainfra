package controller

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Fanzzzd/erainfra/apps/controller/internal/fleet"
	"github.com/actions/scaleset"
	"github.com/actions/scaleset/listener"
	"github.com/google/uuid"
)

// fakeActionsService answers just enough of GitHub's scale-set API for the
// real scaleset client to create and delete message sessions: the registration
// token exchange, then POST and DELETE on the scale set's sessions. The first
// `conflicts` creates are refused the way GitHub refuses a second session.
type fakeActionsService struct {
	server    *httptest.Server
	conflicts atomic.Int32
	creates   atomic.Int32
	deletes   atomic.Int32
}

func unsignedJWT(t *testing.T) string {
	t.Helper()
	encode := func(value any) string {
		data, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return base64.RawURLEncoding.EncodeToString(data)
	}
	// The client reads the expiry without verifying the signature.
	return encode(map[string]string{"alg": "RS256", "typ": "JWT"}) + "." +
		encode(map[string]int64{"iat": time.Now().Add(-time.Minute).Unix(), "exp": time.Now().Add(time.Hour).Unix()}) +
		".c2lnbmF0dXJl"
}

func newFakeActionsService(t *testing.T, conflicts int) *fakeActionsService {
	t.Helper()
	service := &fakeActionsService{}
	service.conflicts.Store(int32(conflicts))
	token := unsignedJWT(t)
	sessions := "/tenant/123/_apis/runtime/runnerscalesets/1/sessions"
	service.server = httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch {
		case strings.HasSuffix(request.URL.Path, "/runners/registration-token"):
			response.WriteHeader(http.StatusCreated)
			_, _ = response.Write([]byte(`{"token":"registration-token"}`))
		case strings.HasSuffix(request.URL.Path, "/actions/runner-registration"):
			_ = json.NewEncoder(response).Encode(map[string]string{
				"url":   service.server.URL + "/tenant/123/",
				"token": token,
			})
		case request.Method == http.MethodPost && request.URL.Path == sessions:
			service.creates.Add(1)
			if service.conflicts.Add(-1) >= 0 {
				response.Header().Set("Content-Type", "application/json")
				response.WriteHeader(http.StatusConflict)
				_, _ = response.Write([]byte(`{"typeName":"TaskAgentSessionConflictException","message":"The scale set already has an active session for owner other-host:rc-linux-js."}`))
				return
			}
			_ = json.NewEncoder(response).Encode(scaleset.RunnerScaleSetSession{
				SessionID:               uuid.New(),
				OwnerName:               "this-host:rc-linux-js",
				RunnerScaleSet:          &scaleset.RunnerScaleSet{ID: 1, Name: "rc-linux-js"},
				MessageQueueURL:         service.server.URL + "/queue",
				MessageQueueAccessToken: "queue-token",
				Statistics:              &scaleset.RunnerScaleSetStatistic{},
			})
		case request.Method == http.MethodDelete && strings.HasPrefix(request.URL.Path, sessions+"/"):
			service.deletes.Add(1)
			response.WriteHeader(http.StatusNoContent)
		default:
			http.Error(response, "unexpected "+request.Method+" "+request.URL.Path, http.StatusTeapot)
		}
	}))
	t.Cleanup(service.server.Close)
	return service
}

func (s *fakeActionsService) client(t *testing.T) *scaleset.Client {
	t.Helper()
	client, err := scaleset.NewClientWithPersonalAccessToken(scaleset.NewClientWithPersonalAccessTokenConfig{
		GitHubConfigURL:     s.server.URL + "/owner/repository",
		PersonalAccessToken: "pat",
		SystemInfo:          scaleset.SystemInfo{System: "erainfra-test"},
	}, scaleset.WithRetryMax(0))
	if err != nil {
		t.Fatal(err)
	}
	return client
}

type recordedStates struct {
	mu     sync.Mutex
	states []fleet.SessionState
	errors []string
}

func (r *recordedStates) SetSession(state fleet.SessionState, cause error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.states = append(r.states, state)
	message := ""
	if cause != nil {
		message = cause.Error()
	}
	r.errors = append(r.errors, message)
}

// The conflict is GitHub's guarantee that one scale set has one listener. This
// drives the real scaleset client, so the conflict test also proves that the
// error text IsSessionConflict reads is the one the library produces.
func TestASecondControllerWaitsOutTheSessionConflictAndThenListens(t *testing.T) {
	service := newFakeActionsService(t, 2)
	client := service.client(t)
	states := &recordedStates{}
	var sleeps []time.Duration
	var listening atomic.Int32
	var listens atomic.Int32
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()

	supervisor := &SessionSupervisor{
		Open: func(ctx context.Context) (MessageSession, error) {
			return client.MessageSessionClient(ctx, 1, "this-host:rc-linux-js")
		},
		Listen: func(ctx context.Context, session listener.Client) error {
			if listening.Add(1) != 1 {
				t.Error("two listeners ran at once")
			}
			defer listening.Add(-1)
			listens.Add(1)
			if session.Session().SessionID == uuid.Nil {
				t.Error("the listener was handed no session")
			}
			cancel()
			return ctx.Err()
		},
		Observer: states,
		Sleep: func(_ context.Context, d time.Duration) error {
			sleeps = append(sleeps, d)
			return nil
		},
		Jitter: func(d time.Duration) time.Duration { return d },
	}
	if err := supervisor.Run(ctx); err != nil {
		t.Fatalf("Run = %v, want nil after a clean stop", err)
	}

	if got := service.creates.Load(); got != 3 {
		t.Fatalf("session creates = %d, want 2 conflicts and 1 success", got)
	}
	if listens.Load() != 1 {
		t.Fatalf("listens = %d, want 1", listens.Load())
	}
	if service.deletes.Load() != 1 {
		t.Fatalf("session deletes = %d; the session must be released on stop", service.deletes.Load())
	}
	if want := []time.Duration{10 * time.Second, 20 * time.Second}; fmt.Sprint(sleeps) != fmt.Sprint(want) {
		t.Fatalf("backoff = %v, want %v", sleeps, want)
	}
	want := []fleet.SessionState{fleet.SessionConflict, fleet.SessionConflict, fleet.SessionListening}
	if fmt.Sprint(states.states) != fmt.Sprint(want) {
		t.Fatalf("states = %v, want %v", states.states, want)
	}
	if !strings.Contains(states.errors[0], "already has an active session") {
		t.Fatalf("the conflict report must carry GitHub's reason, got %q", states.errors[0])
	}
}

func TestConflictBackoffDoublesUpToItsCap(t *testing.T) {
	service := newFakeActionsService(t, 6)
	client := service.client(t)
	var sleeps []time.Duration
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	supervisor := &SessionSupervisor{
		Open: func(ctx context.Context) (MessageSession, error) {
			return client.MessageSessionClient(ctx, 1, "this-host:rc-linux-js")
		},
		Listen: func(ctx context.Context, _ listener.Client) error {
			cancel()
			return ctx.Err()
		},
		Sleep: func(_ context.Context, d time.Duration) error {
			sleeps = append(sleeps, d)
			return nil
		},
		Jitter: func(d time.Duration) time.Duration { return d },
	}
	if err := supervisor.Run(ctx); err != nil {
		t.Fatal(err)
	}
	want := []time.Duration{10 * time.Second, 20 * time.Second, 40 * time.Second, time.Minute, time.Minute, time.Minute}
	if fmt.Sprint(sleeps) != fmt.Sprint(want) {
		t.Fatalf("backoff = %v, want %v", sleeps, want)
	}
}

func TestStoppingWhileWaitingOutAConflictNeverListens(t *testing.T) {
	service := newFakeActionsService(t, 100)
	client := service.client(t)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	supervisor := &SessionSupervisor{
		Open: func(ctx context.Context) (MessageSession, error) {
			return client.MessageSessionClient(ctx, 1, "this-host:rc-linux-js")
		},
		Listen: func(context.Context, listener.Client) error {
			t.Error("a controller that never got the session must not listen")
			return nil
		},
		Sleep: func(ctx context.Context, _ time.Duration) error {
			cancel()
			return ctx.Err()
		},
	}
	if err := supervisor.Run(ctx); err != nil {
		t.Fatalf("Run = %v, want nil", err)
	}
	if service.deletes.Load() != 0 {
		t.Fatal("there was no session to delete")
	}
}

type fakeSession struct {
	listener.Client
	closed atomic.Int32
}

func (s *fakeSession) Close(context.Context) error {
	s.closed.Add(1)
	return nil
}

func TestAnyOtherSessionErrorIsReturnedWithoutListening(t *testing.T) {
	supervisor := &SessionSupervisor{
		Open: func(context.Context) (MessageSession, error) {
			return nil, errors.New(`request POST /sessions failed(status="401 Unauthorized"): bad credentials`)
		},
		Listen: func(context.Context, listener.Client) error {
			t.Error("listened without a session")
			return nil
		},
		Sleep: func(context.Context, time.Duration) error {
			t.Error("an authentication failure is not a conflict and must not be retried in-process")
			return nil
		},
	}
	err := supervisor.Run(t.Context())
	if err == nil || !strings.Contains(err.Error(), "401 Unauthorized") {
		t.Fatalf("Run = %v", err)
	}
}

func TestAListenerFailureReleasesTheSessionAndIsReturned(t *testing.T) {
	session := &fakeSession{}
	opens := 0
	supervisor := &SessionSupervisor{
		Open: func(context.Context) (MessageSession, error) {
			opens++
			return session, nil
		},
		Listen: func(context.Context, listener.Client) error {
			return errors.New("failed to get message: connection reset")
		},
	}
	err := supervisor.Run(t.Context())
	if err == nil || !strings.Contains(err.Error(), "connection reset") {
		t.Fatalf("Run = %v", err)
	}
	if session.closed.Load() != 1 {
		t.Fatal("the session must be closed so the next start does not conflict with itself")
	}
	if opens != 1 {
		t.Fatalf("opens = %d; a listener failure exits and systemd restarts, it does not reopen in-process", opens)
	}
}

func TestIsSessionConflict(t *testing.T) {
	for _, tc := range []struct {
		err  error
		want bool
	}{
		{nil, false},
		{errors.New(`request POST https://x/sessions failed(status="409 Conflict"): unexpected status code 409 Conflict`), true},
		{errors.New("TaskAgentSessionConflictException: already has an active session"), true},
		{errors.New(`request POST https://x/sessions failed(status="404 Not Found")`), false},
	} {
		if got := IsSessionConflict(tc.err); got != tc.want {
			t.Errorf("IsSessionConflict(%v) = %v, want %v", tc.err, got, tc.want)
		}
	}
}

func TestJitterStaysWithinTenPercent(t *testing.T) {
	for range 1_000 {
		got := tenPercentJitter(time.Minute)
		if got < 54*time.Second || got > 66*time.Second {
			t.Fatalf("jitter(1m) = %v", got)
		}
	}
}
