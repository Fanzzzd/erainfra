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

	"github.com/Fanzzzd/runner-center/apps/runtime/internal/executor"
	"github.com/Fanzzzd/runner-center/apps/runtime/internal/firecracker"
	"github.com/Fanzzzd/runner-center/apps/runtime/internal/runtimeapi"
)

const maxJITBytes = 1 << 20
const maxExperimentBytes = 16 << 10

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
		return 2, errors.New("usage: runner-center-runtime version|serve|preflight|prepare|run|experiment")
	}
	if args[0] == "version" {
		fmt.Printf("runner-center-runtime %s\n", version)
		return 0, nil
	}
	if args[0] == "serve" {
		runtime, err := firecracker.New(runtimeConfig())
		if err != nil {
			return 2, err
		}
		if err := runtime.Preflight(ctx); err != nil {
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
		if err := client.Preflight(ctx); err != nil {
			return 1, err
		}
		return 0, nil
	case "prepare":
		image := strings.TrimSpace(os.Getenv("RC_IMAGE_RELEASE"))
		if image == "" {
			return 2, errors.New("RC_IMAGE_RELEASE is required")
		}
		if err := client.PrepareImage(ctx, image); err != nil {
			return 1, err
		}
		return 0, nil
	case "run":
		return runAttempt(ctx, client)
	case "experiment":
		return runExperiment(ctx, client)
	default:
		return 2, fmt.Errorf("unknown command %q", args[0])
	}
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
		Kind:         "ci",
		AttemptID:    strings.TrimSpace(os.Getenv("RC_ATTEMPT_ID")),
		RunnerName:   strings.TrimSpace(os.Getenv("RC_RUNNER_NAME")),
		Profile:      strings.TrimSpace(os.Getenv("RC_PROFILE")),
		ImageRelease: strings.TrimSpace(os.Getenv("RC_IMAGE_RELEASE")),
		VCPUs:        vCPUs,
		MemoryMiB:    memoryMiB,
		JITConfig:    strings.TrimSpace(string(payload)),
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
	setIfPresent(&config.CNIName, "RC_CNI_NAME")
	setIfPresent(&config.CNIConfigDir, "RC_CNI_CONFIG_DIR")
	setIfPresent(&config.CNIBinDir, "RC_CNI_BIN_DIR")
	setIfPresent(&config.WorkDir, "RC_RUNTIME_DIR")
	return config
}

func positiveInt64Env(name string) (int64, error) {
	value := strings.TrimSpace(os.Getenv(name))
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || parsed <= 0 {
		return 0, fmt.Errorf("%s must be a positive integer", name)
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
