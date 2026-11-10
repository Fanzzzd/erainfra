//go:build linux

package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"os/user"
	"strconv"
	"strings"
	"sync"
	"syscall"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/guest"
	"github.com/Fanzzzd/erainfra/apps/runtime/internal/guestcache"
	"github.com/Fanzzzd/erainfra/apps/runtime/internal/runnerexit"
	"github.com/Fanzzzd/erainfra/apps/runtime/internal/testreport"
)

const (
	mmdsURL   = "http://169.254.169.254"
	runnerDir = "/opt/runner"
	// runnerWorkDir is the runner's work folder: the controller asks GitHub
	// for JIT configurations with the GitHub-hosted runner's work folder
	// (githubscale.WorkFolder), so workspaces and actions/cache paths match a
	// hosted runner's.
	runnerWorkDir = "/home/runner/work"
	// legacyRunnerWorkDir is where a controller from before that change still
	// puts workspaces (WorkFolder "_work", relative to runnerDir). The
	// collector falls back to it so a mixed-version fleet keeps its reports.
	legacyRunnerWorkDir = runnerDir + "/_work"
	// runnerDiagDir is where the runner writes its Runner_*.log and, for each
	// job, a Worker_*.log.
	runnerDiagDir  = runnerDir + "/_diag"
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
	warmReadyMarker    = "\x1eRUNNER_CENTER_WARM_READY\n"
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
//
// The options line is decided here rather than inherited, and it is the
// Docker executor's decision (provision-docker.sh): edns0, because
// ubuntu-latest sets it and without it glibc advertises a 512-byte UDP limit,
// so a large TXT, SRV or DNSSEC-signed answer comes back truncated and is
// retried over TCP. trust-ad is deliberately left out even though
// ubuntu-latest has it. It makes glibc believe the AD bit in a reply, which is
// only sound for a trusted resolver on a trusted path; hosted's is
// systemd-resolved on loopback, and this guest's are the Profile's resolvers
// across the network.
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
	directives = append(directives, "options edns0")
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

// publishHostname makes localhost and the name this VM just took resolvable
// inside it.
//
// The rootfs comes from a container image, whose /etc/hosts is empty: Docker
// writes the loopback entries at run time and Firecracker does not. Without
// them Node's dns.lookup("localhost") fails with ENOTFOUND, so any test
// runner that binds or dials localhost dies at startup.
//
// Setting the hostname without a matching entry leaves every name-resolving
// tool in the job looking the Attempt's own name up over the network: sudo
// prints "unable to resolve host" on each invocation and waits for a real DNS
// round trip first. 127.0.1.1 is the address Debian and Ubuntu reserve for
// exactly this.
func publishHostname(name string) error {
	hosts, err := os.ReadFile(hostsFile)
	if err != nil {
		return fmt.Errorf("read %s: %w", hostsFile, err)
	}
	updated := hostsWithEntries(hosts, name)
	if string(updated) == string(hosts) {
		return nil
	}
	if err := os.WriteFile(hostsFile, updated, 0o644); err != nil {
		return fmt.Errorf("write %s: %w", hostsFile, err)
	}
	return nil
}

// hostsWithEntries returns hosts with the Ubuntu loopback entries and a
// 127.0.1.1 line for name appended, each only when no live line already maps
// that name for that address family. Existing lines are kept as they are.
func hostsWithEntries(hosts []byte, name string) []byte {
	var hasV4Localhost, hasV6Localhost, hasName bool
	for _, line := range strings.Split(string(hosts), "\n") {
		if comment := strings.IndexByte(line, '#'); comment >= 0 {
			line = line[:comment]
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		v6 := strings.Contains(fields[0], ":")
		for _, alias := range fields[1:] {
			switch {
			case alias == "localhost" && v6:
				hasV6Localhost = true
			case alias == "localhost":
				hasV4Localhost = true
			case alias == name:
				hasName = true
			}
		}
	}
	out := append([]byte(nil), hosts...)
	add := func(line string) {
		if len(out) > 0 && out[len(out)-1] != '\n' {
			out = append(out, '\n')
		}
		out = append(out, line...)
	}
	if !hasV4Localhost {
		add("127.0.0.1\tlocalhost\n")
	}
	if !hasV6Localhost {
		add("::1\tlocalhost ip6-localhost ip6-loopback\n")
	}
	if !hasName {
		add(fmt.Sprintf("127.0.1.1\t%s\n", name))
	}
	return out
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
	defer console.Close() //nolint:errcheck // the marker went out in write(2) to a character device; close flushes nothing
	if _, err := fmt.Fprintf(console, "\x1eRUNNER_CENTER_RESULT:%s:%d\n", token, exitCode); err != nil {
		return fmt.Errorf("report Experiment result: %w", err)
	}
	return nil
}

// reportTests hands the job's JUnit results to the host on the console, the
// same channel the Experiment result takes, once the runner has exited. The
// workspace is still on disk then: an ephemeral runner leaves its work
// directory for the VM's teardown to discard.
//
// It runs as root after the job, so the job sees no extra step and cannot
// stop it from running, and it is bounded (testreport.DefaultBudget, file and
// byte caps) so a workspace built to stall it delays the reset by seconds at
// most. Collection is best effort: a failure is logged in the guest journal
// and the Attempt reports no test results, exactly as a job without JUnit
// files does.
func reportTests(ctx context.Context) {
	report, err := testreport.Collector{WorkDir: testreport.FirstExistingDir(runnerWorkDir, legacyRunnerWorkDir)}.Collect(ctx)
	if err != nil {
		fmt.Fprintf(os.Stderr, "test results not collected: %v\n", err)
		return
	}
	if report == nil {
		return
	}
	console, err := os.OpenFile(consoleDevice, os.O_WRONLY, 0)
	if err != nil {
		fmt.Fprintf(os.Stderr, "test results not reported: open guest console: %v\n", err)
		return
	}
	defer console.Close() //nolint:errcheck // every line went out in its own write(2); close flushes nothing
	if err := testreport.WriteConsole(console, report); err != nil {
		fmt.Fprintf(os.Stderr, "test results not reported: %v\n", err)
	}
}

// runnerExitCode is the exit status Wait returned for run.sh: the process's
// own, or 128 plus the signal that ended it, as a shell reports it.
func runnerExitCode(err error) int {
	if err == nil {
		return 0
	}
	var exitError *exec.ExitError
	if !errors.As(err, &exitError) {
		return 1
	}
	if status, ok := exitError.Sys().(syscall.WaitStatus); ok && status.Signaled() {
		return 128 + int(status.Signal())
	}
	return exitError.ExitCode()
}

// reportRunnerExit tells the host how the runner ended, on the console, as
// the last line the guest writes before it resets: its exit status, whether
// it ran a job, and the last error in its diagnostic log. A runner GitHub
// refuses at session start exits in seconds and the guest still resets
// cleanly, so without this the host cannot tell it from a finished job.
// Best effort like the test report: a failure is logged in the guest journal
// and the Attempt is settled as it was before guests reported this.
func reportRunnerExit(waitErr error) {
	line, err := runnerexit.Line(runnerexit.Collect(runnerDiagDir, runnerExitCode(waitErr)))
	if err != nil {
		fmt.Fprintf(os.Stderr, "runner exit not reported: %v\n", err)
		return
	}
	console, err := os.OpenFile(consoleDevice, os.O_WRONLY, 0)
	if err != nil {
		fmt.Fprintf(os.Stderr, "runner exit not reported: open guest console: %v\n", err)
		return
	}
	defer console.Close() //nolint:errcheck // the line went out in one write(2); close flushes nothing
	if _, err := io.WriteString(console, line); err != nil {
		fmt.Fprintf(os.Stderr, "runner exit not reported: %v\n", err)
	}
}

func reportWarmReady() error {
	console, err := os.OpenFile(consoleDevice, os.O_WRONLY, 0)
	if err != nil {
		return fmt.Errorf("open guest console: %w", err)
	}
	defer console.Close() //nolint:errcheck // the marker went out in write(2) to a character device; close flushes nothing
	if _, err := io.WriteString(console, warmReadyMarker); err != nil {
		return fmt.Errorf("report warm readiness: %w", err)
	}
	return nil
}

// runnerEnv IS the runner's environment: built from nothing, so what a job is
// handed is a decision this function makes and a test can read. Nothing from
// the unit file or this process's own environment leaks through -- which is
// also why an Environment= line on runner-center-guest.service can never reach
// a job (#110 measured exactly that: LANG unset, glibc answering
// ANSI_X3.4-1968 while the image's /etc/default/locale said C.UTF-8).
func runnerEnv(metadata guest.Metadata, home, username, cacheTrustAnchorPath string, buildCacheEnv []string) []string {
	env := []string{
		// Hosted parity for Rust: ubuntu-latest puts rustup's stable toolchain
		// under the runner's home and hands jobs these three (the image
		// installs it there).
		"PATH=" + home + "/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"CARGO_HOME=" + home + "/.cargo",
		"RUSTUP_HOME=" + home + "/.rustup",
		"HOME=" + home,
		"USER=" + username,
		"LOGNAME=" + username,
		// Hosted parity: ubuntu-latest hands every job C.UTF-8, and a job that
		// gets no LANG at all collates and encodes differently in ways that
		// surface as test failures three layers away (#94, #110).
		"LANG=C.UTF-8",
		"RUNNER_TOOL_CACHE=" + toolCache,
		"AGENT_TOOLSDIRECTORY=" + toolCache,
		"ACTIONS_RUNNER_ACTION_ARCHIVE_CACHE=" + actionCache,
	}
	if metadata.Kind != "experiment" {
		env = append(env, "ACTIONS_RUNNER_INPUT_JITCONFIG="+metadata.JITConfig)
	}
	// The T0 cache tier (#81): present before the runner starts, which is the
	// only place a cache value can still be by probe run 32109974600. Only
	// these two -- ACTIONS_RESULTS_URL and ACTIONS_RUNTIME_TOKEN are shared
	// with the artifact service and are never written here.
	if metadata.CacheURL != "" {
		env = append(env, "ACTIONS_CACHE_URL="+metadata.CacheURL)
	}
	if metadata.CacheServiceV2 != "" {
		env = append(env, "ACTIONS_CACHE_SERVICE_V2="+metadata.CacheServiceV2)
	}
	// When the in-guest cache interceptor is up, every client the job runs has
	// to trust the leaf it serves. The system store already holds the CA; these
	// point the clients that ignore it (Node, Python requests, httpx) at the CA
	// or the rebuilt bundle. guestcache.TrustEnv says which and why. Empty when
	// there is no interceptor, and empty changes nothing.
	if cacheTrustAnchorPath != "" {
		env = append(env, guestcache.TrustEnv(cacheTrustAnchorPath)...)
	}
	// When the build cache proxy is up: TURBO_API, TURBO_TOKEN and TURBO_TEAM,
	// so turbo uses the cache with no workflow change, and the address the
	// opt-in Go helper reads. No credential among them (BuildProxy.Env).
	env = append(env, buildCacheEnv...)
	return env
}

func run(ctx context.Context) error {
	if err := configureResolver(); err != nil {
		return err
	}
	if err := reportWarmReady(); err != nil {
		return err
	}
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

	// Point GitHub's cache host at an in-guest interceptor when the host handed
	// this VM a cache. Best-effort: a redirect that will not set up leaves the
	// guest talking to GitHub directly, exactly as a guest without a cache does,
	// rather than failing the job.
	cacheTrustAnchorPath := ""
	if metadata.CacheServiceURL != "" && metadata.CacheRunnerToken != "" {
		caPath, stop, cacheErr := startCacheRedirect(ctx, metadata)
		if cacheErr != nil {
			fmt.Fprintf(os.Stderr, "job cache redirect disabled: %v\n", cacheErr)
		} else {
			defer stop()
			cacheTrustAnchorPath = caPath
		}
	}
	// The build cache proxy needs only the cache service and the bearer, not
	// the redirect, so it comes up even when the redirect did not. Best-effort
	// the same way: without it, turbo and Go build exactly as they would on a
	// guest with no cache.
	var buildCacheEnv []string
	if metadata.CacheServiceURL != "" && metadata.CacheRunnerToken != "" {
		proxy, proxyErr := startBuildCacheProxy(metadata)
		if proxyErr != nil {
			fmt.Fprintf(os.Stderr, "build cache proxy disabled: %v\n", proxyErr)
		} else {
			defer closeBuildCacheProxy(proxy)
			buildCacheEnv = proxy.Env()
		}
	}
	configureGuestDocker(ctx, metadata.RegistryMirrorURL, cacheTrustAnchorPath, runnerUser.HomeDir, int(uid), int(gid))
	// Point the job's git at the checkout mirror when the host turned it on.
	// Best-effort like the cache: without it, git fetches from GitHub.
	stopGitMirror := sync.OnceFunc(startGitMirrorIfEnabled(ctx, metadata))
	defer stopGitMirror()

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
	command.Env = runnerEnv(metadata, runnerUser.HomeDir, runnerUser.Username, cacheTrustAnchorPath, buildCacheEnv)
	if err := command.Start(); err != nil {
		return fmt.Errorf("start GitHub runner: %w", err)
	}
	// Drop our copy as soon as the runner has inherited it. The value is never
	// written to disk, argv, a host environment, or logs.
	metadata.JITConfig = ""
	err = command.Wait()
	// Before the reset below: a seed save started during the job gets its
	// grace period to finish, and the VM is not torn down under it.
	stopGitMirror()
	if ctx.Err() != nil && errors.Is(ctx.Err(), context.Canceled) {
		return ctx.Err()
	}

	if metadata.Kind != "experiment" {
		reportTests(ctx)
		reportRunnerExit(err)
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
		// Without cancel: a SIGTERM that lands after the runner has exited must
		// not stop the reset, since the reset is what ends the VMM.
		reset := exec.CommandContext(context.WithoutCancel(ctx), "systemctl", "reboot", "--no-block")
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
