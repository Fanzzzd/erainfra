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
)

const maxJITBytes = 1 << 20
const maxExperimentBytes = 16 << 10
const maxRecoveryBytes = 2 << 20

var version = "dev"

func main() {
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
				"version|serve|render-cni|render-nftables|verify-network|preflight|prepare|remove-profile|recover|run|experiment",
		)
	}
	if args[0] == "version" {
		fmt.Printf("runner-center-runtime %s\n", version)
		return 0, nil
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
		config.CacheServiceURL = strings.TrimSpace(os.Getenv("RC_CACHE_SERVICE_URL"))
		runtime, err := firecracker.New(config)
		if err != nil {
			return 2, err
		}
		if _, err := runtime.Preflight(ctx); err != nil {
			return 1, err
		}
		group := strings.TrimSpace(os.Getenv("RC_RUNTIME_GROUP"))
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
		report, err := client.Preflight(ctx)
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
		profile := strings.TrimSpace(os.Getenv("RC_PROFILE"))
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
	profile := executor.Profile{
		Name:         strings.TrimSpace(os.Getenv("RC_PROFILE")),
		ImageRelease: strings.TrimSpace(os.Getenv("RC_IMAGE_RELEASE")),
		VCPUs:        vCPUs,
		MemoryMiB:    memoryMiB,
		WarmPool:     warmPool,
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
	spec := executor.Spec{
		Kind:            "ci",
		AttemptID:       strings.TrimSpace(os.Getenv("RC_ATTEMPT_ID")),
		RunnerName:      strings.TrimSpace(os.Getenv("RC_RUNNER_NAME")),
		Profile:         strings.TrimSpace(os.Getenv("RC_PROFILE")),
		ImageRelease:    strings.TrimSpace(os.Getenv("RC_IMAGE_RELEASE")),
		VCPUs:           vCPUs,
		MemoryMiB:       memoryMiB,
		JITConfig:       strings.TrimSpace(string(payload)),
		CacheURL:        strings.TrimSpace(os.Getenv("RC_CACHE_URL")),
		CacheServiceV2:  strings.TrimSpace(os.Getenv("RC_CACHE_SERVICE_V2")),
		CacheServiceURL: strings.TrimSpace(os.Getenv("RC_CACHE_SERVICE_URL")),
	}
	payload = nil
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
	return result.ExitCode, nil
}

func runExperiment(ctx context.Context, client *runtimeapi.Client) (int, error) {
	payload, err := io.ReadAll(io.LimitReader(os.Stdin, maxExperimentBytes+1))
	if err != nil {
		return 2, fmt.Errorf("read Experiment command: %w", err)
	}
	if len(payload) > maxExperimentBytes {
		return 2, errors.New("Experiment command exceeds 16 KiB")
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
	spec := executor.Spec{
		Kind:         "experiment",
		AttemptID:    strings.TrimSpace(os.Getenv("RC_ATTEMPT_ID")),
		RunnerName:   strings.TrimSpace(os.Getenv("RC_RUNNER_NAME")),
		Profile:      strings.TrimSpace(os.Getenv("RC_PROFILE")),
		ImageRelease: strings.TrimSpace(os.Getenv("RC_IMAGE_RELEASE")),
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
	live, err := netpolicy.ReadLiveTable(ctx, config.NftBinary)
	switch {
	case err != nil:
		problems = append(problems, err)
	default:
		if verifyErr := config.Network.VerifyNftables(live); verifyErr != nil {
			problems = append(problems, verifyErr)
		} else {
			fmt.Printf("ok    nftables table inet %s denies host, RFC1918 and east-west traffic for %s\n",
				netpolicy.TableName, config.Network.Subnet)
		}
	}
	if len(problems) > 0 {
		return 1, errors.Join(problems...)
	}
	return 0, nil
}

func runtimeSocket() string {
	if value := strings.TrimSpace(os.Getenv("RC_RUNTIME_SOCKET")); value != "" {
		return value
	}
	return "/run/runner-center/runtime.sock"
}

func runtimeConfig() firecracker.Config {
	config := firecracker.DefaultConfig()
	setIfPresent := func(destination *string, name string) {
		if value := strings.TrimSpace(os.Getenv(name)); value != "" {
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
	if value := strings.TrimSpace(os.Getenv("RC_EGRESS_MODE")); value != "" {
		config.Network.EgressMode = netpolicy.EgressMode(value)
	}
	if value := commaSeparated("RC_EGRESS_ALLOW"); value != nil {
		config.Network.AllowedDestinations = value
	}
	if value := commaSeparated("RC_NAMESERVERS"); value != nil {
		config.Network.Nameservers = value
	}
	if value := strings.TrimSpace(os.Getenv("RC_MIN_POOL_FREE_MIB")); value != "" {
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
	value := os.Getenv("RC_CACHE_SIGNING_KEY")
	file := strings.TrimSpace(os.Getenv("RC_CACHE_SIGNING_KEY_FILE"))
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
	raw := strings.TrimSpace(os.Getenv(name))
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
	value := strings.TrimSpace(os.Getenv(name))
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || parsed <= 0 {
		return 0, fmt.Errorf("%s must be a positive integer", name)
	}
	return parsed, nil
}

func nonnegativeIntEnv(name string) (int, error) {
	value := strings.TrimSpace(os.Getenv(name))
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
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback, nil
	}
	seconds, err := strconv.ParseInt(value, 10, 64)
	if err != nil || seconds <= 0 {
		return 0, fmt.Errorf("%s must be a positive integer number of seconds", name)
	}
	return time.Duration(seconds) * time.Second, nil
}
