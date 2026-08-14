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

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/executor"
	"github.com/Fanzzzd/erainfra/apps/runtime/internal/netpolicy"
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

	recoveryMu sync.Mutex
	activeMu   sync.Mutex
	active     map[string]*machineLease
}

// Recover removes leases and private work directories left by a runtime process
// that was killed before its normal per-Attempt cleanup completed. Serve calls
// it while holding the single-daemon lock, before accepting new work.
func (r *Runtime) Recover(ctx context.Context) error {
	return r.recover(ctx, newRecoveryPolicy(nil))
}

// RecoverOrphans reconciles privileged Firecracker state with the control
// plane's authoritative live set. Unlike service-start recovery, the runtime
// is still serving here, so it first stops each in-process orphaned VM and then
// removes only that orphan's lease, network state, and work directory.
func (r *Runtime) RecoverOrphans(ctx context.Context, liveAttemptIDs []string) error {
	return r.recover(ctx, newRecoveryPolicy(liveAttemptIDs))
}

func (r *Runtime) recover(ctx context.Context, policy recoveryPolicy) error {
	r.recoveryMu.Lock()
	defer r.recoveryMu.Unlock()

	var cleanupErrors []error
	type cancellationResult struct {
		attemptID string
		err       error
	}
	active := r.activeLeases()
	results := make(chan cancellationResult, len(active))
	var cancellations sync.WaitGroup
	for attemptID, lease := range active {
		if !policy.recoverAttempt(attemptID) {
			continue
		}
		cancellations.Add(1)
		go func() {
			defer cancellations.Done()
			results <- cancellationResult{attemptID: attemptID, err: lease.Cancel(ctx)}
		}()
	}
	cancellations.Wait()
	close(results)
	for result := range results {
		if result.err != nil {
			cleanupErrors = append(cleanupErrors, fmt.Errorf(
				"stop orphaned Attempt %s: %w", result.attemptID, result.err,
			))
		}
	}

	client, err := containerd.New(r.config.ContainerdAddress)
	if err != nil {
		cleanupErrors = append(cleanupErrors, fmt.Errorf("connect to containerd: %w", err))
		return errors.Join(cleanupErrors...)
	}
	defer client.Close()
	ctx = namespaces.WithNamespace(ctx, r.config.ContainerdNamespace)
	all, err := client.LeasesService().List(ctx)
	if err != nil {
		cleanupErrors = append(cleanupErrors, fmt.Errorf("list containerd leases: %w", err))
		return errors.Join(cleanupErrors...)
	}
	for _, lease := range all {
		if !policy.recoverLease(lease.ID) {
			continue
		}
		if err := client.LeasesService().Delete(ctx, lease, leases.SynchronousDelete); err != nil && !errdefs.IsNotFound(err) {
			cleanupErrors = append(cleanupErrors, fmt.Errorf("delete lease %s: %w", lease.ID, err))
		}
	}
	if err := r.reclaimNetwork(ctx, policy); err != nil {
		cleanupErrors = append(cleanupErrors, err)
	}
	entries, err := os.ReadDir(r.config.WorkDir)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		cleanupErrors = append(cleanupErrors, fmt.Errorf("list runtime directories: %w", err))
	}
	for _, entry := range entries {
		if !policy.recoverWorkDir(entry.Name()) {
			continue
		}
		if err := os.RemoveAll(filepath.Join(r.config.WorkDir, entry.Name())); err != nil {
			cleanupErrors = append(cleanupErrors, fmt.Errorf(
				"remove abandoned runtime directory %s: %w", entry.Name(), err,
			))
		}
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
	return &Runtime{config: config, active: make(map[string]*machineLease)}, nil
}

func (r *Runtime) activeLeases() map[string]*machineLease {
	r.activeMu.Lock()
	defer r.activeMu.Unlock()
	active := make(map[string]*machineLease, len(r.active))
	for attemptID, lease := range r.active {
		active[attemptID] = lease
	}
	return active
}

func (r *Runtime) rememberLease(attemptID string, lease *machineLease) {
	r.activeMu.Lock()
	defer r.activeMu.Unlock()
	r.active[attemptID] = lease
}

func (r *Runtime) forgetLease(attemptID string, lease *machineLease) {
	r.activeMu.Lock()
	defer r.activeMu.Unlock()
	if r.active[attemptID] == lease {
		delete(r.active, attemptID)
	}
}

// Preflight proves every prerequisite the isolation boundary depends on, and
// reports each one separately.
//
// It deliberately does not stop at the first failure: an operator provisioning
// a host wants the whole list, and the control plane needs to name the exact
// broken check in the dashboard. The network policy is checked by content
// rather than by existence — a conflist file that is present but no longer
// denies host, RFC1918 and east-west traffic is the failure mode that matters.
func (r *Runtime) Preflight(ctx context.Context) (executor.Report, error) {
	report := executor.Report{
		Isolation: executor.IsolationFirecracker,
		Boundary:  executor.BoundaryGuestKernel,
		Network: executor.Network{
			PolicyName:          r.config.Network.Name,
			Subnet:              r.config.Network.Subnet,
			EgressMode:          string(r.config.Network.EgressMode),
			AllowedDestinations: r.config.Network.AllowedDestinations,
		},
		// Nothing writable outlives an Attempt: the root is a per-Attempt
		// copy-on-write snapshot and no host path is mounted into the guest.
		Cache: executor.Cache{
			Scope:          "immutable-image",
			SharedWritable: false,
			Detail: "Warm state comes from the digest-pinned Image Release. " +
				"No host directory, volume or device is shared between Attempts.",
		},
	}

	if path, err := exec.LookPath(r.config.BinaryPath); err != nil {
		report.Fail(executor.CheckBinary, fmt.Errorf("find Firecracker binary: %w", err))
	} else {
		report.Pass(executor.CheckBinary, path)
	}
	if err := readableRegularFile(r.config.KernelImagePath); err != nil {
		report.Fail(executor.CheckKernelImage, fmt.Errorf("kernel image: %w", err))
	} else {
		report.Pass(executor.CheckKernelImage, r.config.KernelImagePath)
	}
	if err := netpolicy.VerifyKernelArgs(r.config.KernelArgs); err != nil {
		report.Fail(executor.CheckKernelArgs, err)
	} else {
		report.Pass(executor.CheckKernelArgs, r.config.KernelArgs)
	}

	kvmUsable := false
	if kvm, err := os.OpenFile("/dev/kvm", os.O_RDWR, 0); err != nil {
		report.Fail(executor.CheckKVM, fmt.Errorf("open /dev/kvm read-write: %w", err))
	} else {
		_ = kvm.Close()
		kvmUsable = true
		report.Pass(executor.CheckKVM, "/dev/kvm is readable and writable")
	}
	report.Hardware = hostHardware(kvmUsable)

	var missingPlugins []string
	for _, plugin := range netpolicy.RequiredPlugins() {
		if err := executableRegularFile(filepath.Join(r.config.CNIBinDir, plugin)); err != nil {
			missingPlugins = append(missingPlugins, plugin)
		}
	}
	if len(missingPlugins) > 0 {
		report.Fail(executor.CheckCNIPlugins, fmt.Errorf(
			"CNI plugins missing from %s: %s",
			r.config.CNIBinDir,
			strings.Join(missingPlugins, ", "),
		))
	} else {
		report.Pass(executor.CheckCNIPlugins, r.config.CNIBinDir)
	}

	conflist, err := os.ReadFile(r.config.ConflistPath())
	switch {
	case err != nil:
		report.Fail(executor.CheckCNIConfig, fmt.Errorf("read CNI configuration: %w", err))
	default:
		if verifyErr := r.config.Network.VerifyConflist(conflist); verifyErr != nil {
			report.Fail(executor.CheckCNIConfig, verifyErr)
		} else {
			report.Pass(executor.CheckCNIConfig, r.config.ConflistPath())
		}
	}

	live, err := netpolicy.ReadLiveTable(ctx, r.config.NftBinary)
	switch {
	case err != nil:
		report.Fail(executor.CheckNetPolicy, err)
	default:
		if verifyErr := r.config.Network.VerifyNftables(live); verifyErr != nil {
			report.Fail(executor.CheckNetPolicy, verifyErr)
		} else {
			report.Pass(executor.CheckNetPolicy, fmt.Sprintf(
				"host, RFC1918 and east-west traffic denied for %s with %s egress",
				r.config.Network.Subnet,
				r.config.Network.EgressMode,
			))
		}
	}

	r.checkSnapshotter(ctx, &report)
	r.checkAddressReservations(ctx, &report)

	storage, err := thinPoolStorage(ctx, r.config.Snapshotter, r.config.ThinPoolName)
	report.Storage = storage
	switch {
	case err != nil:
		report.Fail(executor.CheckStorage, err)
	case storage.PoolFreeMiB < r.config.MinPoolFreeMiB:
		report.Fail(executor.CheckStorage, fmt.Errorf(
			"thin-pool %q has %d MiB free but this Worker requires %d MiB before accepting an Attempt",
			r.config.ThinPoolName, storage.PoolFreeMiB, r.config.MinPoolFreeMiB,
		))
	default:
		report.Pass(executor.CheckStorage, fmt.Sprintf(
			"%d MiB free of %d MiB in thin-pool %q",
			storage.PoolFreeMiB, storage.PoolTotalMiB, r.config.ThinPoolName,
		))
	}

	if report.Cache.SharedWritable {
		report.Fail(executor.CheckCache, errors.New(
			"this Profile shares writable storage between Attempts, which is a cross-job path",
		))
	} else {
		report.Pass(executor.CheckCache, report.Cache.Detail)
	}

	if !report.Ready() {
		return report, errors.New(report.FailureSummary())
	}
	return report, nil
}

func (r *Runtime) checkSnapshotter(ctx context.Context, report *executor.Report) {
	client, err := containerd.New(r.config.ContainerdAddress, containerd.WithTimeout(5*time.Second))
	if err != nil {
		report.Fail(executor.CheckSnapshotter, fmt.Errorf("connect to containerd: %w", err))
		return
	}
	defer client.Close()
	response, err := client.IntrospectionService().Plugins(ctx, snapshotterFilter(r.config.Snapshotter))
	if err != nil {
		report.Fail(executor.CheckSnapshotter, fmt.Errorf("query containerd snapshotter: %w", err))
		return
	}
	if len(response.Plugins) != 1 {
		report.Fail(executor.CheckSnapshotter, fmt.Errorf(
			"containerd reported %d plugins for snapshotter %q, want exactly one",
			len(response.Plugins), r.config.Snapshotter,
		))
		return
	}
	if initErr := response.Plugins[0].InitErr; initErr != nil {
		report.Fail(executor.CheckSnapshotter, fmt.Errorf(
			"containerd snapshotter %q failed to initialise: %s",
			r.config.Snapshotter, initErr.GetMessage(),
		))
		return
	}
	report.Pass(executor.CheckSnapshotter, r.config.Snapshotter+" at "+r.config.ContainerdAddress)
}

// checkAddressReservations fails readiness when host-local holds more guest
// addresses than there are live Attempt leases.
//
// A reservation is created only while its Attempt's lease is held and is
// normally released before the lease, so reservations can never legitimately
// outnumber leases. When they do, teardown has started leaking network state
// (#24); failing closed stops the Worker from accepting work while the drift
// grows. Runtime-service startup reclaims everything under the single-daemon
// lock, while Agent reconciliation selectively reclaims server-orphaned state.
func (r *Runtime) checkAddressReservations(ctx context.Context, report *executor.Report) {
	reservations, err := readReservations(
		reservationDir(netpolicy.CNIDataDir, r.config.Network.Name),
	)
	if err != nil {
		report.Fail(executor.CheckCNIReservations, fmt.Errorf("list guest address reservations: %w", err))
		return
	}
	if len(reservations) == 0 {
		report.Pass(executor.CheckCNIReservations, "no guest addresses reserved")
		return
	}
	client, err := containerd.New(r.config.ContainerdAddress, containerd.WithTimeout(5*time.Second))
	if err != nil {
		report.Fail(executor.CheckCNIReservations, fmt.Errorf("connect to containerd: %w", err))
		return
	}
	defer client.Close()
	all, err := client.LeasesService().List(namespaces.WithNamespace(ctx, r.config.ContainerdNamespace))
	if err != nil {
		report.Fail(executor.CheckCNIReservations, fmt.Errorf("list containerd leases: %w", err))
		return
	}
	activeAttempts := 0
	for _, lease := range all {
		if strings.HasPrefix(lease.ID, "runner-center/attempts/") {
			activeAttempts++
		}
	}
	if len(reservations) > activeAttempts {
		report.Fail(executor.CheckCNIReservations, fmt.Errorf(
			"%d guest addresses reserved for %d running Attempts; teardown is leaking network state — restart the Worker or runner-center-runtime to reclaim it",
			len(reservations), activeAttempts,
		))
		return
	}
	report.Pass(executor.CheckCNIReservations, fmt.Sprintf(
		"%d guest addresses reserved for %d running Attempts",
		len(reservations), activeAttempts,
	))
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
	if _, err := r.Preflight(ctx); err != nil {
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
			// containerdContext, not a fresh Background: deleting a lease is a
			// namespaced call and fails outright without one.
			cleanupContext, cancel := context.WithTimeout(containerdContext, 10*time.Second)
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
				NetworkName: r.config.Network.Name,
				IfName:      guestInterfaceName,
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
	if err := startMachine(ctx, machine, vmmContext, cancelVMM); err != nil {
		return nil, err
	}

	lease := &machineLease{
		machine:      machine,
		client:       client,
		namespace:    r.config.ContainerdNamespace,
		releaseLease: releaseLease,
		cancelVMM:    cancelVMM,
		console:      console,
		consolePath:  consolePath,
		workDir:      workDir,
		resultToken:  spec.ResultToken,
	}
	lease.onCleanup = func() { r.forgetLease(spec.AttemptID, lease) }
	r.rememberLease(spec.AttemptID, lease)
	leaseOwned = false
	return lease, nil
}

// startMachine boots the guest, bounded by the caller's boot deadline but tied
// for its lifetime to the VM's own context.
//
// The distinction is the whole point. firecracker-go-sdk starts a goroutine
// that SIGTERMs the VMM as soon as the context passed to Machine.Start is done,
// so handing it the caller's boot context destroys every guest the instant boot
// succeeds and the caller stops enforcing the boot deadline. The boot deadline
// therefore has to bound the call rather than the guest: on a boot that never
// completes, cancelling the VM's own context is what tears the VMM down.
func startMachine(
	ctx context.Context,
	machine *fc.Machine,
	vmmContext context.Context,
	cancelVMM context.CancelFunc,
) error {
	started := make(chan error, 1)
	go func() { started <- machine.Start(vmmContext) }()
	select {
	case err := <-started:
		if err != nil {
			cancelVMM()
			return fmt.Errorf("start Firecracker VM: %w", err)
		}
		return nil
	case <-ctx.Done():
		cancelVMM()
		<-started
		return fmt.Errorf("start Firecracker VM: %w", ctx.Err())
	}
}

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
			// The SDK returns the guest's network resources -- the veth pair, the
			// tap device and the host-local address reservation -- from the
			// goroutine that reaps the VMM, on the VM's own context. Cancelling
			// that context before the process is gone aborts the release and leaks
			// an address out of the guest subnet, so wait for the exit first. The
			// error here is the VMM's own exit status, which is a signal after
			// StopVMM and therefore expected; only failing to exit matters.
			exitContext, cancelExit := context.WithTimeout(context.WithoutCancel(ctx), vmmExitTimeout)
			if err := l.machine.Wait(exitContext); errors.Is(err, context.DeadlineExceeded) {
				cleanupErrors = append(cleanupErrors, fmt.Errorf(
					"Firecracker VM did not exit within %s of being stopped", vmmExitTimeout,
				))
			}
			cancelExit()
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
