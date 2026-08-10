// Package convexstore implements the Fleet boundary over Runner Center's
// authenticated Convex HTTP API.
package convexstore

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/Fanzzzd/runner-center/apps/controller/internal/fleet"
)

const maxResponseBytes = 1 << 20

type Store struct {
	baseURL string
	token   string
	client  *http.Client
}

func New(baseURL, token string, client *http.Client) (*Store, error) {
	parsed, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" {
		return nil, errors.New("Convex URL must be an absolute HTTPS URL")
	}
	if strings.TrimSpace(token) == "" {
		return nil, errors.New("controller token is required")
	}
	if client == nil {
		client = &http.Client{Timeout: 20 * time.Second}
	}
	return &Store{
		baseURL: strings.TrimRight(parsed.String(), "/"),
		token:   token,
		client:  client,
	}, nil
}

type attemptResponse struct {
	RunnerName string             `json:"runnerName"`
	RunnerID   int64              `json:"runnerId"`
	State      fleet.AttemptState `json:"state"`
	CreatedAt  int64              `json:"createdAt"`
}

func (s *Store) RegisterProfile(ctx context.Context, profile fleet.ProfileSpec) error {
	return s.doJSON(ctx, http.MethodPost, "/controller/profiles", profile, nil, true)
}

func (s *Store) ListActiveAttempts(ctx context.Context, profile string) ([]fleet.Attempt, error) {
	path := "/controller/attempts?profile=" + url.QueryEscape(profile)
	var response struct {
		Attempts []attemptResponse `json:"attempts"`
	}
	if err := s.doJSON(ctx, http.MethodGet, path, nil, &response, true); err != nil {
		return nil, err
	}

	attempts := make([]fleet.Attempt, len(response.Attempts))
	for index, attempt := range response.Attempts {
		attempts[index] = fleet.Attempt{
			RunnerName: attempt.RunnerName,
			RunnerID:   attempt.RunnerID,
			State:      attempt.State,
			CreatedAt:  time.UnixMilli(attempt.CreatedAt),
		}
	}
	return attempts, nil
}

func (s *Store) ListRunnerCleanups(ctx context.Context, profile string) ([]fleet.RunnerCleanup, error) {
	path := "/controller/runner-cleanups?profile=" + url.QueryEscape(profile)
	var response struct {
		Cleanups []fleet.RunnerCleanup `json:"cleanups"`
	}
	if err := s.doJSON(ctx, http.MethodGet, path, nil, &response, true); err != nil {
		return nil, err
	}
	return response.Cleanups, nil
}

func (s *Store) CompleteRunnerCleanup(
	ctx context.Context,
	profile string,
	cleanup fleet.RunnerCleanup,
) error {
	return s.doJSON(ctx, http.MethodPost, "/controller/runner-cleanups/complete", struct {
		Profile    string `json:"profile"`
		RunnerName string `json:"runnerName"`
		RunnerID   int64  `json:"runnerId"`
	}{
		Profile:    profile,
		RunnerName: cleanup.RunnerName,
		RunnerID:   cleanup.RunnerID,
	}, nil, true)
}

func (s *Store) CreateAttempt(ctx context.Context, attempt fleet.NewAttempt) error {
	// A failed server must not be allowed to reflect the request body: it holds
	// the single-use JIT configuration.
	return s.doJSON(ctx, http.MethodPost, "/controller/attempts", attempt, nil, false)
}

func (s *Store) CancelAttempt(ctx context.Context, profile, runnerName, reason string) error {
	return s.doJSON(ctx, http.MethodPost, "/controller/attempts/cancel", map[string]string{
		"profile":    profile,
		"runnerName": runnerName,
		"reason":     reason,
	}, nil, true)
}

func (s *Store) MarkJobStarted(ctx context.Context, event fleet.JobStarted) error {
	return s.doJSON(ctx, http.MethodPost, "/controller/jobs/started", struct {
		Profile          string `json:"profile"`
		RunnerName       string `json:"runnerName"`
		RunnerRequestID  int64  `json:"runnerRequestId"`
		Repository       string `json:"repository"`
		Owner            string `json:"owner"`
		JobID            string `json:"jobId"`
		WorkflowRef      string `json:"workflowRef"`
		DisplayName      string `json:"displayName"`
		WorkflowRunID    int64  `json:"workflowRunId"`
		EventName        string `json:"eventName"`
		QueueTime        *int64 `json:"queueTime,omitempty"`
		AssignedAt       *int64 `json:"assignedAt,omitempty"`
		RunnerAssignedAt *int64 `json:"runnerAssignedAt,omitempty"`
	}{
		Profile:          event.Profile,
		RunnerName:       event.RunnerName,
		RunnerRequestID:  event.RunnerRequestID,
		Repository:       event.Repository,
		Owner:            event.Owner,
		JobID:            event.JobID,
		WorkflowRef:      event.WorkflowRef,
		DisplayName:      event.DisplayName,
		WorkflowRunID:    event.WorkflowRunID,
		EventName:        event.EventName,
		QueueTime:        unixMillis(event.QueueTime),
		AssignedAt:       unixMillis(event.AssignedAt),
		RunnerAssignedAt: unixMillis(event.RunnerAssignedAt),
	}, nil, true)
}

func (s *Store) MarkJobCompleted(ctx context.Context, event fleet.JobCompleted) error {
	return s.doJSON(ctx, http.MethodPost, "/controller/jobs/completed", struct {
		Profile         string `json:"profile"`
		RunnerName      string `json:"runnerName"`
		RunnerRequestID int64  `json:"runnerRequestId"`
		JobID           string `json:"jobId"`
		Result          string `json:"result"`
		FinishedAt      int64  `json:"finishedAt"`
	}{
		Profile:         event.Profile,
		RunnerName:      event.RunnerName,
		RunnerRequestID: event.RunnerRequestID,
		JobID:           event.JobID,
		Result:          event.Result,
		FinishedAt:      event.FinishedAt.UnixMilli(),
	}, nil, true)
}

func unixMillis(value time.Time) *int64 {
	if value.IsZero() {
		return nil
	}
	milliseconds := value.UnixMilli()
	return &milliseconds
}

func (s *Store) doJSON(
	ctx context.Context,
	method string,
	path string,
	requestBody any,
	responseBody any,
	includeErrorBody bool,
) error {
	var body io.Reader
	if requestBody != nil {
		encoded, err := json.Marshal(requestBody)
		if err != nil {
			return fmt.Errorf("encode controller request: %w", err)
		}
		body = bytes.NewReader(encoded)
	}

	request, err := http.NewRequestWithContext(ctx, method, s.baseURL+path, body)
	if err != nil {
		return fmt.Errorf("create controller request: %w", err)
	}
	request.Header.Set("Authorization", "Bearer "+s.token)
	request.Header.Set("Accept", "application/json")
	if requestBody != nil {
		request.Header.Set("Content-Type", "application/json")
	}

	response, err := s.client.Do(request)
	if err != nil {
		return fmt.Errorf("send controller request: %w", err)
	}
	defer response.Body.Close()

	limited := io.LimitReader(response.Body, maxResponseBytes+1)
	data, err := io.ReadAll(limited)
	if err != nil {
		return fmt.Errorf("read controller response: %w", err)
	}
	if len(data) > maxResponseBytes {
		return errors.New("controller response exceeded 1 MiB")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		if includeErrorBody {
			message := strings.TrimSpace(string(data))
			if message != "" {
				return fmt.Errorf("controller API returned %s: %s", response.Status, message)
			}
		}
		return fmt.Errorf("controller API returned %s", response.Status)
	}
	if responseBody == nil || len(data) == 0 {
		return nil
	}
	if err := json.Unmarshal(data, responseBody); err != nil {
		return fmt.Errorf("decode controller response: %w", err)
	}
	return nil
}

var _ fleet.Store = (*Store)(nil)
