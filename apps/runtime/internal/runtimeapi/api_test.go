package runtimeapi

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Fanzzzd/EraInfra/apps/runtime/internal/executor"
)

type fakeExecutor struct {
	preflightError error
	preparedImage  string
	recoveredIDs   []string
	lease          *fakeLease
	startedSpec    executor.Spec
}

func (f *fakeExecutor) Preflight(context.Context) (executor.Report, error) {
	report := executor.Report{
		Isolation: executor.IsolationFirecracker,
		Boundary:  executor.BoundaryGuestKernel,
	}
	if f.preflightError != nil {
		report.Fail(executor.CheckKVM, f.preflightError)
		return report, f.preflightError
	}
	report.Pass(executor.CheckKVM, "fake")
	return report, nil
}

func (f *fakeExecutor) PrepareImage(_ context.Context, image string) error {
	f.preparedImage = image
	return nil
}

func (f *fakeExecutor) Start(_ context.Context, spec executor.Spec) (executor.Lease, error) {
	f.startedSpec = spec
	if f.lease == nil {
		return nil, errors.New("no fake lease configured")
	}
	return f.lease, nil
}

func (f *fakeExecutor) RecoverOrphans(_ context.Context, liveAttemptIDs []string) error {
	f.recoveredIDs = append([]string(nil), liveAttemptIDs...)
	return nil
}

type fakeLease struct {
	wait       func(context.Context) (executor.Result, error)
	cancelOnce sync.Once
	cancelled  chan struct{}
}

func (l *fakeLease) Wait(ctx context.Context) (executor.Result, error) {
	return l.wait(ctx)
}

func (l *fakeLease) Cancel(context.Context) error {
	l.cancelOnce.Do(func() { close(l.cancelled) })
	return nil
}

func testSpec() executor.Spec {
	return executor.Spec{
		Kind:         "ci",
		AttemptID:    "attempt-1",
		RunnerName:   "runner-1",
		Profile:      "rc-linux-js",
		ImageRelease: "ghcr.io/example/image@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		VCPUs:        2,
		MemoryMiB:    4096,
		JITConfig:    "secret-jit",
	}
}

func unixClient(t *testing.T, runtime executor.Executor) *Client {
	t.Helper()
	directory, err := os.MkdirTemp("/tmp", "rc-runtime-api-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(directory) })
	socket := filepath.Join(directory, "runtime.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: handler(runtime)}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() {
		_ = server.Close()
		_ = listener.Close()
		_ = os.Remove(socket)
	})
	client, err := NewClient(socket)
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func TestClientUsesUnixSocketForLifecycle(t *testing.T) {
	lease := &fakeLease{
		wait:      func(context.Context) (executor.Result, error) { return executor.Result{ExitCode: 17}, nil },
		cancelled: make(chan struct{}),
	}
	runtime := &fakeExecutor{lease: lease}
	client := unixClient(t, runtime)
	ctx := context.Background()

	report, err := client.Preflight(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !report.Ready() || report.Boundary != executor.BoundaryGuestKernel {
		t.Fatalf("the readiness report did not cross the socket intact: %+v", report)
	}
	image := testSpec().ImageRelease
	if err := client.PrepareImage(ctx, image); err != nil {
		t.Fatal(err)
	}
	if err := client.RecoverOrphans(ctx, []string{"attempt-live", "experiment-live"}); err != nil {
		t.Fatal(err)
	}
	result, err := client.Execute(ctx, testSpec(), time.Second, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if result.ExitCode != 17 || runtime.preparedImage != image {
		t.Fatalf("unexpected result=%+v prepared=%q", result, runtime.preparedImage)
	}
	if runtime.startedSpec.JITConfig != "secret-jit" {
		t.Fatal("runtime did not receive JIT input through the request body")
	}
	if got := strings.Join(runtime.recoveredIDs, ","); got != "attempt-live,experiment-live" {
		t.Fatalf("runtime received the wrong live set: %q", got)
	}
}

func TestExecuteTimeoutCancelsLeaseAndReturns124(t *testing.T) {
	lease := &fakeLease{
		wait: func(ctx context.Context) (executor.Result, error) {
			<-ctx.Done()
			return executor.Result{}, ctx.Err()
		},
		cancelled: make(chan struct{}),
	}
	client := unixClient(t, &fakeExecutor{lease: lease})

	result, err := client.Execute(context.Background(), testSpec(), time.Second, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if result.ExitCode != 124 {
		t.Fatalf("exit code = %d, want 124", result.ExitCode)
	}
	select {
	case <-lease.cancelled:
	default:
		t.Fatal("timed-out lease was not cancelled")
	}
}

func TestInvalidRequestDoesNotEchoJITSecret(t *testing.T) {
	runtime := &fakeExecutor{}
	response := httptest.NewRecorder()
	request, err := http.NewRequest(
		http.MethodPost,
		"/v1/execute",
		strings.NewReader(`{"spec":{"JITConfig":"do-not-echo"},"bootTimeoutSeconds":1,"jobTimeoutSeconds":1}`),
	)
	if err != nil {
		t.Fatal(err)
	}
	handler(runtime).ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", response.Code)
	}
	if body := response.Body.String(); strings.Contains(body, "do-not-echo") {
		t.Fatalf("error response leaked JIT input: %s", body)
	}
}
