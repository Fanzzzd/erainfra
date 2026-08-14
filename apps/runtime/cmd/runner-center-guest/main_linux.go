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
	"strings"
	"syscall"

	"github.com/Fanzzzd/EraInfra/apps/runtime/internal/guest"
)

const (
	mmdsURL        = "http://169.254.169.254"
	runnerDir      = "/opt/runner"
	toolCache      = "/opt/hostedtoolcache"
	actionCache    = "/opt/action-cache"
	runnerUsername = "runner"
	runnerGroup    = "docker"
	consoleDevice  = "/dev/console"
	hostsFile      = "/etc/hosts"
	// publishedResolvers is where the kernel records the resolvers it was given
	// by the ip= boot argument, already in resolv.conf syntax.
	publishedResolvers = "/proc/net/pnp"
	resolvConf         = "/etc/resolv.conf"
)

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := run(ctx); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// resolverConfig turns what the kernel published into a resolv.conf.
//
// A container image carries an empty /etc/resolv.conf, and a Firecracker guest
// runs no DHCP client, so without this nothing in the job can resolve a name --
// not github.com, not a registry, not the package mirror. The resolvers are
// already inside the VM: the Profile's network policy names them, CNI puts them
// in its DNS section, and firecracker-go-sdk turns that into the kernel's ip=
// boot argument, which the kernel records at /proc/net/pnp. Copying them from
// there keeps the Profile the single source of truth rather than baking
// resolvers into the image.
func resolverConfig(published []byte) (string, error) {
	var directives []string
	for _, line := range strings.Split(string(published), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		switch fields[0] {
		case "nameserver", "domain", "search":
			directives = append(directives, strings.Join(fields, " "))
		}
	}
	if len(directives) == 0 {
		return "", errors.New(
			"the guest kernel published no resolver, so the Profile's nameservers never reached this VM",
		)
	}
	return strings.Join(directives, "\n") + "\n", nil
}

func configureResolver() error {
	published, err := os.ReadFile(publishedResolvers)
	if err != nil {
		return fmt.Errorf("read %s: %w", publishedResolvers, err)
	}
	config, err := resolverConfig(published)
	if err != nil {
		return err
	}
	if err := os.WriteFile(resolvConf, []byte(config), 0o644); err != nil {
		return fmt.Errorf("write %s: %w", resolvConf, err)
	}
	return nil
}

// publishHostname makes the name this VM just took resolvable inside it.
//
// Setting the hostname without a matching /etc/hosts entry leaves every
// name-resolving tool in the job looking the Attempt's own name up over the
// network: sudo prints "unable to resolve host" on each invocation and waits
// for a real DNS round trip first, on a machine whose whole point is to be
// short-lived. 127.0.1.1 is the address Debian and Ubuntu reserve for exactly
// this.
func publishHostname(name string) error {
	hosts, err := os.ReadFile(hostsFile)
	if err != nil {
		return fmt.Errorf("read %s: %w", hostsFile, err)
	}
	for _, line := range strings.Fields(string(hosts)) {
		if line == name {
			return nil
		}
	}
	if len(hosts) > 0 && !strings.HasSuffix(string(hosts), "\n") {
		hosts = append(hosts, '\n')
	}
	hosts = append(hosts, fmt.Sprintf("127.0.1.1\t%s\n", name)...)
	if err := os.WriteFile(hostsFile, hosts, 0o644); err != nil {
		return fmt.Errorf("write %s: %w", hostsFile, err)
	}
	return nil
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
	if err := publishHostname(metadata.RunnerName); err != nil {
		return err
	}
	if err := configureResolver(); err != nil {
		return err
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
		// Reset, not power off. Firecracker exposes no power management device,
		// so a guest that asks to power off runs the whole shutdown sequence and
		// then sits at "reboot: System halted" with the VMM still alive -- the
		// Attempt only ends when its job timeout expires, hours later. A reset is
		// what the VMM listens for: with reboot=k on the command line the kernel
		// pulses the i8042 reset line, Firecracker sees it and exits. systemd
		// still stops every unit and unmounts the root first.
		reset := exec.Command("systemctl", "reboot", "--no-block")
		if resetErr := reset.Run(); resetErr != nil {
			return fmt.Errorf("reset the microVM after runner exit: %w", resetErr)
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
