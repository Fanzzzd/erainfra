//go:build linux

package firecracker

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"time"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/executor"
	"github.com/Fanzzzd/erainfra/apps/runtime/internal/netpolicy"
	containerd "github.com/containerd/containerd/v2/client"
	"github.com/containerd/containerd/v2/core/leases"
	"github.com/containerd/containerd/v2/pkg/namespaces"
	fc "github.com/firecracker-microvm/firecracker-go-sdk"
	"github.com/firecracker-microvm/firecracker-go-sdk/client/models"
	"github.com/opencontainers/image-spec/identity"
	"github.com/sirupsen/logrus"
)

type vmDefinition struct {
	id          string
	attemptID   string
	leaseID     string
	profile     executor.Profile
	metadata    map[string]any
	resultToken string
	// egress is what the guest's per-guest sets are filled from before it
	// boots. Its owner in the guard is id.
	egress netpolicy.EffectiveEgress
}

func (r *Runtime) bootVM(ctx context.Context, definition vmDefinition) (_ *machineLease, returnedError error) {
	if err := os.MkdirAll(r.config.WorkDir, 0o700); err != nil {
		return nil, fmt.Errorf("create runtime directory: %w", err)
	}
	workDir, err := os.MkdirTemp(r.config.WorkDir, definition.id+"-")
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
	leaseContext, releaseLease, err := client.WithLease(containerdContext, leases.WithID(definition.leaseID))
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

	image, err := ensureImage(leaseContext, client, r.config.Snapshotter, definition.profile.ImageRelease)
	if err != nil {
		return nil, err
	}
	// Best-effort: without the stamp, Image Release pruning falls back to the
	// pull time when it picks the rollback release.
	if err := markImageUsed(leaseContext, client, definition.profile.ImageRelease, time.Now()); err != nil {
		slog.Warn("record the Image Release's last boot", "image", definition.profile.ImageRelease, "error", err)
	}
	rootFS, err := image.RootFS(leaseContext)
	if err != nil {
		return nil, fmt.Errorf("read image root filesystem: %w", err)
	}
	snapshotKey := "runner-center-" + definition.id
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
	// fc.WithLogger takes only a logrus entry, so logrus stays for this one silent adapter. The VMM
	// writes its own log to firecracker.log in the work directory.
	logger := logrus.New()
	logger.SetOutput(io.Discard)
	logger.SetLevel(logrus.PanicLevel)

	ensureSDKRequestTimeout()
	machine, err := fc.NewMachine(vmmContext, fc.Config{
		VMID:            definition.id,
		SocketPath:      filepath.Join(workDir, "firecracker.sock"),
		KernelImagePath: r.config.KernelImagePath,
		KernelArgs:      r.config.KernelArgs,
		MachineCfg: models.MachineConfiguration{
			VcpuCount:  fc.Int64(definition.profile.VCPUs),
			MemSizeMib: fc.Int64(definition.profile.MemoryMiB),
		},
		Drives: []models.Drive{{
			DriveID:      fc.String("rootfs"),
			PathOnHost:   fc.String(mounts[0].Source),
			IsRootDevice: fc.Bool(true),
			IsReadOnly:   fc.Bool(false),
			IoEngine:     fc.String(r.rootfsIoEngine),
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
	// The guest's address exists once CNI has run, which is the first FcInit
	// handler, and the guest runs nothing until InstanceStart, which follows
	// every FcInit handler. Registering here therefore puts the guest into its
	// Profile's sets before its first packet, and a guest whose sets cannot be
	// written never starts. The SDK may already have released a previous VM's
	// CNI reservation before its lease cleanup runs. Register fences that address
	// through old kernel cleanup and retries, even for a public replacement.
	//
	// The guest's link is closed to IPv6 here too, in the kernel and in the
	// table, for the same reason: before the guest can put a frame on it. A
	// guest whose link cannot be closed never starts.
	var guestAddress netip.Addr
	machine.Handlers.FcInit = machine.Handlers.FcInit.Append(fc.Handler{
		Name: "erainfra.RegisterGuestEgress",
		Fn: func(handlerContext context.Context, machine *fc.Machine) error {
			address, err := guestAddressOf(machine)
			if err != nil {
				return err
			}
			link, err := hostLinkOf(address)
			if err != nil {
				return err
			}
			if err := disableLinkIPv6(procSysNet, link); err != nil {
				return err
			}
			if err := r.egress.Register(handlerContext, address, link, definition.id, definition.egress); err != nil {
				return err
			}
			guestAddress = address
			return nil
		},
	})
	defer func() {
		if returnedError != nil && guestAddress.IsValid() {
			_, _ = r.egress.Unregister(context.WithoutCancel(ctx), guestAddress, definition.id)
		}
	}()
	if definition.metadata != nil {
		machine.Handlers.FcInit = machine.Handlers.FcInit.Append(fc.NewSetMetadataHandler(definition.metadata))
	}
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
		resultToken:  definition.resultToken,
		egress:       r.egress,
		guestAddress: guestAddress,
		egressOwner:  definition.id,
	}
	if definition.attemptID != "" {
		lease.onCleanup = func() { r.forgetLease(definition.attemptID, lease) }
		r.rememberLease(definition.attemptID, lease)
	}
	leaseOwned = false
	return lease, nil
}

// guestAddressOf reads the address CNI gave the guest. The SDK fills the
// static configuration from the CNI result during its network setup handler.
func guestAddressOf(machine *fc.Machine) (netip.Addr, error) {
	for _, networkInterface := range machine.Cfg.NetworkInterfaces {
		if networkInterface.CNIConfiguration == nil {
			continue
		}
		configuration := networkInterface.StaticConfiguration
		if configuration == nil || configuration.IPConfiguration == nil {
			return netip.Addr{}, errors.New("CNI set up the guest network but reported no guest address")
		}
		address, ok := netip.AddrFromSlice(configuration.IPConfiguration.IPAddr.IP.To4())
		if !ok {
			return netip.Addr{}, fmt.Errorf("guest address %s is not IPv4", configuration.IPConfiguration.IPAddr.IP)
		}
		return address, nil
	}
	return netip.Addr{}, errors.New("the guest has no CNI network interface")
}

func metadataFor(spec executor.Spec) map[string]any {
	return map[string]any{
		"latest": map[string]any{
			"meta-data": map[string]any{
				"runner-center": map[string]any{
					"kind":                spec.Kind,
					"runner_name":         spec.RunnerName,
					"runner_jit_config":   spec.JITConfig,
					"experiment_command":  spec.Command,
					"result_token":        spec.ResultToken,
					"cache_url":           spec.CacheURL,
					"cache_service_v2":    spec.CacheServiceV2,
					"cache_service_url":   spec.CacheServiceURL,
					"cache_runner_token":  spec.CacheRunnerToken,
					"registry_mirror_url": spec.RegistryMirrorURL,
					"apt_mirror_url":      spec.AptMirrorURL,
					"git_mirror":          spec.GitMirror,
					"shutdown_on_exit":    true,
				},
			},
		},
	}
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
		// Wait for Start to return so no goroutine outlives the call.
		<-started //nolint:errcheck // Start's error is the cancel just issued; the deadline is the cause

		return fmt.Errorf("start Firecracker VM: %w", ctx.Err())
	}
}
