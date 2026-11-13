package runtimeapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/admission"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/executor"
	"github.com/Fanzzzd/erainfra/apps/runtime/internal/jobmetrics"
	"github.com/Fanzzzd/erainfra/apps/runtime/internal/netpolicy"
	"github.com/Fanzzzd/erainfra/apps/runtime/internal/runnerexit"
	"github.com/Fanzzzd/erainfra/apps/runtime/internal/testreport"
	"golang.org/x/sys/unix"
)

const maxRequestBytes = 2 << 20

const (
	maxBootTimeout = 15 * time.Minute
	maxJobTimeout  = 6 * time.Hour
)

type executeRequest struct {
	Spec               executor.Spec `json:"spec"`
	BootTimeoutSeconds int64         `json:"bootTimeoutSeconds"`
	JobTimeoutSeconds  int64         `json:"jobTimeoutSeconds"`
}

type resultResponse struct {
	ExitCode int                    `json:"exitCode"`
	Error    string                 `json:"error,omitempty"`
	Egress   *executor.EgressRecord `json:"egress,omitempty"`
	Tests    *testreport.Report     `json:"tests,omitempty"`
	// RunnerExit is unknown to a client that predates it, which ignores it.
	RunnerExit *runnerexit.Report `json:"runnerExit,omitempty"`
}

// preflightRequest names the Profile egress the report is for. An empty body,
// which is what a Worker that predates Profile egress sends, means public.
type preflightRequest struct {
	Egress netpolicy.ProfileEgress `json:"egress"`
}

type prepareRequest struct {
	Profile executor.Profile `json:"profile"`
}

type prepareResponse struct {
	WarmPool executor.WarmPoolStatus `json:"warmPool"`
	Error    string                  `json:"error,omitempty"`
}

type removeProfileRequest struct {
	Profile string `json:"profile"`
}

type recoverRequest struct {
	LiveAttemptIDs []string `json:"liveAttemptIds"`
}

type pruneImagesRequest struct {
	Keep []string `json:"keep"`
}

// preflightResponse always carries the full readiness Report, including when a
// check failed: "not ready, and here is exactly which prerequisite is broken"
// is an answer the Worker forwards to the control plane, not a protocol error.
type preflightResponse struct {
	Report executor.Report `json:"report"`
	Error  string          `json:"error,omitempty"`
}

type metricsRequest struct {
	AttemptID string `json:"attemptId"`
}

// MetricsResponse is one Attempt's resource history as the runtime holds it.
// Found is false when the runtime is not measuring the Attempt and has no
// recent final Snapshot for it; Live is false once the Attempt has finished.
type MetricsResponse struct {
	Found    bool                `json:"found"`
	Live     bool                `json:"live"`
	Snapshot jobmetrics.Snapshot `json:"snapshot"`
	Error    string              `json:"error,omitempty"`
}

type Client struct {
	httpClient *http.Client
}

func NewClient(socketPath string) (*Client, error) {
	if strings.TrimSpace(socketPath) == "" {
		return nil, errors.New("runtime socket path is required")
	}
	dialer := &net.Dialer{Timeout: 5 * time.Second}
	return &Client{httpClient: &http.Client{
		Transport: &http.Transport{
			Proxy: nil,
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return dialer.DialContext(ctx, "unix", socketPath)
			},
		},
	}}, nil
}

func (c *Client) Preflight(ctx context.Context, egress netpolicy.ProfileEgress) (executor.Report, error) {
	var response preflightResponse
	if err := c.do(ctx, "/v1/preflight", preflightRequest{Egress: egress}, &response); err != nil {
		return executor.Report{}, err
	}
	if response.Error != "" {
		return response.Report, errors.New(response.Error)
	}
	return response.Report, nil
}

func (c *Client) PrepareProfile(
	ctx context.Context,
	profile executor.Profile,
) (executor.WarmPoolStatus, error) {
	var response prepareResponse
	if err := c.do(ctx, "/v1/prepare", prepareRequest{Profile: profile}, &response); err != nil {
		return executor.WarmPoolFailed(err), err
	}
	if response.Error != "" {
		return response.WarmPool, errors.New(response.Error)
	}
	return response.WarmPool, nil
}

func (c *Client) RemoveProfile(ctx context.Context, profile string) error {
	return c.do(ctx, "/v1/profiles/remove", removeProfileRequest{Profile: profile}, nil)
}

// RecoverOrphans blocks until the privileged runtime has reconciled its local
// Firecracker state with the control plane's authoritative live set.
func (c *Client) RecoverOrphans(ctx context.Context, liveAttemptIDs []string) error {
	return c.do(ctx, "/v1/recover", recoverRequest{LiveAttemptIDs: liveAttemptIDs}, nil)
}

// PruneImages deletes the Image Releases no Profile in keep uses, keeping the newest other one.
func (c *Client) PruneImages(ctx context.Context, keep []string) (executor.ImagePrune, error) {
	var result executor.ImagePrune
	if err := c.do(ctx, "/v1/images/prune", pruneImagesRequest{Keep: keep}, &result); err != nil {
		return executor.ImagePrune{}, err
	}
	return result, nil
}

// Admission reads the start budget and how much of it is in use.
func (c *Client) Admission(ctx context.Context) (admission.State, error) {
	var state admission.State
	if err := c.do(ctx, "/v1/admission", struct{}{}, &state); err != nil {
		return admission.State{}, err
	}
	return state, nil
}

// Metrics reads an Attempt's resource history from the runtime service.
func (c *Client) Metrics(ctx context.Context, attemptID string) (MetricsResponse, error) {
	var response MetricsResponse
	if err := c.do(ctx, "/v1/metrics", metricsRequest{AttemptID: attemptID}, &response); err != nil {
		return MetricsResponse{}, err
	}
	return response, nil
}

func (c *Client) Execute(
	ctx context.Context,
	spec executor.Spec,
	bootTimeout time.Duration,
	jobTimeout time.Duration,
) (executor.Result, error) {
	var result resultResponse
	err := c.do(ctx, "/v1/execute", executeRequest{
		Spec:               spec,
		BootTimeoutSeconds: int64(bootTimeout / time.Second),
		JobTimeoutSeconds:  int64(jobTimeout / time.Second),
	}, &result)
	if err != nil {
		return executor.Result{}, err
	}
	// The service validated the report before sending it; the client is the
	// other side of a privilege boundary, so it checks again rather than pass
	// on something it did not check.
	if result.Tests != nil {
		if err := result.Tests.Validate(); err != nil {
			fmt.Fprintf(os.Stderr, "dropped the runtime's test report: %v\n", err)
			result.Tests = nil
		}
	}
	if result.RunnerExit != nil {
		if err := result.RunnerExit.Validate(); err != nil {
			fmt.Fprintf(os.Stderr, "dropped the runtime's runner exit report: %v\n", err)
			result.RunnerExit = nil
		}
	}
	return executor.Result{
		ExitCode:   result.ExitCode,
		Egress:     result.Egress,
		Tests:      result.Tests,
		RunnerExit: result.RunnerExit,
	}, nil
}

func (c *Client) do(ctx context.Context, path string, input any, output any) error {
	payload, err := json.Marshal(input)
	if err != nil {
		return fmt.Errorf("encode runtime request: %w", err)
	}
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		"http://runner-center.local"+path,
		bytes.NewReader(payload),
	)
	if err != nil {
		return fmt.Errorf("create runtime request: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := c.httpClient.Do(request)
	if err != nil {
		return fmt.Errorf("call privileged runtime: %w", err)
	}
	defer response.Body.Close() //nolint:errcheck // read-only body; a close error loses nothing
	responsePayload, err := io.ReadAll(io.LimitReader(response.Body, maxRequestBytes+1))
	if err != nil {
		return fmt.Errorf("read runtime response: %w", err)
	}
	if len(responsePayload) > maxRequestBytes {
		return errors.New("runtime response exceeded 2 MiB")
	}
	var result resultResponse
	if len(responsePayload) > 0 {
		if err := json.Unmarshal(responsePayload, &result); err != nil {
			return fmt.Errorf("decode runtime response: %w", err)
		}
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		if result.Error == "" {
			return fmt.Errorf("runtime returned HTTP %d", response.StatusCode)
		}
		return errors.New(result.Error)
	}
	if output != nil && len(responsePayload) > 0 {
		if err := json.Unmarshal(responsePayload, output); err != nil {
			return fmt.Errorf("decode runtime result: %w", err)
		}
	}
	return nil
}

func Serve(
	ctx context.Context,
	socketPath string,
	groupName string,
	runtime executor.Executor,
) error {
	if runtime == nil {
		return errors.New("runtime executor is required")
	}
	if os.Geteuid() != 0 {
		return errors.New("runtime service must run as root")
	}
	if strings.TrimSpace(socketPath) == "" {
		return errors.New("runtime socket path is required")
	}
	if err := os.MkdirAll(filepath.Dir(socketPath), 0o755); err != nil {
		return fmt.Errorf("create runtime socket directory: %w", err)
	}
	lock, err := os.OpenFile(socketPath+".lock", os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return fmt.Errorf("open runtime service lock: %w", err)
	}
	defer lock.Close() //nolint:errcheck // Serve is returning; the kernel drops the flock with the descriptor, error or not
	if err := unix.Flock(int(lock.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		return errors.New("another runtime service already holds the socket lock")
	}
	defer unix.Flock(int(lock.Fd()), unix.LOCK_UN) //nolint:errcheck // lock.Close, deferred above, releases it regardless
	if info, err := os.Lstat(socketPath); err == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return errors.New("refusing to replace a non-socket runtime path")
		}
		if err := os.Remove(socketPath); err != nil {
			return fmt.Errorf("remove stale runtime socket: %w", err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("inspect runtime socket: %w", err)
	}
	if recovery, ok := runtime.(interface{ Recover(context.Context) error }); ok {
		if err := recovery.Recover(ctx); err != nil {
			return fmt.Errorf("recover abandoned runtime state: %w", err)
		}
	}
	var listenConfig net.ListenConfig
	listener, err := listenConfig.Listen(ctx, "unix", socketPath)
	if err != nil {
		return fmt.Errorf("listen on runtime socket: %w", err)
	}
	defer func() {
		_ = listener.Close()
		_ = os.Remove(socketPath)
	}()
	defer func() {
		shutdownContext, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_ = runtime.Shutdown(shutdownContext)
	}()
	if groupName != "" {
		group, err := user.LookupGroup(groupName)
		if err != nil {
			return fmt.Errorf("lookup runtime socket group: %w", err)
		}
		gid, err := strconv.Atoi(group.Gid)
		if err != nil {
			return fmt.Errorf("parse runtime socket group: %w", err)
		}
		if err := os.Chown(socketPath, 0, gid); err != nil {
			return fmt.Errorf("set runtime socket group: %w", err)
		}
	}
	if err := os.Chmod(socketPath, 0o660); err != nil {
		return fmt.Errorf("set runtime socket permissions: %w", err)
	}

	// One Sampler per running Attempt, reading the VMM's host-side counters.
	// Their history dies with this process, as does every VM they measured.
	metrics := jobmetrics.NewRegistry(jobmetrics.DefaultSampleInterval)
	defer metrics.Shutdown()
	server := &http.Server{
		Handler:           NewHandler(runtime, metrics),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		IdleTimeout:       30 * time.Second,
		MaxHeaderBytes:    16 << 10,
		BaseContext: func(net.Listener) context.Context {
			return ctx
		},
	}
	go func() {
		<-ctx.Done()
		_ = server.Shutdown(context.Background())
	}()
	err = server.Serve(listener)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

// NewHandler serves the runtime API. Serve puts it on the root-owned socket;
// the golden tests of other packages put it on a temporary one, so the
// documents they record cross the same wire as in production.
func NewHandler(runtime executor.Executor, metrics *jobmetrics.Registry) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/metrics", func(response http.ResponseWriter, request *http.Request) {
		var input metricsRequest
		if err := decodeRequest(request, &input); err != nil {
			writeError(response, err)
			return
		}
		if metrics == nil {
			writeJSON(response, http.StatusOK, MetricsResponse{})
			return
		}
		snapshot, live, found := metrics.Snapshot(input.AttemptID)
		writeJSON(response, http.StatusOK, MetricsResponse{Found: found, Live: live, Snapshot: snapshot})
	})
	mux.HandleFunc("POST /v1/images/prune", func(response http.ResponseWriter, request *http.Request) {
		var input pruneImagesRequest
		if err := decodeRequest(request, &input); err != nil {
			writeError(response, err)
			return
		}
		pruner, ok := runtime.(interface {
			PruneImages(context.Context, []string) (executor.ImagePrune, error)
		})
		if !ok {
			writeError(response, errors.New("this runtime keeps no Image Releases"))
			return
		}
		result, err := pruner.PruneImages(request.Context(), input.Keep)
		if err != nil {
			writeError(response, err)
			return
		}
		writeJSON(response, http.StatusOK, result)
	})
	mux.HandleFunc("POST /v1/admission", func(response http.ResponseWriter, request *http.Request) {
		if err := decodeRequest(request, &struct{}{}); err != nil {
			writeError(response, err)
			return
		}
		gate, ok := runtime.(interface{ AdmissionState() admission.State })
		if !ok {
			writeError(response, errors.New("this runtime has no start budget"))
			return
		}
		writeJSON(response, http.StatusOK, gate.AdmissionState())
	})
	mux.HandleFunc("POST /v1/preflight", func(response http.ResponseWriter, request *http.Request) {
		var input preflightRequest
		if err := decodeRequest(request, &input); err != nil {
			writeError(response, err)
			return
		}
		report, err := runtime.Preflight(request.Context(), input.Egress)
		payload := preflightResponse{Report: report}
		if err != nil {
			payload.Error = err.Error()
		}
		writeJSON(response, http.StatusOK, payload)
	})
	mux.HandleFunc("POST /v1/prepare", func(response http.ResponseWriter, request *http.Request) {
		var input prepareRequest
		if err := decodeRequest(request, &input); err != nil {
			writeError(response, err)
			return
		}
		status, err := runtime.PrepareProfile(request.Context(), input.Profile)
		payload := prepareResponse{WarmPool: status}
		if err != nil {
			payload.Error = err.Error()
		}
		writeJSON(response, http.StatusOK, payload)
	})
	mux.HandleFunc("POST /v1/profiles/remove", func(response http.ResponseWriter, request *http.Request) {
		var input removeProfileRequest
		if err := decodeRequest(request, &input); err != nil {
			writeError(response, err)
			return
		}
		if strings.TrimSpace(input.Profile) == "" {
			writeError(response, errors.New("profile is required"))
			return
		}
		if err := runtime.RemoveProfile(request.Context(), input.Profile); err != nil {
			writeError(response, err)
			return
		}
		writeJSON(response, http.StatusOK, resultResponse{})
	})
	mux.HandleFunc("POST /v1/recover", func(response http.ResponseWriter, request *http.Request) {
		var input recoverRequest
		if err := decodeRequest(request, &input); err != nil {
			writeError(response, err)
			return
		}
		recovery, ok := runtime.(interface {
			RecoverOrphans(context.Context, []string) error
		})
		if !ok {
			writeError(response, errors.New("runtime does not support orphan recovery"))
			return
		}
		if err := recovery.RecoverOrphans(request.Context(), input.LiveAttemptIDs); err != nil {
			writeError(response, err)
			return
		}
		writeJSON(response, http.StatusOK, resultResponse{ExitCode: 0})
	})
	mux.HandleFunc("POST /v1/execute", func(response http.ResponseWriter, request *http.Request) {
		var input executeRequest
		if err := decodeRequest(request, &input); err != nil {
			writeError(response, err)
			return
		}
		if err := input.Spec.Validate(); err != nil {
			writeError(response, err)
			return
		}
		bootTimeout := time.Duration(input.BootTimeoutSeconds) * time.Second
		jobTimeout := time.Duration(input.JobTimeoutSeconds) * time.Second
		if bootTimeout < time.Second || bootTimeout > maxBootTimeout {
			writeError(response, errors.New("boot timeout must be between 1 and 900 seconds"))
			return
		}
		if jobTimeout < time.Second || jobTimeout > maxJobTimeout {
			writeError(response, errors.New("job timeout must be between 1 and 21600 seconds"))
			return
		}
		bootContext, cancelBoot := context.WithTimeout(
			request.Context(),
			bootTimeout,
		)
		lease, err := runtime.Start(bootContext, input.Spec)
		cancelBoot()
		input.Spec.JITConfig = ""
		if err != nil {
			writeError(response, err)
			return
		}
		finishMetrics := startMetrics(metrics, input.Spec, lease)
		defer finishMetrics()
		waitContext, cancelWait := context.WithTimeout(
			request.Context(),
			jobTimeout,
		)
		result, waitError := lease.Wait(waitContext)
		cancelWait()
		// Before the response, so the Worker's closing collection, which it
		// makes as soon as this request returns, finds the final Snapshot.
		finishMetrics()
		if waitError == nil {
			writeJSON(response, http.StatusOK, resultResponse{
				ExitCode:   result.ExitCode,
				Egress:     result.Egress,
				Tests:      result.Tests,
				RunnerExit: result.RunnerExit,
			})
			return
		}
		cleanupContext, cancelCleanup := context.WithTimeout(context.Background(), 30*time.Second)
		cleanupError := lease.Cancel(cleanupContext)
		cancelCleanup()
		if errors.Is(waitError, context.DeadlineExceeded) {
			// A job that ran out of time is exactly the one whose traffic an
			// operator wants to read, so its record survives the cancellation.
			var record *executor.EgressRecord
			if recorded, ok := lease.(interface{ EgressRecord() *executor.EgressRecord }); ok {
				record = recorded.EgressRecord()
			}
			writeJSON(response, http.StatusOK, resultResponse{ExitCode: 124, Egress: record})
			return
		}
		writeError(response, errors.Join(waitError, cleanupError))
	})
	return mux
}

// startMetrics begins sampling a CI Attempt's boundary and returns the call
// that ends it. Measurement is best effort by construction: a Lease that
// cannot be measured runs exactly as it would have, unmeasured.
func startMetrics(metrics *jobmetrics.Registry, spec executor.Spec, lease executor.Lease) func() {
	noop := func() {}
	if metrics == nil || spec.Kind != "ci" {
		return noop
	}
	measurable, ok := lease.(executor.Measurable)
	if !ok {
		return noop
	}
	source, err := measurable.ResourceSource()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Attempt %s runs unmeasured: %v\n", spec.AttemptID, err)
		return noop
	}
	metrics.Start(spec.AttemptID, source)
	var once sync.Once
	return func() { once.Do(func() { metrics.Finish(spec.AttemptID) }) }
}

func decodeRequest(request *http.Request, output any) error {
	defer request.Body.Close() //nolint:errcheck // read-only body; a close error loses nothing
	payload, err := io.ReadAll(io.LimitReader(request.Body, maxRequestBytes+1))
	if err != nil {
		return fmt.Errorf("read runtime request: %w", err)
	}
	if len(payload) > maxRequestBytes {
		return errors.New("runtime request exceeded 2 MiB")
	}
	if err := json.Unmarshal(payload, output); err != nil {
		return errors.New("invalid runtime request")
	}
	return nil
}

func writeError(response http.ResponseWriter, err error) {
	writeJSON(response, http.StatusBadRequest, resultResponse{ExitCode: 1, Error: err.Error()})
}

func writeJSON(response http.ResponseWriter, status int, value any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(value)
}
