// Package fleet defines the durable control-plane boundary used by the
// GitHub scale-set controller. Implementations must be idempotent: GitHub can
// redeliver lifecycle messages and the controller can restart at any point.
package fleet

import (
	"context"
	"time"
)

// AttemptState is the control-plane state of one isolated execution.
type AttemptState string

const (
	AttemptPending   AttemptState = "pending"
	AttemptPreparing AttemptState = "preparing"
	AttemptReady     AttemptState = "ready"
	AttemptRunning   AttemptState = "running"
)

// Attempt is the minimum state the controller needs to reconcile capacity.
// Encoded JIT configuration is intentionally write-only and never returned.
type Attempt struct {
	RunnerName string       `json:"runnerName"`
	RunnerID   int64        `json:"runnerId"`
	State      AttemptState `json:"state"`
	CreatedAt  time.Time    `json:"createdAt"`
}

type RunnerCleanup struct {
	RunnerName string `json:"runnerName"`
	RunnerID   int64  `json:"runnerId"`
}

// ProfileSpec is the durable workflow-facing contract a controller owns.
// Workers discover it from the Fleet instead of carrying local image config.
type ProfileSpec struct {
	Name         string `json:"name"`
	ScaleSetName string `json:"scaleSetName"`
	Executor     string `json:"executor"`
	ImageRelease string `json:"imageRelease"`
	VCPUs        int64  `json:"vcpus"`
	MemoryMiB    int64  `json:"memoryMiB"`
	MinRunners   int    `json:"minRunners"`
	MaxRunners   int    `json:"maxRunners"`
}

// NewAttempt carries a single-use runner registration into the Fleet. The
// implementation must never log EncodedJITConfig and must remove it once a
// Worker claims the Attempt.
type NewAttempt struct {
	Profile          string `json:"profile"`
	Executor         string `json:"executor"`
	ImageRelease     string `json:"imageRelease"`
	VCPUs            int64  `json:"vcpus"`
	MemoryMiB        int64  `json:"memoryMiB"`
	RunnerName       string `json:"runnerName"`
	RunnerID         int64  `json:"runnerId"`
	EncodedJITConfig string `json:"encodedJITConfig"`
}

// JobStarted is the scale-set lifecycle data worth retaining for an Attempt.
type JobStarted struct {
	Profile          string    `json:"profile"`
	RunnerName       string    `json:"runnerName"`
	RunnerRequestID  int64     `json:"runnerRequestId"`
	Repository       string    `json:"repository"`
	Owner            string    `json:"owner"`
	JobID            string    `json:"jobId"`
	WorkflowRef      string    `json:"workflowRef"`
	DisplayName      string    `json:"displayName"`
	WorkflowRunID    int64     `json:"workflowRunId"`
	EventName        string    `json:"eventName"`
	QueueTime        time.Time `json:"queueTime"`
	AssignedAt       time.Time `json:"assignedAt"`
	RunnerAssignedAt time.Time `json:"runnerAssignedAt"`
}

// JobCompleted settles an Attempt. Duplicate completion messages must be a
// no-op in the implementation.
type JobCompleted struct {
	Profile         string    `json:"profile"`
	RunnerName      string    `json:"runnerName"`
	RunnerRequestID int64     `json:"runnerRequestId"`
	JobID           string    `json:"jobId"`
	Result          string    `json:"result"`
	FinishedAt      time.Time `json:"finishedAt"`
}

// Store is the deep boundary between GitHub demand and Runner Center's durable
// scheduler. It deliberately says nothing about Convex, Firecracker, or Tart.
type Store interface {
	RegisterProfile(ctx context.Context, profile ProfileSpec) error
	ListActiveAttempts(ctx context.Context, profile string) ([]Attempt, error)
	ListRunnerCleanups(ctx context.Context, profile string) ([]RunnerCleanup, error)
	CompleteRunnerCleanup(ctx context.Context, profile string, cleanup RunnerCleanup) error
	CreateAttempt(ctx context.Context, attempt NewAttempt) error
	CancelAttempt(ctx context.Context, profile, runnerName, reason string) error
	MarkJobStarted(ctx context.Context, event JobStarted) error
	MarkJobCompleted(ctx context.Context, event JobCompleted) error
}
