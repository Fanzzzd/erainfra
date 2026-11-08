package controller

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/rand/v2"
	"strings"
	"time"

	"github.com/Fanzzzd/erainfra/apps/controller/internal/fleet"
	"github.com/actions/scaleset"
	"github.com/actions/scaleset/listener"
)

// MessageSession is a GitHub scale-set message session: what the listener
// polls, plus Close, which deletes the session so another controller can take
// it. *scaleset.MessageSessionClient implements it.
type MessageSession interface {
	listener.Client
	Close(ctx context.Context) error
}

// SessionObserver is told what the session is doing. The heartbeat Reporter
// implements it.
type SessionObserver interface {
	SetSession(state fleet.SessionState, cause error)
}

// Session-conflict backoff. GitHub keeps an abandoned session (a controller
// killed without closing it) for a few minutes, and a second controller for the
// same Profile holds a live one for as long as it runs. Retrying at most once a
// minute keeps a waiting controller cheap while still taking over within about
// a minute of the session being released. ARC's listener retries the same
// conflict every 30 s.
const (
	defaultConflictBackoff    = 10 * time.Second
	defaultMaxConflictBackoff = 60 * time.Second
	sessionCloseBudget        = 10 * time.Second
)

// SessionSupervisor creates the scale set's message session and runs one
// listener on it. GitHub allows one session per scale set and answers a second
// create with 409 Conflict; the supervisor treats that as "another controller
// is listening", reports it, backs off and tries again, for as long as it
// takes. Open and Listen are called strictly in sequence, so a supervisor never
// runs two listeners, and never runs one without a session it created.
type SessionSupervisor struct {
	Open     func(ctx context.Context) (MessageSession, error)
	Listen   func(ctx context.Context, session listener.Client) error
	Observer SessionObserver
	Logger   *slog.Logger

	// InitialBackoff and MaxBackoff bound the wait between conflicting
	// attempts; zero means the defaults above.
	InitialBackoff time.Duration
	MaxBackoff     time.Duration
	// Sleep and Jitter replace real waiting and randomness in tests.
	Sleep  func(ctx context.Context, d time.Duration) error
	Jitter func(d time.Duration) time.Duration
}

// Run returns nil when ctx ends, and an error when the session cannot be
// created for a reason other than a conflict or when the listener fails. The
// process exits on such an error and systemd restarts it, which is how a
// listener failure has always been recovered.
func (s *SessionSupervisor) Run(ctx context.Context) error {
	if s.Open == nil || s.Listen == nil {
		return errors.New("session supervisor needs Open and Listen")
	}
	logger := s.Logger
	if logger == nil {
		logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	initial, maximum := s.InitialBackoff, s.MaxBackoff
	if initial <= 0 {
		initial = defaultConflictBackoff
	}
	if maximum < initial {
		maximum = max(defaultMaxConflictBackoff, initial)
	}
	sleep := s.Sleep
	if sleep == nil {
		sleep = sleepContext
	}
	jitter := s.Jitter
	if jitter == nil {
		jitter = tenPercentJitter
	}

	delay := initial
	conflicts := 0
	for {
		session, err := s.Open(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			if !IsSessionConflict(err) {
				return fmt.Errorf("create GitHub message session: %w", err)
			}
			conflicts++
			wait := jitter(delay)
			s.observe(fleet.SessionConflict, err)
			logger.Warn(
				"another controller holds this scale set's message session; not listening, will retry",
				"conflicts", conflicts, "retryIn", wait.String(), "error", err,
			)
			if err := sleep(ctx, wait); err != nil {
				return nil
			}
			delay = min(delay*2, maximum)
			continue
		}

		if conflicts > 0 {
			logger.Info("acquired the message session after conflicts", "conflicts", conflicts)
		}
		s.observe(fleet.SessionListening, nil)
		listenErr := s.Listen(ctx, session)
		closeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), sessionCloseBudget)
		if err := session.Close(closeCtx); err != nil {
			logger.Error("failed to close GitHub message session", "error", err)
		}
		cancel()
		if ctx.Err() != nil {
			return nil
		}
		if listenErr == nil {
			listenErr = errors.New("listener returned without an error")
		}
		return fmt.Errorf("run GitHub scale-set listener: %w", listenErr)
	}
}

func (s *SessionSupervisor) observe(state fleet.SessionState, cause error) {
	if s.Observer != nil {
		s.Observer.SetSession(state, cause)
	}
}

// IsSessionConflict reports whether creating a message session failed because
// the scale set already has one. The scaleset client wraps a 409 in
// scaleset.ConflictError. The text match stays for an error that reaches here
// without that wrapping: its text carries the HTTP status and, when GitHub
// sends one, the Actions exception name.
func IsSessionConflict(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, scaleset.ConflictError) {
		return true
	}
	message := err.Error()
	return strings.Contains(message, `status="409 Conflict"`) ||
		strings.Contains(message, "TaskAgentSessionConflictException")
}

func sleepContext(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// tenPercentJitter spreads retries so controllers that conflicted at the same
// moment do not retry in lockstep.
func tenPercentJitter(d time.Duration) time.Duration {
	spread := int64(d) / 10
	if spread <= 0 {
		return d
	}
	return d - time.Duration(spread) + time.Duration(rand.Int64N(2*spread+1)) //nolint:gosec // jitter, not a secret
}
