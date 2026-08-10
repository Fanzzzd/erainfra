//go:build linux

package firecracker

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/Fanzzzd/runner-center/apps/runtime/internal/executor"
	"github.com/containerd/containerd"
	"github.com/containerd/containerd/leases"
	"github.com/containerd/containerd/namespaces"
	"github.com/containerd/errdefs"
	fc "github.com/firecracker-microvm/firecracker-go-sdk"
	"github.com/firecracker-microvm/firecracker-go-sdk/client/models"
	"github.com/opencontainers/image-spec/identity"
	"github.com/sirupsen/logrus"
)

type Runtime struct {
	config Config
}

// Recover removes leases and private work directories left by a runtime process
// that was killed before its normal per-Attempt cleanup completed. Serve calls
// it while holding the single-daemon lock, before accepting new work.
func (r *Runtime) Recover(ctx context.Context) error {
	client, err := containerd.New(r.config.ContainerdAddress)
	if err != nil {
		return fmt.Errorf("connect to containerd: %w", err)
	}
	defer client.Close()
	ctx = namespaces.WithNamespace(ctx, r.config.ContainerdNamespace)
	all, err := client.LeasesService().List(ctx)
	if err != nil {
		return fmt.Errorf("list containerd leases: %w", err)
	}
	var cleanupErrors []error
	for _, lease := range all {
		if !strings.HasPrefix(lease.ID, "runner-center/attempts/") {
			continue
		}
		if err := client.LeasesService().Delete(ctx, lease, leases.SynchronousDelete); err != nil && !errdefs.IsNotFound(err) {
			cleanupErrors = append(cleanupErrors, fmt.Errorf("delete lease %s: %w", lease.ID, err))
		}
	}
	if err := os.RemoveAll(r.config.WorkDir); err != nil {
		cleanupErrors = append(cleanupErrors, fmt.Errorf("remove abandoned runtime directories: %w", err))
	}
	if err := os.MkdirAll(r.config.WorkDir, 0o700); err != nil {
		cleanupErrors = append(cleanupErrors, fmt.Errorf("recreate runtime directory: %w", err))
	}
	return errors.Join(cleanupErrors...)
}

func New(config Config) (*Runtime, error) {
	if err := config.Validate(); err != nil {
		return nil, fmt.Errorf("invalid Firecracker configuration: %w", err)
	}
	return &Runtime{config: config}, nil
}

func (r *Runtime) Preflight(ctx context.Context) error {
	if _, err := exec.LookPath(r.config.BinaryPath); err != nil {
		return fmt.Errorf("find Firecracker binary: %w", err)
	}
	if err := readableRegularFile(r.config.KernelImagePath); err != nil {
		return fmt.Errorf("kernel image: %w", err)
	}
	kvm, err := os.OpenFile("/dev/kvm", os.O_RDWR, 0)
	if err != nil {
		return fmt.Errorf("open /dev/kvm read-write: %w", err)
	}
	_ = kvm.Close()
	for _, plugin := range []string{"bridge", "firewall", "host-local", "tc-redirect-tap"} {
		path := filepath.Join(r.config.CNIBinDir, plugin)
		if err := executableRegularFile(path); err != nil {
			return fmt.Errorf("CNI plugin %s: %w", plugin, err)
		}
	}
	if _, err := os.Stat(filepath.Join(r.config.CNIConfigDir, "10-"+r.config.CNIName+".conflist")); err != nil {
		return fmt.Errorf("CNI configuration: %w", err)
	}

	client, err := containerd.New(r.config.ContainerdAddress, containerd.WithTimeout(5*time.Second))
	if err != nil {
		return fmt.Errorf("connect to containerd: %w", err)
	}
	defer client.Close()
	response, err := client.IntrospectionService().Plugins(ctx, []string{
		"type==io.containerd.snapshotter.v1",
		"id==" + r.config.Snapshotter,
	})
	if err != nil {
		return fmt.Errorf("query containerd snapshotter: %w", err)
	}
	if len(response.Plugins) != 1 || response.Plugins[0].InitErr != nil {
		return fmt.Errorf("containerd snapshotter %q is not ready", r.config.Snapshotter)
	}
	return nil
}

func (r *Runtime) PrepareImage(ctx context.Context, imageRelease string) error {
	if err := validateImageRelease(imageRelease); err != nil {
		return err
	}
	client, err := containerd.New(r.config.ContainerdAddress)
	if err != nil {
		return fmt.Errorf("connect to containerd: %w", err)
	}
	defer client.Close()
	ctx = namespaces.WithNamespace(ctx, r.config.ContainerdNamespace)
	_, err = ensureImage(ctx, client, r.config.Snapshotter, imageRelease)
	return err
}

func (r *Runtime) Start(ctx context.Context, spec executor.Spec) (_ executor.Lease, returnedError error) {
	if err := spec.Validate(); err != nil {
		return nil, fmt.Errorf("invalid Attempt: %w", err)
	}
	if err := r.Preflight(ctx); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(r.config.WorkDir, 0o700); err != nil {
		return nil, fmt.Errorf("create runtime directory: %w", err)
	}
	workDir, err := os.MkdirTemp(r.config.WorkDir, spec.AttemptID+"-")
	if err != nil {
		return nil, fmt.Errorf("create Attempt directory: %w", err)
	}
	defer func() {
		if returnedError != nil {
			_ = os.RemoveAll(workDir)
		}
	}()

	client, err := containerd.New(r.config.ContainerdAddress)
	if err != nil {
		return nil, fmt.Errorf("connect to containerd: %w", err)
	}
	defer func() {
		if returnedError != nil {
			_ = client.Close()
		}
	}()
	containerdContext := namespaces.WithNamespace(context.Background(), r.config.ContainerdNamespace)
	leaseID := "runner-center/attempts/" + spec.AttemptID
	leaseContext, releaseLease, err := client.WithLease(containerdContext, leases.WithID(leaseID))
	if err != nil {
		return nil, fmt.Errorf("create containerd lease: %w", err)
	}
	leaseOwned := true
	defer func() {
		if returnedError != nil && leaseOwned {
			cleanupContext, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			_ = releaseLease(cleanupContext)
		}
	}()

	image, err := ensureImage(leaseContext, client, r.config.Snapshotter, spec.ImageRelease)
	if err != nil {
		return nil, err
	}
	rootFS, err := image.RootFS(leaseContext)
	if err != nil {
		return nil, fmt.Errorf("read image root filesystem: %w", err)
	}
	snapshotKey := "runner-center-" + spec.AttemptID
	snapshotter := client.SnapshotService(r.config.Snapshotter)
	if _, err := snapshotter.Prepare(leaseContext, snapshotKey, identity.ChainID(rootFS).String()); err != nil {
		return nil, fmt.Errorf("prepare writable root snapshot: %w", err)
	}
	mounts, err := snapshotter.Mounts(leaseContext, snapshotKey)
	if err != nil {
		return nil, fmt.Errorf("resolve root snapshot: %w", err)
	}
	if len(mounts) != 1 || mounts[0].Source == "" {
		return nil, fmt.Errorf("snapshotter returned %d root mounts, want one block source", len(mounts))
	}

	consolePath := filepath.Join(workDir, "console.log")
	console, err := os.OpenFile(consolePath, os.O_CREATE|os.O_RDWR|os.O_EXCL, 0o600)
	if err != nil {
		return nil, fmt.Errorf("create VM console log: %w", err)
	}
	defer func() {
		if returnedError != nil {
			_ = console.Close()
		}
	}()

	vmmContext, cancelVMM := context.WithCancel(context.Background())
	command := fc.VMCommandBuilder{}.
		WithBin(r.config.BinaryPath).
		WithSocketPath(filepath.Join(workDir, "firecracker.sock")).
		WithStdout(console).
		WithStderr(console).
		Build(vmmContext)
	logger := logrus.New()
	logger.SetOutput(io.Discard)
	logger.SetLevel(logrus.PanicLevel)

	machine, err := fc.NewMachine(vmmContext, fc.Config{
		VMID:            spec.AttemptID,
		SocketPath:      filepath.Join(workDir, "firecracker.sock"),
		KernelImagePath: r.config.KernelImagePath,
		KernelArgs:      r.config.KernelArgs,
		MachineCfg: models.MachineConfiguration{
			VcpuCount:  fc.Int64(spec.VCPUs),
			MemSizeMib: fc.Int64(spec.MemoryMiB),
		},
		Drives: []models.Drive{{
			DriveID:      fc.String("rootfs"),
			PathOnHost:   fc.String(mounts[0].Source),
			IsRootDevice: fc.Bool(true),
			IsReadOnly:   fc.Bool(false),
		}},
		NetworkInterfaces: []fc.NetworkInterface{{
			AllowMMDS: true,
			CNIConfiguration: &fc.CNIConfiguration{
				NetworkName: r.config.CNIName,
				IfName:      "eth0",
				ConfDir:     r.config.CNIConfigDir,
				BinPath:     []string{r.config.CNIBinDir},
			},
		}},
		MmdsAddress: net.IPv4(169, 254, 169, 254),
		MmdsVersion: fc.MMDSv2,
		LogPath:     filepath.Join(workDir, "firecracker.log"),
		LogLevel:    "Warning",
	}, fc.WithProcessRunner(command), fc.WithLogger(logrus.NewEntry(logger)))
	if err != nil {
		cancelVMM()
		return nil, fmt.Errorf("create Firecracker VM: %w", err)
	}
	metadata := map[string]any{
		"latest": map[string]any{
			"meta-data": map[string]any{
				"runner-center": map[string]any{
					"kind":               spec.Kind,
					"runner_name":        spec.RunnerName,
					"runner_jit_config":  spec.JITConfig,
					"experiment_command": spec.Command,
					"result_token":       spec.ResultToken,
					"shutdown_on_exit":   true,
				},
			},
		},
	}
	machine.Handlers.FcInit = machine.Handlers.FcInit.Append(fc.NewSetMetadataHandler(metadata))
	if err := machine.Start(ctx); err != nil {
		cancelVMM()
		return nil, fmt.Errorf("start Firecracker VM: %w", err)
	}

	leaseOwned = false
	return &machineLease{
		machine:      machine,
		client:       client,
		releaseLease: releaseLease,
		cancelVMM:    cancelVMM,
		console:      console,
		consolePath:  consolePath,
		workDir:      workDir,
		resultToken:  spec.ResultToken,
	}, nil
}

type machineLease struct {
	machine      *fc.Machine
	client       *containerd.Client
	releaseLease func(context.Context) error
	cancelVMM    context.CancelFunc
	console      *os.File
	consolePath  string
	workDir      string
	resultToken  string
	cleanupOnce  sync.Once
	cleanupError error
}

func (l *machineLease) Wait(ctx context.Context) (executor.Result, error) {
	err := l.machine.Wait(ctx)
	if ctx.Err() != nil {
		return executor.Result{}, ctx.Err()
	}
	exitCode := 0
	var resultError error
	if l.resultToken != "" {
		if syncError := l.console.Sync(); syncError != nil {
			resultError = fmt.Errorf("flush Experiment console: %w", syncError)
		} else {
			exitCode, resultError = parseExperimentResult(l.consolePath, l.resultToken)
		}
	}
	cleanupErr := l.cleanup(context.Background(), false)
	if err != nil || resultError != nil || cleanupErr != nil {
		return executor.Result{ExitCode: 1}, errors.Join(err, resultError, cleanupErr)
	}
	return executor.Result{ExitCode: exitCode}, nil
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
		}
		l.cancelVMM()
		if err := l.console.Close(); err != nil {
			cleanupErrors = append(cleanupErrors, fmt.Errorf("close console log: %w", err))
		}
		if err := l.releaseLease(ctx); err != nil && !errdefs.IsNotFound(err) {
			cleanupErrors = append(cleanupErrors, fmt.Errorf("release containerd lease: %w", err))
		}
		if err := l.client.Close(); err != nil {
			cleanupErrors = append(cleanupErrors, fmt.Errorf("close containerd client: %w", err))
		}
		if err := os.RemoveAll(l.workDir); err != nil {
			cleanupErrors = append(cleanupErrors, fmt.Errorf("remove Attempt directory: %w", err))
		}
		l.cleanupError = errors.Join(cleanupErrors...)
	})
	return l.cleanupError
}

func ensureImage(
	ctx context.Context,
	client *containerd.Client,
	snapshotter string,
	imageRelease string,
) (containerd.Image, error) {
	if err := validateImageRelease(imageRelease); err != nil {
		return nil, err
	}
	image, err := client.GetImage(ctx, imageRelease)
	if err == nil {
		return image, nil
	}
	if !errdefs.IsNotFound(err) {
		return nil, fmt.Errorf("inspect Image Release: %w", err)
	}
	image, err = client.Pull(
		ctx,
		imageRelease,
		containerd.WithPullUnpack,
		containerd.WithPullSnapshotter(snapshotter),
	)
	if err != nil {
		return nil, fmt.Errorf("pull Image Release: %w", err)
	}
	return image, nil
}

func validateImageRelease(imageRelease string) error {
	spec := executor.Spec{
		Kind:         "ci",
		AttemptID:    "validation",
		RunnerName:   "validation",
		Profile:      "validation",
		ImageRelease: imageRelease,
		VCPUs:        1,
		MemoryMiB:    512,
		JITConfig:    "validation",
	}
	if err := spec.Validate(); err != nil {
		return fmt.Errorf("invalid Image Release: %w", err)
	}
	return nil
}

func readableRegularFile(path string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return errors.New("not a regular file")
	}
	return nil
}

func executableRegularFile(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 {
		return errors.New("not an executable regular file")
	}
	return nil
}

var _ executor.Executor = (*Runtime)(nil)
