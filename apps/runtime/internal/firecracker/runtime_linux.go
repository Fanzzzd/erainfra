//go:build linux

package firecracker

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/admission"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/egress"
	"github.com/Fanzzzd/erainfra/apps/runtime/internal/executor"
	"github.com/Fanzzzd/erainfra/apps/runtime/internal/netpolicy"
	"github.com/Fanzzzd/erainfra/internal/cachetoken"
	containerd "github.com/containerd/containerd/v2/client"
	"github.com/containerd/containerd/v2/core/leases"
	"github.com/containerd/containerd/v2/pkg/namespaces"
	"github.com/containerd/errdefs"
)

type Runtime struct {
	config Config
	pool   *warmPoolManager
	// cacheIssuer mints the runner-auth cache bearer, or is nil when no signing
	// key is configured — a fleet without a cache. It is built once and safe for
	// concurrent use.
	cacheIssuer *cachetoken.Issuer
	// rootfsIoEngine is the block engine every guest's root drive is attached
	// with, decided once from the host kernel: Async (io_uring) where the kernel
	// allows it, Sync otherwise. rootfsIoEngineDetail is the one-line reason,
	// reported by Preflight so an operator can see which engine a Worker runs
	// and what kernel would change it.
	rootfsIoEngine       string
	rootfsIoEngineDetail string
	// egress owns every guest's per-guest egress state and the host resolver
	// audit and allowlist guests are redirected to.
	egress *egress.Guard
	// admission spaces Attempt starts out within config.StartBudget.
	admission *admission.Gate

	recoveryMu sync.Mutex
	activeMu   sync.Mutex
	active     map[string]*machineLease
	// roots names every live guest's root snapshot, for the pool reserve those
	// guests already wrote (storage.poolReserveUsedMiB).
	roots liveRoots
}

// cacheBearerTTL is how long a minted runner-auth bearer stays valid. It must
// outlive the job so the cache keeps working for its whole run; it matches the
// controller's fact lifetime, and a longer-running job simply reads a cold cache
// past this point.
const cacheBearerTTL = 6 * time.Hour

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
	return errors.Join(
		r.pool.RecoverOrphans(ctx, liveAttemptIDs),
		r.recover(ctx, newRecoveryPolicy(liveAttemptIDs)),
	)
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
	defer client.Close() //nolint:errcheck // closes the gRPC connection; nothing is buffered
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
	runtime := &Runtime{config: config, active: make(map[string]*machineLease)}
	runtime.rootfsIoEngine, runtime.rootfsIoEngineDetail = rootfsIoEngine(hostKernelRelease())
	if len(config.CacheSigningKey) > 0 {
		issuer, err := cachetoken.NewIssuer(config.CacheSigningKey, cacheBearerTTL)
		if err != nil {
			return nil, fmt.Errorf("configure cache bearer issuer: %w", err)
		}
		runtime.cacheIssuer = issuer
	}
	runtime.egress = egress.NewGuard(config.Network, egress.NftApplier{Binary: config.NftBinary})
	gate, err := admission.New(config.StartBudget, admission.FilePressure(admission.IOPressureFile), admission.Options{})
	if err != nil {
		return nil, err
	}
	runtime.admission = gate
	runtime.pool = newWarmPoolManager(runtime.newWarmSlot)
	return runtime, nil
}

// ServeEgress starts the host resolver on the guest gateway address. A
// failure is returned, not fatal: public Profiles do not need the resolver,
// and every audit or allowlist Profile fails its egress-policy check until it
// is serving, so the Worker is not ready for them.
func (r *Runtime) ServeEgress(ctx context.Context) error {
	address, err := egress.ListenAddress(r.config.Network)
	if err != nil {
		return err
	}
	packet, stream, err := egress.Listen(ctx, address)
	if err != nil {
		return err
	}
	r.egress.Resolver().Serve(packet, stream)
	return nil
}

// guestElementsInterval is how often the runtime checks that every running
// guest is still in the per-guest sets. Readiness checks too, but only when the
// Worker asks for it; this bounds how long a guest runs unbound after someone
// reloads the table by hand.
const guestElementsInterval = 10 * time.Second

// KeepGuestElements restores, until ctx ends, the per-guest elements of every
// running guest that a reload or edit of the table removed.
func (r *Runtime) KeepGuestElements(ctx context.Context) {
	ticker := time.NewTicker(guestElementsInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		restored, _, _, err := restoreGuestElements(ctx, r.config.Network, r.readLiveTable(ctx), r.egress)
		logRestoredGuests(restored)
		if err != nil && ctx.Err() == nil {
			slog.Warn("could not check the per-guest elements of running guests", "error", err)
		}
	}
}

func (r *Runtime) readLiveTable(ctx context.Context) func() ([]byte, error) {
	return func() ([]byte, error) { return netpolicy.ReadLiveTable(ctx, r.config.NftBinary) }
}

func logRestoredGuests(restored []netpolicy.GuestEgressState) {
	for _, state := range restored {
		slog.Warn(
			"restored a running guest's link binding and egress membership, which the nftables table had lost; "+
				"reload the table only with no Firecracker VMs running",
			"guest", state.Guest, "link", state.Link,
		)
	}
}

func (r *Runtime) effectiveEgress(profile netpolicy.ProfileEgress) (netpolicy.EffectiveEgress, error) {
	return netpolicy.Effective(r.config.Network, profile, r.config.CacheServiceURL, r.config.RegistryMirrorURL, r.config.AptMirrorURL)
}

// mintCacheBearer mints the runner-auth bearer for a claim, or returns empty when
// no cache is configured or the runner name will not scope a token. It never
// fails the claim: a cache the host cannot mint for is a cold cache, which is the
// safe direction, so a mint error is logged and the Attempt proceeds.
func (r *Runtime) mintCacheBearer(runnerName string) string {
	if r.cacheIssuer == nil {
		return ""
	}
	token, _, err := r.cacheIssuer.IssueRunner(runnerName)
	if err != nil {
		slog.Warn("could not mint cache bearer", "error", err, "runner", runnerName)
		return ""
	}
	return token
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

func (r *Runtime) PrepareProfile(
	ctx context.Context,
	profile executor.Profile,
) (executor.WarmPoolStatus, error) {
	if err := profile.Validate(); err != nil {
		return executor.WarmPoolStatus{}, err
	}
	if _, err := r.Preflight(ctx, profile.Egress); err != nil {
		return executor.WarmPoolStatus{}, err
	}
	client, err := containerd.New(r.config.ContainerdAddress)
	if err != nil {
		return executor.WarmPoolStatus{}, fmt.Errorf("connect to containerd: %w", err)
	}
	defer client.Close() //nolint:errcheck // closes the gRPC connection; nothing is buffered
	containerdContext := namespaces.WithNamespace(ctx, r.config.ContainerdNamespace)
	image, err := ensureImage(containerdContext, client, r.config.Snapshotter, profile.ImageRelease)
	if err != nil {
		return executor.WarmPoolStatus{}, err
	}
	// Best effort: an image whose config cannot be read reports no runner
	// version, which the control plane treats as unknown and never as a
	// readiness failure.
	runnerVersion := ""
	if spec, specErr := image.Spec(containerdContext); specErr != nil {
		slog.Warn("could not read the image config for its actions/runner version",
			"error", specErr, "image", profile.ImageRelease)
	} else {
		runnerVersion = imageRunnerVersion(spec)
	}
	if profile.WarmPool > 0 {
		storage, err := thinPoolStorage(ctx, r.config.Snapshotter, r.config.ThinPoolName)
		if err != nil {
			return executor.WarmPoolStatus{}, err
		}
		required := int64(r.pool.totalTargetWith(profile)) * r.config.MinPoolFreeMiB
		if storage.PoolFreeMiB < required {
			return executor.WarmPoolStatus{}, fmt.Errorf(
				"warm pools require %d MiB thin-pool headroom but %d MiB is free",
				required, storage.PoolFreeMiB,
			)
		}
	}
	status, err := r.pool.Configure(ctx, profile)
	status.RunnerVersion = runnerVersion
	return status, err
}

func (r *Runtime) RemoveProfile(ctx context.Context, profile string) error {
	return r.pool.Remove(ctx, strings.TrimSpace(profile))
}

// AdmissionState reports the start budget and how much of it is in use.
func (r *Runtime) AdmissionState() admission.State { return r.admission.State() }

func (r *Runtime) Shutdown(ctx context.Context) error { return r.pool.Shutdown(ctx) }

func (r *Runtime) Start(ctx context.Context, spec executor.Spec) (_ executor.Lease, returnedError error) {
	if err := spec.Validate(); err != nil {
		return nil, fmt.Errorf("invalid Attempt: %w", err)
	}
	if _, err := r.Preflight(ctx, spec.Egress); err != nil {
		return nil, err
	}
	// Warm claims wait too: a warm guest skips the boot, not the job's own
	// checkout and install, which load the shared disk the same way.
	decision, err := r.admission.Admit(ctx)
	if err != nil {
		return nil, fmt.Errorf("wait for the start budget: %w", err)
	}
	if decision.Reason != "" {
		slog.Info("held Attempt for the start budget",
			"attempt", spec.AttemptID, "held", decision.Held.Round(time.Second).String(),
			"reason", decision.Reason, "forced", decision.Forced)
	}
	// Mint the runner-auth bearer here, at claim, where the runner name is known.
	// Both the warm-claim and cold-boot paths below read it back out of the spec
	// in metadataFor, so it rides the one MMDS write each path already makes.
	spec.CacheRunnerToken = r.mintCacheBearer(spec.RunnerName)
	// The cache service endpoint is fleet-wide operator configuration, not a
	// per-job decision, so it lives on the daemon next to the signing key rather
	// than arriving in each spec. A spec that already names one still wins.
	if spec.CacheServiceURL == "" {
		spec.CacheServiceURL = r.config.CacheServiceURL
	}
	// The same holds for the registry mirror.
	if spec.RegistryMirrorURL == "" {
		spec.RegistryMirrorURL = r.config.RegistryMirrorURL
	}
	if spec.AptMirrorURL == "" {
		spec.AptMirrorURL = r.config.AptMirrorURL
	}
	// And for the git checkout mirror, which needs the cache service the spec
	// ended up with.
	spec.GitMirror = spec.GitMirror || r.config.GitMirror
	if spec.CacheServiceURL == "" {
		spec.GitMirror = false
	}
	lease, err := r.pool.Claim(ctx, spec)
	if err == nil {
		return lease, nil
	}
	// Only a miss, demand above the warm target, cold-boots. Any other claim
	// error is a broken pool, and the Attempt fails rather than hiding it.
	if !errors.Is(err, errWarmPoolMiss) {
		return nil, err
	}
	// The cache endpoint the guest is handed is the one it must be able to
	// reach, so the allowlist is computed from the spec's, not the daemon's.
	effective, err := netpolicy.Effective(r.config.Network, spec.Egress, spec.CacheServiceURL, spec.RegistryMirrorURL, spec.AptMirrorURL)
	if err != nil {
		return nil, fmt.Errorf("egress: %w", err)
	}
	return r.bootVM(ctx, vmDefinition{
		id:          spec.AttemptID,
		attemptID:   spec.AttemptID,
		leaseID:     "runner-center/attempts/" + spec.AttemptID,
		profile:     executor.Profile{Name: spec.Profile, ImageRelease: spec.ImageRelease, VCPUs: spec.VCPUs, MemoryMiB: spec.MemoryMiB, Egress: spec.Egress},
		metadata:    metadataFor(spec),
		resultToken: spec.ResultToken,
		egress:      effective,
	})
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

var (
	_ executor.Executor   = (*Runtime)(nil)
	_ executor.Measurable = (*machineLease)(nil)
)
