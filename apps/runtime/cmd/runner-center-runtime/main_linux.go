//go:build linux

package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/executor"
	"github.com/Fanzzzd/erainfra/apps/runtime/internal/firecracker"
	"github.com/Fanzzzd/erainfra/apps/runtime/internal/netpolicy"
	"github.com/Fanzzzd/erainfra/apps/runtime/internal/runtimeapi"
	"github.com/Fanzzzd/erainfra/internal/dualenv"
)

const maxJITBytes = 1 << 20
const maxExperimentBytes = 16 << 10
const maxRecoveryBytes = 2 << 20

var version = "dev"

func main() {
	// One key=value line per record on stderr, the layout and stream logrus used here before; stdout
	// carries the JSON reports the Action Runner Agent parses.
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, nil)))
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	exitCode, err := run(ctx, os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
	}
	os.Exit(exitCode)
}

func run(ctx context.Context, args []string) (int, error) {
	if len(args) != 1 {
		return 2, errors.New(
			"usage: runner-center-runtime " +
				"version|serve|render-cni|render-nftables|verify-network|preflight|prepare|remove-profile|recover|run|experiment|sample",
		)
	}
	if args[0] == "version" {
		fmt.Printf("runner-center-runtime %s\n", version)
		return 0, nil
	}
	// Every subcommand below reads RC_<NAME> or ERAINFRA_<NAME>, the new name first. Two names
	// that disagree are refused here, before any of them is read, rather than resolved silently
	// (docs/runbooks/rename-phase-2.md, section 1).
	if err := dualenv.Check(); err != nil {
		return 2, err
	}
	// The provisioner renders both halves of the job network policy from the
	// same build that later verifies them, so an installed host can never drift
	// from what Preflight demands. Neither command needs the runtime socket.
	if args[0] == "render-cni" || args[0] == "render-nftables" {
		return renderNetwork(args[0])
	}
	if args[0] == "verify-network" {
		return verifyNetwork(ctx)
	}
	if args[0] == "serve" {
		config := runtimeConfig()
		key, err := cacheSigningKey()
		if err != nil {
			return 2, err
		}
		config.CacheSigningKey = key
		config.CacheServiceURL = strings.TrimSpace(dualenv.Value("RC_CACHE_SERVICE_URL"))
		config.RegistryMirrorURL = strings.TrimSpace(dualenv.Value("RC_REGISTRY_MIRROR_URL"))
		config.GitMirror, err = boolEnv("RC_GIT_MIRROR")
		if err != nil {
			return 2, err
		}
		runtime, err := firecracker.New(config)
		if err != nil {
			return 2, err
		}
		// The unit's ExecStartPre reloads the table, which empties every
		// per-guest set, so the resolver starts with no views and nothing stale.
		// Failing to listen is not fatal: public Profiles never need it, and
		// every audit or allowlist Profile reports its egress-policy check
		// failed until it serves.
		if err := runtime.ServeEgress(ctx); err != nil {
			fmt.Fprintf(os.Stderr, "host resolver unavailable; audit and allowlist Profiles are not ready: %v\n", err)
		}
		if _, err := runtime.Preflight(ctx, netpolicy.ProfileEgress{}); err != nil {
			return 1, err
		}
		// A hand reload of the table under running guests empties their sets;
		// this puts them back within seconds rather than at the next readiness
		// check.
		go runtime.KeepGuestElements(ctx)
		group := strings.TrimSpace(dualenv.Value("RC_RUNTIME_GROUP"))
		if group == "" {
			group = "runner-center"
		}
		if err := runtimeapi.Serve(ctx, runtimeSocket(), group, runtime); err != nil {
			return 1, err
		}
		return 0, nil
	}
	client, err := runtimeapi.NewClient(runtimeSocket())
	if err != nil {
		return 2, err
	}

	switch args[0] {
	case "preflight":
		egress, err := profileEgressEnv()
		if err != nil {
			return 2, err
		}
		report, err := client.Preflight(ctx, egress)
		// The Worker parses this document to publish readiness, so it is written
		// to stdout whether or not every check passed.
		if encodeErr := json.NewEncoder(os.Stdout).Encode(report); encodeErr != nil {
			return 1, fmt.Errorf("write readiness report: %w", encodeErr)
		}
		if err != nil {
			return 1, err
		}
		return 0, nil
	case "prepare":
		profile, err := profileEnv()
		if err != nil {
			return 2, err
		}
		status, err := client.PrepareProfile(ctx, profile)
		if encodeErr := json.NewEncoder(os.Stdout).Encode(status); encodeErr != nil {
			return 1, fmt.Errorf("write warm pool status: %w", encodeErr)
		}
		if err != nil {
			return 1, err
		}
		return 0, nil
	case "remove-profile":
		profile := strings.TrimSpace(dualenv.Value("RC_PROFILE"))
		if profile == "" {
			return 2, errors.New("RC_PROFILE is required")
		}
		if err := client.RemoveProfile(ctx, profile); err != nil {
			return 1, err
		}
		return 0, nil
	case "recover":
		return recoverOrphans(ctx, client)
	case "run":
		return runAttempt(ctx, client)
	case "experiment":
		return runExperiment(ctx, client)
	case "sample":
		return runSample(ctx, client)
	default:
		return 2, fmt.Errorf("unknown command %q", args[0])
	}
}

func recoverOrphans(ctx context.Context, client *runtimeapi.Client) (int, error) {
	payload, err := io.ReadAll(io.LimitReader(os.Stdin, maxRecoveryBytes+1))
	if err != nil {
		return 2, fmt.Errorf("read live Attempt IDs: %w", err)
	}
	if len(payload) > maxRecoveryBytes {
		return 2, errors.New("live Attempt IDs exceed 2 MiB")
	}
	var liveAttemptIDs []string
	if err := json.Unmarshal(payload, &liveAttemptIDs); err != nil {
		return 2, errors.New("live Attempt IDs must be a JSON array of strings")
	}
	if err := client.RecoverOrphans(ctx, liveAttemptIDs); err != nil {
		return 1, err
	}
	return 0, nil
}

func profileEnv() (executor.Profile, error) {
	vCPUs, err := positiveInt64Env("RC_VCPUS")
	if err != nil {
		return executor.Profile{}, err
	}
	memoryMiB, err := positiveInt64Env("RC_MEMORY_MIB")
	if err != nil {
		return executor.Profile{}, err
	}
	warmPool, err := nonnegativeIntEnv("RC_WARM_POOL")
	if err != nil {
		return executor.Profile{}, err
	}
	egress, err := profileEgressEnv()
	if err != nil {
		return executor.Profile{}, err
	}
	profile := executor.Profile{
		Name:         strings.TrimSpace(dualenv.Value("RC_PROFILE")),
		ImageRelease: strings.TrimSpace(dualenv.Value("RC_IMAGE_RELEASE")),
		VCPUs:        vCPUs,
		MemoryMiB:    memoryMiB,
		WarmPool:     warmPool,
		Egress:       egress,
	}
	if err := profile.Validate(); err != nil {
		return executor.Profile{}, err
	}
	return profile, nil
}

func runAttempt(ctx context.Context, client *runtimeapi.Client) (int, error) {
	payload, err := io.ReadAll(io.LimitReader(os.Stdin, maxJITBytes+1))
	if err != nil {
		return 2, fmt.Errorf("read JIT configuration: %w", err)
	}
	if len(payload) > maxJITBytes {
		return 2, errors.New("JIT configuration exceeds 1 MiB")
	}
	vCPUs, err := positiveInt64Env("RC_VCPUS")
	if err != nil {
		return 2, err
	}
	memoryMiB, err := positiveInt64Env("RC_MEMORY_MIB")
	if err != nil {
		return 2, err
	}
	egress, err := profileEgressEnv()
	if err != nil {
		return 2, err
	}
	spec := executor.Spec{
		Egress:          egress,
		Kind:            "ci",
		AttemptID:       strings.TrimSpace(dualenv.Value("RC_ATTEMPT_ID")),
		RunnerName:      strings.TrimSpace(dualenv.Value("RC_RUNNER_NAME")),
		Profile:         strings.TrimSpace(dualenv.Value("RC_PROFILE")),
		ImageRelease:    strings.TrimSpace(dualenv.Value("RC_IMAGE_RELEASE")),
		VCPUs:           vCPUs,
		MemoryMiB:       memoryMiB,
		JITConfig:       strings.TrimSpace(string(payload)),
		CacheURL:        strings.TrimSpace(dualenv.Value("RC_CACHE_URL")),
		CacheServiceV2:  strings.TrimSpace(dualenv.Value("RC_CACHE_SERVICE_V2")),
		CacheServiceURL: strings.TrimSpace(dualenv.Value("RC_CACHE_SERVICE_URL")),
	}
	// The raw bytes are a runner credential and spec holds its own copy, so
	// overwrite them; dropping the reference alone leaves them in memory.
	clear(payload)
	if err := spec.Validate(); err != nil {
		return 2, err
	}

	bootTimeout, err := durationEnv("RC_BOOT_TIMEOUT_S", 300*time.Second)
	if err != nil {
		return 2, err
	}
	jobTimeout, err := durationEnv("RC_JOB_TIMEOUT_S", 6*time.Hour)
	if err != nil {
		return 2, err
	}
	result, err := client.Execute(ctx, spec, bootTimeout, jobTimeout)
	spec.JITConfig = ""
	if err != nil {
		return 1, err
	}
	// The record is evidence, not the job's result: failing to hand it over is
	// reported, and the job's own exit code still stands.
	if recordErr := writeEgressRecord(result.Egress); recordErr != nil {
		fmt.Fprintln(os.Stderr, recordErr)
	}
	if reportErr := writeTestReport(result.Tests); reportErr != nil {
		fmt.Fprintln(os.Stderr, reportErr)
	}
	if exitErr := writeRunnerExit(result.RunnerExit); exitErr != nil {
		fmt.Fprintln(os.Stderr, exitErr)
	}
	return result.ExitCode, nil
}

func runExperiment(ctx context.Context, client *runtimeapi.Client) (int, error) {
	payload, err := io.ReadAll(io.LimitReader(os.Stdin, maxExperimentBytes+1))
	if err != nil {
		return 2, fmt.Errorf("read Experiment command: %w", err)
	}
	if len(payload) > maxExperimentBytes {
		return 2, errors.New("Experiment command exceeds 16 KiB") //nolint:staticcheck // ST1005: Experiment is a capitalized domain term here, like Attempt
	}
	var command []string
	if err := json.Unmarshal(payload, &command); err != nil {
		return 2, fmt.Errorf("decode Experiment command: %w", err)
	}
	vCPUs, err := positiveInt64Env("RC_VCPUS")
	if err != nil {
		return 2, err
	}
	memoryMiB, err := positiveInt64Env("RC_MEMORY_MIB")
	if err != nil {
		return 2, err
	}
	resultTokenBytes := make([]byte, 16)
	if _, err := rand.Read(resultTokenBytes); err != nil {
		return 1, fmt.Errorf("create Experiment result token: %w", err)
	}
	egress, err := profileEgressEnv()
	if err != nil {
		return 2, err
	}
	spec := executor.Spec{
		Egress:       egress,
		Kind:         "experiment",
		AttemptID:    strings.TrimSpace(dualenv.Value("RC_ATTEMPT_ID")),
		RunnerName:   strings.TrimSpace(dualenv.Value("RC_RUNNER_NAME")),
		Profile:      strings.TrimSpace(dualenv.Value("RC_PROFILE")),
		ImageRelease: strings.TrimSpace(dualenv.Value("RC_IMAGE_RELEASE")),
		VCPUs:        vCPUs,
		MemoryMiB:    memoryMiB,
		Command:      command,
		ResultToken:  hex.EncodeToString(resultTokenBytes),
	}
	if err := spec.Validate(); err != nil {
		return 2, err
	}

	bootTimeout, err := durationEnv("RC_BOOT_TIMEOUT_S", 300*time.Second)
	if err != nil {
		return 2, err
	}
	jobTimeout, err := durationEnv("RC_JOB_TIMEOUT_S", 6*time.Hour)
	if err != nil {
		return 2, err
	}
	result, err := client.Execute(ctx, spec, bootTimeout, jobTimeout)
	if err != nil {
		return 1, err
	}
	return result.ExitCode, nil
}

func renderNetwork(command string) (int, error) {
	config := runtimeConfig()
	if err := config.Validate(); err != nil {
		return 2, err
	}
	if command == "render-cni" {
		document, err := config.Network.Conflist()
		if err != nil {
			return 1, err
		}
		if _, err := os.Stdout.Write(document); err != nil {
			return 1, fmt.Errorf("write CNI configuration: %w", err)
		}
		return 0, nil
	}
	ruleset, err := config.Network.Nftables()
	if err != nil {
		return 1, err
	}
	if _, err := io.WriteString(os.Stdout, ruleset); err != nil {
		return 1, fmt.Errorf("write nftables ruleset: %w", err)
	}
	return 0, nil
}

// verifyNetwork re-checks the installed job network policy against this build's
// expectation without needing the privileged runtime to be running. An operator
// uses it after any host firewall change; readiness enforces the same two
// checks continuously.
func verifyNetwork(ctx context.Context) (int, error) {
	config := runtimeConfig()
	if err := config.Validate(); err != nil {
		return 2, err
	}
	var problems []error
	conflist, err := os.ReadFile(config.ConflistPath())
	switch {
	case err != nil:
		problems = append(problems, fmt.Errorf("read %s: %w", config.ConflistPath(), err))
	default:
		if verifyErr := config.Network.VerifyConflist(conflist); verifyErr != nil {
			problems = append(problems, verifyErr)
		} else {
			fmt.Printf("ok    CNI configuration %s\n", config.ConflistPath())
		}
	}
	if detail, err := firecracker.VerifyLiveNetwork(ctx, config.Network, config.NftBinary); err != nil {
		problems = append(problems, err)
	} else {
		fmt.Printf("ok    nftables table inet %s: %s\n", netpolicy.TableName, detail)
	}
	if len(problems) > 0 {
		return 1, errors.Join(problems...)
	}
	return 0, nil
}

func runtimeSocket() string {
	if value := strings.TrimSpace(dualenv.Value("RC_RUNTIME_SOCKET")); value != "" {
		return value
	}
	return "/run/runner-center/runtime.sock"
}

func runtimeConfig() firecracker.Config {
	config := firecracker.DefaultConfig()
	setIfPresent := func(destination *string, name string) {
		if value := strings.TrimSpace(dualenv.Value(name)); value != "" {
			*destination = value
		}
	}
	setIfPresent(&config.BinaryPath, "RC_FIRECRACKER_BINARY")
	setIfPresent(&config.KernelImagePath, "RC_KERNEL_IMAGE")
	setIfPresent(&config.KernelArgs, "RC_KERNEL_ARGS")
	setIfPresent(&config.ContainerdAddress, "RC_CONTAINERD_ADDRESS")
	setIfPresent(&config.ContainerdNamespace, "RC_CONTAINERD_NAMESPACE")
	setIfPresent(&config.Snapshotter, "RC_CONTAINERD_SNAPSHOTTER")
	setIfPresent(&config.CNIConfigDir, "RC_CNI_CONFIG_DIR")
	setIfPresent(&config.CNIBinDir, "RC_CNI_BIN_DIR")
	setIfPresent(&config.WorkDir, "RC_RUNTIME_DIR")
	setIfPresent(&config.NftBinary, "RC_NFT_BINARY")
	setIfPresent(&config.ThinPoolName, "RC_THIN_POOL")
	setIfPresent(&config.Network.Name, "RC_CNI_NAME")
	setIfPresent(&config.Network.Subnet, "RC_NETWORK_SUBNET")
	if value := strings.TrimSpace(dualenv.Value("RC_EGRESS_MODE")); value != "" {
		config.Network.EgressMode = netpolicy.EgressMode(value)
	}
	if value := commaSeparated("RC_EGRESS_ALLOW"); value != nil {
		config.Network.AllowedDestinations = value
	}
	if value := commaSeparated("RC_NAMESERVERS"); value != nil {
		config.Network.Nameservers = value
	}
	if value := strings.TrimSpace(dualenv.Value("RC_MIN_POOL_FREE_MIB")); value != "" {
		if parsed, err := strconv.ParseInt(value, 10, 64); err == nil {
			config.MinPoolFreeMiB = parsed
		}
	}
	return config
}

// cacheSigningKey reads the shared cache signing key from RC_CACHE_SIGNING_KEY or
// its _FILE variant. Both empty means no cache: the daemon mints no bearer and
// composes exactly the environment a fleet without a cache composes. The key is a
// long-lived host secret, so it is read only here in the long-running serve
// daemon, never in a per-Attempt invocation.
func cacheSigningKey() ([]byte, error) {
	value := dualenv.Value("RC_CACHE_SIGNING_KEY")
	file := strings.TrimSpace(dualenv.Value("RC_CACHE_SIGNING_KEY_FILE"))
	if value != "" && file != "" {
		return nil, errors.New("set RC_CACHE_SIGNING_KEY or RC_CACHE_SIGNING_KEY_FILE, not both")
	}
	if file != "" {
		contents, err := os.ReadFile(file)
		if err != nil {
			return nil, fmt.Errorf("read RC_CACHE_SIGNING_KEY_FILE: %w", err)
		}
		return []byte(strings.TrimSpace(string(contents))), nil
	}
	return []byte(strings.TrimSpace(value)), nil
}

// commaSeparated returns nil when the variable is unset, so an operator who
// sets nothing keeps the built-in policy rather than an empty list.
func commaSeparated(name string) []string {
	raw := strings.TrimSpace(dualenv.Value(name))
	if raw == "" {
		return nil
	}
	var values []string
	for _, value := range strings.Split(raw, ",") {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			values = append(values, trimmed)
		}
	}
	return values
}

func positiveInt64Env(name string) (int64, error) {
	value := strings.TrimSpace(dualenv.Value(name))
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || parsed <= 0 {
		return 0, fmt.Errorf("%s must be a positive integer", name)
	}
	return parsed, nil
}

// boolEnv reads an on/off switch. Unset is off; anything that is not a clear
// yes or no is refused, so a typo does not silently leave a feature off.
func boolEnv(name string) (bool, error) {
	switch strings.ToLower(strings.TrimSpace(dualenv.Value(name))) {
	case "", "0", "false", "off", "no":
		return false, nil
	case "1", "true", "on", "yes":
		return true, nil
	default:
		return false, fmt.Errorf("%s must be on or off", name)
	}
}

func nonnegativeIntEnv(name string) (int, error) {
	value := strings.TrimSpace(dualenv.Value(name))
	if value == "" {
		return 0, nil
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < 0 {
		return 0, fmt.Errorf("%s must be a non-negative integer", name)
	}
	return parsed, nil
}

func durationEnv(name string, fallback time.Duration) (time.Duration, error) {
	value := strings.TrimSpace(dualenv.Value(name))
	if value == "" {
		return fallback, nil
	}
	seconds, err := strconv.ParseInt(value, 10, 64)
	if err != nil || seconds <= 0 {
		return 0, fmt.Errorf("%s must be a positive integer number of seconds", name)
	}
	return time.Duration(seconds) * time.Second, nil
}
