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
	Name             string   `json:"name"`
	ScaleSetName     string   `json:"scaleSetName"`
	Executor         string   `json:"executor"`
	ImageRelease     string   `json:"imageRelease"`
	VCPUs            int64    `json:"vcpus"`
	MemoryMiB        int64    `json:"memoryMiB"`
	WarmPool         int      `json:"warmPool"`
	FitPolicy        string   `json:"fitPolicy"`
	MinRunners       int      `json:"minRunners"`
	MaxRunners       int      `json:"maxRunners"`
	RegistrationURL  string   `json:"githubConfigUrl,omitempty"`
	GitHubCacheFacts bool     `json:"githubCacheFacts,omitempty"`
	RunnerGroup      string   `json:"runnerGroup,omitempty"`
	Labels           []string `json:"labels,omitempty"`
	// WorkerLabels are the host labels a Worker must carry to serve the Profile (ADR 0017).
	// Omitted when empty, so a control plane that predates them reads an unpinned Profile.
	WorkerLabels []string `json:"workerLabels,omitempty"`
	// Egress is the Profile's egress policy, or nil for public egress. It is
	// omitted rather than sent as public so a control plane that predates it
	// reads the same Profile it always did.
	Egress *ProfileEgress `json:"egress,omitempty"`
}

// ProfileEgress is what a Profile's guests may reach: public, audit (public
// plus a host-side record of every destination), or allowlist (only the
// presets, domains and CIDRs listed).
type ProfileEgress struct {
	Mode    string   `json:"mode"`
	Presets []string `json:"presets,omitempty"`
	Domains []string `json:"domains,omitempty"`
	CIDRs   []string `json:"cidrs,omitempty"`
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
	Profile         string `json:"profile"`
	RunnerName      string `json:"runnerName"`
	RunnerRequestID int64  `json:"runnerRequestId"`
	Repository      string `json:"repository"`
	Owner           string `json:"owner"`
	JobID           string `json:"jobId"`
	WorkflowRef     string `json:"workflowRef"`
	// HeadBranch is the workflow run's head_branch, read from GitHub after the
	// message arrived; empty on the first MarkJobStarted. See
	// Scaler.learnFromWorkflowRun.
	HeadBranch       string    `json:"headBranch,omitempty"`
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

// Store is the deep boundary between GitHub demand and EraInfra's durable
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

// SessionState is what a controller is doing with its scale set's GitHub
// message session. GitHub allows one session per scale set, so of several
// controllers for one Profile at most one is SessionListening.
type SessionState string

const (
	// SessionStarting: registered with the control plane, no session yet.
	SessionStarting SessionState = "starting"
	// SessionStandby: waiting for the Profile's Convex lease, not opening a session.
	SessionStandby SessionState = "standby"
	// SessionListening: this controller holds the session and turns demand
	// into Attempts.
	SessionListening SessionState = "listening"
	// SessionConflict: GitHub refused a session because one already exists
	// for the scale set. The controller backs off and retries.
	SessionConflict SessionState = "conflict"
	// SessionStopped: the controller is exiting and has released its session.
	SessionStopped SessionState = "stopped"
)

// ControllerHeartbeat is one controller's liveness report. Hostname is the
// machine the controller runs on, which is what tells two controllers for the
// same Profile apart.
type ControllerHeartbeat struct {
	Profile      string
	Hostname     string
	Version      string
	ScaleSetID   int
	SessionState SessionState
	LeaseRole    string
	LeaseEpoch   int64
	// LastMessageAt is the last time GitHub answered the message long poll,
	// with a message or with an empty reply. Zero until the first answer.
	LastMessageAt time.Time
	// AssignedJobs and RunningJobs are GitHub's counts for the scale set, from
	// the newest statistics it sent.
	AssignedJobs int
	RunningJobs  int
	StartedAt    time.Time
	LastError    string
}
