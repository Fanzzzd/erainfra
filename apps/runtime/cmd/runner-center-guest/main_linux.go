//go:build linux

package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"os/user"
	"strconv"
	"syscall"

	"github.com/Fanzzzd/runner-center/apps/runtime/internal/guest"
)

const (
	mmdsURL        = "http://169.254.169.254"
	runnerDir      = "/opt/runner"
	toolCache      = "/opt/hostedtoolcache"
	actionCache    = "/opt/action-cache"
	runnerUsername = "runner"
	runnerGroup    = "docker"
	consoleDevice  = "/dev/console"
)

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := run(ctx); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// reportResult hands an Experiment's exit code back to the host.
//
// It writes to the guest console rather than to stdout on purpose. This process
// is a systemd service, so its stdout is the guest journal, which never leaves
// the VM; the host reads the Attempt's result off the serial console. Only the
// authenticated marker goes this way, so a CI job's output is not forced
// through an emulated serial port.
func reportResult(token string, exitCode int) error {
	console, err := os.OpenFile(consoleDevice, os.O_WRONLY, 0)
	if err != nil {
		return fmt.Errorf("open guest console: %w", err)
	}
	defer console.Close()
	if _, err := fmt.Fprintf(console, "\x1eRUNNER_CENTER_RESULT:%s:%d\n", token, exitCode); err != nil {
		return fmt.Errorf("report Experiment result: %w", err)
	}
	return nil
}

func run(ctx context.Context) error {
	metadata, err := guest.NewMetadataClient(mmdsURL, nil).Fetch(ctx)
	if err != nil {
		return err
	}
	if err := syscall.Sethostname([]byte(metadata.RunnerName)); err != nil {
		return fmt.Errorf("set hostname: %w", err)
	}

	runnerUser, err := user.Lookup(runnerUsername)
	if err != nil {
		return fmt.Errorf("lookup runner user: %w", err)
	}
	runnerGroupEntry, err := user.LookupGroup(runnerGroup)
	if err != nil {
		return fmt.Errorf("lookup runner group: %w", err)
	}
	uid, err := strconv.ParseUint(runnerUser.Uid, 10, 32)
	if err != nil {
		return fmt.Errorf("parse runner uid: %w", err)
	}
	gid, err := strconv.ParseUint(runnerGroupEntry.Gid, 10, 32)
	if err != nil {
		return fmt.Errorf("parse runner gid: %w", err)
	}
	groupIDs, err := runnerUser.GroupIds()
	if err != nil {
		return fmt.Errorf("lookup runner supplemental groups: %w", err)
	}
	groups := make([]uint32, 0, len(groupIDs))
	for _, value := range groupIDs {
		parsed, parseErr := strconv.ParseUint(value, 10, 32)
		if parseErr != nil {
			return fmt.Errorf("parse runner supplemental group: %w", parseErr)
		}
		groups = append(groups, uint32(parsed))
	}

	var command *exec.Cmd
	if metadata.Kind == "experiment" {
		command = exec.CommandContext(ctx, metadata.Command[0], metadata.Command[1:]...)
		command.Dir = runnerUser.HomeDir
	} else {
		command = exec.CommandContext(ctx, runnerDir+"/run.sh")
		command.Dir = runnerDir
	}
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	command.SysProcAttr = &syscall.SysProcAttr{
		Credential: &syscall.Credential{Uid: uint32(uid), Gid: uint32(gid), Groups: groups},
	}
	command.Env = []string{
		"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"HOME=" + runnerUser.HomeDir,
		"USER=" + runnerUser.Username,
		"LOGNAME=" + runnerUser.Username,
		"RUNNER_TOOL_CACHE=" + toolCache,
		"AGENT_TOOLSDIRECTORY=" + toolCache,
		"ACTIONS_RUNNER_ACTION_ARCHIVE_CACHE=" + actionCache,
	}
	if metadata.Kind != "experiment" {
		command.Env = append(command.Env, "ACTIONS_RUNNER_INPUT_JITCONFIG="+metadata.JITConfig)
	}
	if err := command.Start(); err != nil {
		return fmt.Errorf("start GitHub runner: %w", err)
	}
	// Drop our copy as soon as the runner has inherited it. The value is never
	// written to disk, argv, a host environment, or logs.
	metadata.JITConfig = ""
	err = command.Wait()
	if ctx.Err() != nil && errors.Is(ctx.Err(), context.Canceled) {
		return ctx.Err()
	}

	if metadata.Kind == "experiment" {
		exitCode := 0
		if err != nil {
			exitCode = 1
			var exitError *exec.ExitError
			if errors.As(err, &exitError) {
				exitCode = exitError.ExitCode()
			}
		}
		if reportErr := reportResult(metadata.ResultToken, exitCode); reportErr != nil {
			return reportErr
		}
	}
	if metadata.ShutdownOnExit {
		poweroff := exec.Command("systemctl", "poweroff", "--no-block")
		if poweroffErr := poweroff.Run(); poweroffErr != nil {
			return fmt.Errorf("power off after runner exit: %w", poweroffErr)
		}
	}
	if metadata.Kind == "experiment" {
		return nil
	}
	if err != nil {
		return fmt.Errorf("GitHub runner exited: %w", err)
	}
	return nil
}
