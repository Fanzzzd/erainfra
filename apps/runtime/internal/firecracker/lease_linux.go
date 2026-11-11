//go:build linux

package firecracker

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/netip"
	"os"
	"sync"
	"time"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/egress"
	"github.com/Fanzzzd/erainfra/apps/runtime/internal/executor"
	"github.com/Fanzzzd/erainfra/apps/runtime/internal/jobmetrics"
	"github.com/Fanzzzd/erainfra/apps/runtime/internal/runnerexit"
	"github.com/Fanzzzd/erainfra/apps/runtime/internal/testreport"
	containerd "github.com/containerd/containerd/v2/client"
	"github.com/containerd/containerd/v2/pkg/namespaces"
	"github.com/containerd/errdefs"
	fc "github.com/firecracker-microvm/firecracker-go-sdk"
)

// vmmExitTimeout bounds how long cleanup waits for a stopped VMM to actually
// go away before it gives up and reports the guest as not cleanly destroyed.
const vmmExitTimeout = 30 * time.Second

type machineLease struct {
	machine *fc.Machine
	client  *containerd.Client
	// namespace is carried because releasing a lease is a namespaced containerd
	// call and cleanup runs on a context the caller supplied.
	namespace    string
	releaseLease func(context.Context) error
	cancelVMM    context.CancelFunc
	console      *os.File
	consolePath  string
	workDir      string
	resultToken  string
	onCleanup    func()
	cleanupOnce  sync.Once
	cleanupError error
	// egress, guestAddress and egressOwner identify the guest's per-guest
	// egress state; egressRecord is what teardown collected from it.
	egress       *egress.Guard
	guestAddress netip.Addr
	egressOwner  string
	egressRecord *executor.EgressRecord
}

// claimEgress hands a parked guest's egress state to the Attempt claiming it.
func (l *machineLease) claimEgress(ctx context.Context, attemptID string) error {
	if !l.guestAddress.IsValid() {
		return nil
	}
	if err := l.egress.Claim(ctx, l.guestAddress, l.egressOwner, attemptID); err != nil {
		return fmt.Errorf("claim parked guest egress: %w", err)
	}
	l.egressOwner = attemptID
	return nil
}

// EgressRecord is what the guest talked to, available once teardown ran. The
// runtime API reads it for an Attempt that timed out and was cancelled.
func (l *machineLease) EgressRecord() *executor.EgressRecord { return l.egressRecord }

func (l *machineLease) Wait(ctx context.Context) (executor.Result, error) {
	err := l.machine.Wait(ctx)
	if ctx.Err() != nil {
		return executor.Result{}, ctx.Err()
	}
	exitCode := 0
	var resultError error
	var tests *testreport.Report
	var runnerExit *runnerexit.Report
	if l.resultToken != "" {
		if syncError := l.console.Sync(); syncError != nil {
			resultError = fmt.Errorf("flush Experiment console: %w", syncError)
		} else {
			exitCode, resultError = parseExperimentResult(l.consolePath, l.resultToken)
		}
	} else {
		tests = l.testReport()
		runnerExit = l.runnerExit()
	}
	cleanupErr := l.cleanup(context.Background(), false)
	if err != nil || resultError != nil || cleanupErr != nil {
		return executor.Result{ExitCode: 1, Egress: l.egressRecord, Tests: tests, RunnerExit: runnerExit}, errors.Join(err, resultError, cleanupErr)
	}
	return executor.Result{ExitCode: exitCode, Egress: l.egressRecord, Tests: tests, RunnerExit: runnerExit}, nil
}

// runnerExit reads how the GitHub runner ended from the line the guest wrote
// to its console last, or nil. The exit code stays the guest's: a clean
// reset is 0 whatever the runner did, and the control plane, which knows
// whether GitHub handed the Runner a job, decides what the report means. A
// line that fails validation is logged and dropped. The console was flushed
// for the test report just before.
func (l *machineLease) runnerExit() *runnerexit.Report {
	report, err := runnerexit.ReadConsole(l.consolePath)
	if err != nil {
		slog.Warn("dropped the guest's runner exit report", "error", err)
		return nil
	}
	if report != nil {
		slog.Info("GitHub runner exited",
			"exitCode", report.ExitCode,
			"ranJob", report.RanJob,
			"diagnostic", report.Diagnostic,
		)
	}
	return report
}

// testReport reads the JUnit results the guest wrote to its console after
// the runner exited, or nil. The guest is untrusted, so ReadConsole bounds
// and validates what it decodes; a report that fails is logged and dropped,
// and never changes the Attempt's own result.
func (l *machineLease) testReport() *testreport.Report {
	if err := l.console.Sync(); err != nil {
		slog.Warn("could not flush the console to read test results", "error", err)
		return nil
	}
	report, err := testreport.ReadConsole(l.consolePath)
	if err != nil {
		slog.Warn("dropped the guest's test results", "error", err)
		return nil
	}
	return report
}

// ResourceSource measures this microVM from the host: the VMM process's CPU,
// resident memory and block I/O, its tap device's traffic, and kernel OOM
// lines on its serial console.
func (l *machineLease) ResourceSource() (jobmetrics.Source, error) {
	pid, err := l.machine.PID()
	if err != nil {
		return nil, err
	}
	var tap string
	for _, networkInterface := range l.machine.Cfg.NetworkInterfaces {
		if networkInterface.StaticConfiguration != nil {
			tap = networkInterface.StaticConfiguration.HostDevName
			break
		}
	}
	return &jobmetrics.VMMSource{
		ProcRoot: "/proc",
		PID:      pid,
		TapName:  tap,
		Console:  &jobmetrics.ConsoleOOMScanner{Path: l.consolePath},
	}, nil
}

func (l *machineLease) Cancel(ctx context.Context) error {
	return l.cleanup(ctx, true)
}

func (l *machineLease) cleanup(ctx context.Context, stop bool) error {
	l.cleanupOnce.Do(func() {
		var cleanupErrors []error
		if stop {
			if err := l.machine.StopVMM(); err != nil {
				cleanupErrors = append(cleanupErrors, fmt.Errorf("stop Firecracker VM: %w", err))
			}
			// The SDK returns the guest's network resources -- the veth pair, the
			// tap device and the host-local address reservation -- from the
			// goroutine that reaps the VMM, on the VM's own context. Cancelling
			// that context before the process is gone aborts the release and leaks
			// an address out of the guest subnet, so wait for the exit first. The
			// error here is the VMM's own exit status, which is a signal after
			// StopVMM and therefore expected; only failing to exit matters.
			exitContext, cancelExit := context.WithTimeout(context.WithoutCancel(ctx), vmmExitTimeout)
			if err := l.machine.Wait(exitContext); errors.Is(err, context.DeadlineExceeded) {
				cleanupErrors = append(cleanupErrors, fmt.Errorf( //nolint:staticcheck // ST1005: Firecracker is a product name
					"Firecracker VM did not exit within %s of being stopped", vmmExitTimeout,
				))
			}
			cancelExit()
		}
		if l.guestAddress.IsValid() {
			// SDK Wait includes CNI release, so the address may already have been
			// allocated again. Guard serializes cleanup and registration per address;
			// an old owner cannot delete a replacement's state. Failed cleanup keeps
			// the address fenced from every Profile's boot until its purge succeeds.
			egressContext, cancelEgress := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
			record, err := l.egress.Unregister(egressContext, l.guestAddress, l.egressOwner)
			cancelEgress()
			l.egressRecord = record
			if err != nil {
				slog.Warn("could not remove guest egress state", "error", err, "guest", l.guestAddress.String())
			}
		}
		l.cancelVMM()
		if err := l.console.Close(); err != nil {
			cleanupErrors = append(cleanupErrors, fmt.Errorf("close console log: %w", err))
		}
		leaseContext := namespaces.WithNamespace(ctx, l.namespace)
		if err := l.releaseLease(leaseContext); err != nil && !errdefs.IsNotFound(err) {
			cleanupErrors = append(cleanupErrors, fmt.Errorf("release containerd lease: %w", err))
		}
		if err := l.client.Close(); err != nil {
			cleanupErrors = append(cleanupErrors, fmt.Errorf("close containerd client: %w", err))
		}
		if err := os.RemoveAll(l.workDir); err != nil {
			cleanupErrors = append(cleanupErrors, fmt.Errorf("remove Attempt directory: %w", err))
		}
		l.cleanupError = errors.Join(cleanupErrors...)
		if l.onCleanup != nil {
			l.onCleanup()
		}
	})
	return l.cleanupError
}
