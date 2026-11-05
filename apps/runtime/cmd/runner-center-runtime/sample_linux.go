//go:build linux

package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/jobmetrics"
	"github.com/Fanzzzd/erainfra/apps/runtime/internal/runtimeapi"
	"github.com/Fanzzzd/erainfra/internal/dualenv"
)

// runSample streams one Attempt's resource Snapshot to stdout as JSON lines
// until stdin closes or a signal arrives, then writes a final line and exits.
//
// The Worker runs this beside every Linux Attempt. Closing stdin is how it
// says the Attempt is over, and it is also what happens when the Worker
// itself dies, so an orphaned sampler cannot outlive the Agent that started
// it. It never affects the Attempt: it reads, and its exit code is ignored.
//
//   - RC_EXECUTOR=firecracker asks the privileged runtime, which samples the
//     microVM it owns, for RC_ATTEMPT_ID's Snapshot.
//   - RC_EXECUTOR=docker samples container RC_RUNNER_NAME's cgroup here, as
//     the Agent's user. cgroupfs and /proc/<pid>/net/dev are world-readable,
//     and Docker access is already what the Docker executor runs on.
func runSample(ctx context.Context, client *runtimeapi.Client) (int, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		_, _ = io.Copy(io.Discard, os.Stdin)
		cancel()
	}()
	every := jobmetrics.DefaultReportInterval
	if value := strings.TrimSpace(dualenv.Value("RC_METRICS_REPORT_S")); value != "" {
		seconds, err := strconv.Atoi(value)
		if err != nil || seconds < 1 || seconds > 3600 {
			return 2, errors.New("RC_METRICS_REPORT_S must be between 1 and 3600")
		}
		every = time.Duration(seconds) * time.Second
	}

	switch strings.TrimSpace(dualenv.Value("RC_EXECUTOR")) {
	case "firecracker":
		attemptID := strings.TrimSpace(dualenv.Value("RC_ATTEMPT_ID"))
		if attemptID == "" {
			return 2, errors.New("RC_ATTEMPT_ID is required")
		}
		collect := func(ctx context.Context) (jobmetrics.Snapshot, bool) {
			response, err := client.Metrics(ctx, attemptID)
			if err != nil || !response.Found {
				return jobmetrics.Snapshot{}, false
			}
			return response.Snapshot, true
		}
		if err := jobmetrics.WriteReports(ctx, os.Stdout, every, collect); err != nil {
			return 1, err
		}
		return 0, nil
	case "docker":
		name := strings.TrimSpace(dualenv.Value("RC_RUNNER_NAME"))
		if name == "" {
			return 2, errors.New("RC_RUNNER_NAME is required")
		}
		container := &containerSampler{}
		go container.attach(ctx, name)
		collect := func(context.Context) (jobmetrics.Snapshot, bool) {
			return container.snapshot(ctx.Err() != nil)
		}
		if err := jobmetrics.WriteReports(ctx, os.Stdout, every, collect); err != nil {
			return 1, err
		}
		return 0, nil
	default:
		return 2, errors.New("RC_EXECUTOR must be firecracker or docker")
	}
}

// containerSampler waits for the Attempt's container to exist, then samples
// its cgroup. The provisioner validates its inputs before `docker run`, so the
// container appears a moment after this process starts.
type containerSampler struct {
	mu      sync.Mutex
	sampler *jobmetrics.Sampler
}

func (c *containerSampler) attach(ctx context.Context, name string) {
	for {
		if pid, err := containerPID(ctx, name); err == nil && pid > 0 {
			source, err := jobmetrics.ResolveCgroup("/proc", "/sys/fs/cgroup", pid)
			if err != nil {
				fmt.Fprintf(os.Stderr, "container %s runs unmeasured: %v\n", name, err)
				return
			}
			c.mu.Lock()
			if ctx.Err() == nil {
				c.sampler = jobmetrics.StartSampler(ctx, source, jobmetrics.DefaultSampleInterval)
			}
			c.mu.Unlock()
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(2 * time.Second):
		}
	}
}

// snapshot returns the container's Snapshot. stop takes the closing reading
// and ends sampling first, for the final report.
func (c *containerSampler) snapshot(stop bool) (jobmetrics.Snapshot, bool) {
	c.mu.Lock()
	sampler := c.sampler
	c.mu.Unlock()
	if sampler == nil {
		return jobmetrics.Snapshot{}, false
	}
	if stop {
		sampler.Stop()
	}
	return sampler.Snapshot(), true
}

// containerPID is the container's init process on the host, or 0 while it
// is not running. Asked once per container, not per reading.
func containerPID(ctx context.Context, name string) (int, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "docker", "inspect", "--format", "{{.State.Pid}}", name).Output()
	if err != nil {
		return 0, err
	}
	return strconv.Atoi(strings.TrimSpace(string(output)))
}
