// Package convexstore implements the Fleet boundary over EraInfra's
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
	"strconv"
	"strings"
	"time"

	"github.com/Fanzzzd/erainfra/apps/controller/internal/fleet"
)

const maxResponseBytes = 1 << 20

type Store struct {
	baseURL string
	token   string
	client  *http.Client
	// Immutable per grant. Never change the epoch of a Store a previous holder
	// goroutine still uses: it must not inherit its successor's authority.
	epoch       int64
	onLeaseLost context.CancelFunc
	// ActivateProfile is consumed on the first successful acquire of a
	// dedicated process. Later acquires respect an operator's pause.
	ActivateProfile bool
	// CanPublishCacheFacts tells Convex this process can publish cache facts. A
	// Profile that publishes them is never leased to a candidate that cannot,
	// because its runners would get no facts and every cache request would 401.
	CanPublishCacheFacts bool
}

func New(baseURL, token string, client *http.Client) (*Store, error) {
	parsed, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" {
		return nil, errors.New("Convex URL must be an absolute HTTPS URL") //nolint:staticcheck // ST1005: Convex is a product name
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

// PauseProfile marks a retired Profile paused, so Workers stop discovering,
// prewarming and advertising it. It reports false when the control plane has
// no such Profile, which is not an error for a retire: there is nothing left
// to pause.
func (s *Store) PauseProfile(ctx context.Context, name string) (bool, error) {
	err := s.doJSON(ctx, http.MethodPost, "/controller/profiles/pause", map[string]string{"name": name}, nil, true)
	var apiErr *APIError
	if errors.As(err, &apiErr) && apiErr.StatusCode == http.StatusNotFound {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
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
	err := s.doJSON(ctx, http.MethodPost, "/controller/jobs/started", struct {
		Profile          string `json:"profile"`
		RunnerName       string `json:"runnerName"`
		RunnerRequestID  string `json:"runnerRequestId,omitempty"`
		Repository       string `json:"repository,omitempty"`
		Owner            string `json:"owner,omitempty"`
		JobID            string `json:"jobId,omitempty"`
		WorkflowRef      string `json:"workflowRef,omitempty"`
		HeadBranch       string `json:"headBranch,omitempty"`
		DisplayName      string `json:"displayName,omitempty"`
		WorkflowRunID    int64  `json:"workflowRunId,omitempty"`
		EventName        string `json:"eventName,omitempty"`
		QueueTime        *int64 `json:"queueTime,omitempty"`
		AssignedAt       *int64 `json:"assignedAt,omitempty"`
		RunnerAssignedAt *int64 `json:"runnerAssignedAt,omitempty"`
	}{
		Profile:          event.Profile,
		RunnerName:       event.RunnerName,
		RunnerRequestID:  optionalInt64(event.RunnerRequestID),
		Repository:       event.Repository,
		Owner:            event.Owner,
		JobID:            event.JobID,
		WorkflowRef:      event.WorkflowRef,
		HeadBranch:       event.HeadBranch,
		DisplayName:      event.DisplayName,
		WorkflowRunID:    event.WorkflowRunID,
		EventName:        event.EventName,
		QueueTime:        unixMillis(event.QueueTime),
		AssignedAt:       unixMillis(event.AssignedAt),
		RunnerAssignedAt: unixMillis(event.RunnerAssignedAt),
	}, nil, true)
	if err != nil {
		return fmt.Errorf(
			"mark job started (runner=%q request=%d job=%q repository=%q owner=%q display=%q workflowRun=%d event=%q): %w",
			event.RunnerName,
			event.RunnerRequestID,
			event.JobID,
			event.Repository,
			event.Owner,
			event.DisplayName,
			event.WorkflowRunID,
			event.EventName,
			err,
		)
	}
	return nil
}

func (s *Store) MarkJobCompleted(ctx context.Context, event fleet.JobCompleted) error {
	err := s.doJSON(ctx, http.MethodPost, "/controller/jobs/completed", struct {
		Profile         string `json:"profile"`
		RunnerName      string `json:"runnerName"`
		RunnerRequestID string `json:"runnerRequestId,omitempty"`
		JobID           string `json:"jobId,omitempty"`
		Result          string `json:"result,omitempty"`
		FinishedAt      int64  `json:"finishedAt"`
	}{
		Profile:         event.Profile,
		RunnerName:      event.RunnerName,
		RunnerRequestID: optionalInt64(event.RunnerRequestID),
		JobID:           event.JobID,
		Result:          event.Result,
		FinishedAt:      event.FinishedAt.UnixMilli(),
	}, nil, true)
	if err != nil {
		return fmt.Errorf(
			"mark job completed (runner=%q request=%d job=%q result=%q finishedAt=%s): %w",
			event.RunnerName,
			event.RunnerRequestID,
			event.JobID,
			event.Result,
			event.FinishedAt.UTC().Format(time.RFC3339Nano),
			err,
		)
	}
	return nil
}

// maxHeartbeatErrorRunes caps the error a heartbeat carries. GitHub's 409 body
// alone is a few hundred characters; the control plane rejects anything longer
// than it stores rather than truncating someone else's text.
const maxHeartbeatErrorRunes = 500

// SendHeartbeat reports the controller's liveness (POST /controller/heartbeat).
func (s *Store) SendHeartbeat(ctx context.Context, report fleet.ControllerHeartbeat) error {
	lastError := []rune(report.LastError)
	if len(lastError) > maxHeartbeatErrorRunes {
		lastError = append(lastError[:maxHeartbeatErrorRunes-1], '…')
	}
	return s.doJSON(ctx, http.MethodPost, "/controller/heartbeat", struct {
		Profile       string          `json:"profile"`
		Hostname      string          `json:"hostname"`
		Version       string          `json:"version"`
		ScaleSetID    int             `json:"scaleSetId,omitempty"`
		SessionState  string          `json:"sessionState"`
		LastMessageAt *int64          `json:"lastMessageAt,omitempty"`
		AssignedJobs  int             `json:"assignedJobs"`
		RunningJobs   int             `json:"runningJobs"`
		StartedAt     *int64          `json:"startedAt,omitempty"`
		LastError     string          `json:"lastError,omitempty"`
		Lease         *heartbeatLease `json:"lease,omitempty"`
	}{
		Profile:       report.Profile,
		Hostname:      report.Hostname,
		Version:       report.Version,
		ScaleSetID:    report.ScaleSetID,
		SessionState:  string(report.SessionState),
		LastMessageAt: unixMillis(report.LastMessageAt),
		AssignedJobs:  max(0, report.AssignedJobs),
		RunningJobs:   max(0, report.RunningJobs),
		StartedAt:     unixMillis(report.StartedAt),
		LastError:     string(lastError),
		Lease:         leaseReport(report),
	}, nil, true)
}

func optionalInt64(value int64) string {
	if value <= 0 {
		return ""
	}
	return strconv.FormatInt(value, 10)
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
	if s.epoch > 0 {
		request.Header.Set("X-EraInfra-Lease-Epoch", strconv.FormatInt(s.epoch, 10))
	}
	if requestBody != nil {
		request.Header.Set("Content-Type", "application/json")
	}

	response, err := s.client.Do(request)
	if err != nil {
		return fmt.Errorf("send controller request: %w", err)
	}
	defer response.Body.Close() //nolint:errcheck // read-only body; a close error loses nothing

	limited := io.LimitReader(response.Body, maxResponseBytes+1)
	data, err := io.ReadAll(limited)
	if err != nil {
		return fmt.Errorf("read controller response: %w", err)
	}
	if len(data) > maxResponseBytes {
		return errors.New("controller response exceeded 1 MiB")
	}
	if response.StatusCode == http.StatusPreconditionFailed {
		if s.onLeaseLost != nil {
			s.onLeaseLost()
		}
		return fleet.ErrLeaseLost
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		apiErr := &APIError{StatusCode: response.StatusCode, Status: response.Status}
		if includeErrorBody {
			apiErr.Message = strings.TrimSpace(string(data))
		}
		return apiErr
	}
	if responseBody == nil || len(data) == 0 {
		return nil
	}
	if err := json.Unmarshal(data, responseBody); err != nil {
		return fmt.Errorf("decode controller response: %w", err)
	}
	return nil
}

// APIError is a non-2xx answer from the control plane. Message carries the
// response body only where the caller allowed it (never for routes whose
// failure body could echo a credential).
type APIError struct {
	StatusCode int
	Status     string
	Message    string
}

func (e *APIError) Error() string {
	if e.Message != "" {
		return fmt.Sprintf("controller API returned %s: %s", e.Status, e.Message)
	}
	return fmt.Sprintf("controller API returned %s", e.Status)
}

var _ fleet.Store = (*Store)(nil)
