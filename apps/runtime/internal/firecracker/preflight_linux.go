//go:build linux

package firecracker

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/executor"
	"github.com/Fanzzzd/erainfra/apps/runtime/internal/netpolicy"
	containerd "github.com/containerd/containerd/v2/client"
	"github.com/containerd/containerd/v2/pkg/namespaces"
	"github.com/coreos/go-iptables/iptables"
)

// Preflight proves every prerequisite the isolation boundary depends on, and
// reports each one separately.
//
// It deliberately does not stop at the first failure: an operator provisioning
// a host wants the whole list, and the control plane needs to name the exact
// broken check in the dashboard. The network policy is checked by content
// rather than by existence — a conflist file that is present but no longer
// denies host, RFC1918 and east-west traffic is the failure mode that matters.
//
// The report is for one Profile's egress: its network policy hash and egress
// mode describe what that Profile's guests get on this host, and the
// egress-policy check proves this Worker can enforce it.
func (r *Runtime) Preflight(ctx context.Context, profileEgress netpolicy.ProfileEgress) (executor.Report, error) {
	network, egressCheck := egressReadiness(
		r.config.Network, profileEgress,
		[]string{r.config.CacheServiceURL, r.config.RegistryMirrorURL}, r.egress.Health,
	)
	report := executor.Report{
		Isolation: executor.IsolationFirecracker,
		Boundary:  executor.BoundaryGuestKernel,
		Network:   network,
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

	detail, restored, err := verifyAndRestoreNetwork(ctx, r.config.Network, r.readLiveTable(ctx), r.egress, procSysNet)
	logRestoredGuests(restored)
	if err != nil {
		report.Fail(executor.CheckNetPolicy, err)
	} else {
		report.Pass(executor.CheckNetPolicy, detail)
	}
	if egressCheck.Passed {
		report.Pass(egressCheck.Name, egressCheck.Detail)
	} else {
		report.Fail(egressCheck.Name, errors.New(egressCheck.Detail))
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

	// Never a failure: Sync is a slower engine, not a broken one. The check
	// exists so the choice is visible on the readiness report instead of being
	// inferred from job timings.
	report.Pass(executor.CheckRootfsIoEngine, r.rootfsIoEngineDetail)

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
	defer client.Close() //nolint:errcheck // closes the gRPC connection; nothing is buffered
	response, err := client.IntrospectionService().Plugins(ctx, snapshotterFilter(r.config.Snapshotter)...)
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
// addresses than there are live Attempt leases, or when iptables still carries
// rules for a guest that has no lease.
//
// A reservation is created only while its Attempt's lease is held and is
// normally released before the lease, so reservations can never legitimately
// outnumber leases. When they do, teardown has started leaking network state
// (#24); failing closed stops the Worker from accepting work while the drift
// grows. Runtime-service startup reclaims everything under the single-daemon
// lock, while Agent reconciliation selectively reclaims server-orphaned state.
//
// The rules are compared against leases too, never against reservations: a
// normal teardown releases the reservation a moment before the masquerade
// rule and the lease after both, so only the lease is a race-free witness
// that a guest is still being torn down rather than forgotten (#143).
func (r *Runtime) checkAddressReservations(ctx context.Context, report *executor.Report) {
	reservations, err := readReservations(
		reservationDir(netpolicy.CNIDataDir, r.config.Network.Name),
	)
	if err != nil {
		report.Fail(executor.CheckCNIReservations, fmt.Errorf("list guest address reservations: %w", err))
		return
	}
	table, err := iptables.New()
	if err != nil {
		report.Fail(executor.CheckCNIReservations, fmt.Errorf("open iptables: %w", err))
		return
	}
	nat, forward, err := listGuestRules(table, r.config.Network.Name)
	if err != nil {
		report.Fail(executor.CheckCNIReservations, fmt.Errorf("list guest network rules: %w", err))
		return
	}
	if len(reservations) == 0 && len(nat) == 0 && len(forward) == 0 {
		report.Pass(executor.CheckCNIReservations, "no guest addresses reserved")
		return
	}
	client, err := containerd.New(r.config.ContainerdAddress, containerd.WithTimeout(5*time.Second))
	if err != nil {
		report.Fail(executor.CheckCNIReservations, fmt.Errorf("connect to containerd: %w", err))
		return
	}
	defer client.Close() //nolint:errcheck // closes the gRPC connection; nothing is buffered
	all, err := client.LeasesService().List(namespaces.WithNamespace(ctx, r.config.ContainerdNamespace))
	if err != nil {
		report.Fail(executor.CheckCNIReservations, fmt.Errorf("list containerd leases: %w", err))
		return
	}
	leased := make(map[string]struct{})
	for _, lease := range all {
		if id, ok := strings.CutPrefix(lease.ID, attemptLeasePrefix); ok {
			leased[id] = struct{}{}
		} else if id, ok := strings.CutPrefix(lease.ID, warmLeasePrefix); ok {
			leased[id] = struct{}{}
		}
	}
	activeGuests := len(leased)
	if len(reservations) > activeGuests {
		report.Fail(executor.CheckCNIReservations, fmt.Errorf(
			"%d guest addresses reserved for %d running microVMs; teardown is leaking network state — restart the Worker or runner-center-runtime to reclaim it",
			len(reservations), activeGuests,
		))
		return
	}
	leasedIPs := make(map[string]struct{})
	for _, reservation := range reservations {
		if _, ok := leased[reservation.ContainerID]; ok {
			leasedIPs[reservation.IP] = struct{}{}
		}
	}
	strayNAT, strayForward := strayGuestRules(nat, forward, leasedIPs, func(containerID string) bool {
		_, ok := leased[containerID]
		return ok
	})
	if stray := len(strayNAT) + len(strayForward); stray > 0 {
		report.Fail(executor.CheckCNIReservations, fmt.Errorf(
			"%d iptables rules belong to microVMs that no longer exist (%d masquerade, %d forward); every guest packet walks them — restart runner-center-runtime to reclaim them",
			stray, len(strayNAT), len(strayForward),
		))
		return
	}
	report.Pass(executor.CheckCNIReservations, fmt.Sprintf(
		"%d guest addresses reserved for %d running microVMs, no stray rules",
		len(reservations), activeGuests,
	))
}

func readableRegularFile(path string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close() //nolint:errcheck // read-only file; a close error loses nothing
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
