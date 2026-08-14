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
	"time"

	"github.com/Fanzzzd/EraInfra/apps/runtime/internal/executor"
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
	ExitCode int    `json:"exitCode"`
	Error    string `json:"error,omitempty"`
}

type prepareRequest struct {
	ImageRelease string `json:"imageRelease"`
}

// preflightResponse always carries the full readiness Report, including when a
// check failed: "not ready, and here is exactly which prerequisite is broken"
// is an answer the Worker forwards to the control plane, not a protocol error.
type preflightResponse struct {
	Report executor.Report `json:"report"`
	Error  string          `json:"error,omitempty"`
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

func (c *Client) Preflight(ctx context.Context) (executor.Report, error) {
	var response preflightResponse
	if err := c.do(ctx, "/v1/preflight", struct{}{}, &response); err != nil {
		return executor.Report{}, err
	}
	if response.Error != "" {
		return response.Report, errors.New(response.Error)
	}
	return response.Report, nil
}

func (c *Client) PrepareImage(ctx context.Context, imageRelease string) error {
	return c.do(ctx, "/v1/prepare", prepareRequest{ImageRelease: imageRelease}, nil)
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
	return executor.Result{ExitCode: result.ExitCode}, nil
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
	defer response.Body.Close()
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
	defer lock.Close()
	if err := unix.Flock(int(lock.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		return errors.New("another runtime service already holds the socket lock")
	}
	defer unix.Flock(int(lock.Fd()), unix.LOCK_UN) //nolint:errcheck -- process exit releases it too
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
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		return fmt.Errorf("listen on runtime socket: %w", err)
	}
	defer func() {
		_ = listener.Close()
		_ = os.Remove(socketPath)
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

	server := &http.Server{
		Handler:           handler(runtime),
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

func handler(runtime executor.Executor) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/preflight", func(response http.ResponseWriter, request *http.Request) {
		report, err := runtime.Preflight(request.Context())
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
		if err := runtime.PrepareImage(request.Context(), input.ImageRelease); err != nil {
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
		waitContext, cancelWait := context.WithTimeout(
			request.Context(),
			jobTimeout,
		)
		result, waitError := lease.Wait(waitContext)
		cancelWait()
		if waitError == nil {
			writeJSON(response, http.StatusOK, resultResponse{ExitCode: result.ExitCode})
			return
		}
		cleanupContext, cancelCleanup := context.WithTimeout(context.Background(), 30*time.Second)
		cleanupError := lease.Cancel(cleanupContext)
		cancelCleanup()
		if errors.Is(waitError, context.DeadlineExceeded) {
			writeJSON(response, http.StatusOK, resultResponse{ExitCode: 124})
			return
		}
		writeError(response, errors.Join(waitError, cleanupError))
	})
	return mux
}

func decodeRequest(request *http.Request, output any) error {
	defer request.Body.Close()
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
