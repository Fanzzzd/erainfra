# ADR 0003: Use single-use parked microVMs for warm capacity

- Status: Accepted
- Date: 2026-08-14
- Owners: EraInfra

## Context

Every Firecracker attempt currently creates a devmapper copy-on-write root,
creates a CNI network namespace and TAP, boots the kernel, starts the guest
agent, and only then reads the attempt's single-use JIT configuration from
MMDSv2. Image preparation removes image-pull latency, but it does not remove
kernel and guest initialization from job pickup latency.

EraInfra's isolation boundary is per attempt. A VM has a fresh CoW root,
its own network namespace and host-local address, the `ptp`, `firewall`, and
`tc-redirect-tap` CNI chain, verified nftables policy, and attempt credentials
delivered only through MMDSv2. Capacity must include every resident VM, not
only VMs that are currently running a GitHub job.

## Firecracker snapshot findings

`firecracker-go-sdk` supports creating a full or differential snapshot and
loading it through `WithSnapshot(memoryPath, statePath)`. A Firecracker
snapshot consists of guest memory and microVM state; backing disks remain
external. Restore must occur before configuring the VM, and the backing disk
paths, TAP device names, and vsock paths embedded in the snapshot must be
available at their original names. The host CPU and kernel must also be
compatible. Firecracker does not guarantee that pre-snapshot network
connections survive restore.

Firecracker's current API can override a snapshotted interface's host TAP
name, but the version pinned by EraInfra (`firecracker-go-sdk` v1.0.0)
does not expose `network_overrides` in `SnapshotLoadParams`. The pinned SDK's
load sequence creates the CNI network and then loads the snapshot; it does not
re-add drives or network devices after load. Device hotplug is not an escape
hatch because snapshot restore requires the device model to match the saved
state.

MMDS is a useful but incomplete fit for cloning. MMDS configuration is stored
in VM state, while the MMDS data store is deliberately omitted from snapshots.
That allows credentials to be supplied after restore, and the SDK supports
`SetMetadata` after boot. It does not solve the external device naming problem
or the security consequences of repeatedly cloning identical guest memory,
clock, and entropy state. Firecracker explicitly calls out guest uniqueness
when repeatedly resuming a snapshot.

Primary references:

- [Firecracker snapshot support](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md)
- [Firecracker snapshot versioning and external resources](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/versioning.md)
- [Networking for snapshot clones](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/network-for-clones.md)
- [Firecracker MMDS user guide](https://github.com/firecracker-microvm/firecracker/blob/main/docs/mmds/mmds-user-guide.md)
- [firecracker-go-sdk snapshot documentation](https://github.com/firecracker-microvm/firecracker-go-sdk/blob/main/docs/snapshotting.md)
- [firecracker-go-sdk CNI documentation](https://github.com/firecracker-microvm/firecracker-go-sdk/blob/main/README.md)

## Options considered

### Full snapshot restore with pre-created network namespace pools

This can remove kernel boot and most guest initialization. A safe
implementation would need to create a network namespace and TAP before load,
make their names match the snapshot (or upgrade the SDK and use network
overrides), and preserve a stable disk path while substituting a fresh CoW
root. It would also need guest logic to reseed clone identity and entropy,
strict snapshot/kernel/CPU compatibility metadata, immutable memory backing
files, snapshot garbage collection, and recovery for partially restored VMs.

This option does not compose cleanly with the current per-attempt CNI and
unique devmapper paths. Stable-path indirection using jailer mount namespaces
is possible, but it expands the trusted teardown and recovery surface. It is
not selected for phase 1.

### Single-use parked VM pool per profile

For each opted-in profile, boot a bounded number of VMs ahead of demand. Each
parked VM is created exactly like an attempt VM: it receives a unique VM ID, a
fresh devmapper CoW root, its own CNI network namespace and TAP, and the normal
verified network policy. MMDSv2 is configured with an empty data store. The
guest completes initialization, emits a readiness marker, and waits for
metadata.

Claiming a parked VM is an atomic, single-use operation. The VM leaves the
parked set before the JIT is written to MMDS. A successful write is never
repeated and the VM is never returned to the pool, including after an attempt
failure. Ambiguous metadata delivery fails closed and destroys the VM rather
than falling back and potentially reusing credentials. When the claimed VM is
torn down, its root, network, lease, and work directory are discarded and a
replacement may be booted.

This removes the pickup-path kernel and guest boot without cloning live state.
It consumes more resident memory than snapshots and performs background cold
boots, but it preserves the existing isolation machinery and has predictable
failure recovery.

### Status quo

Continue preparing images but cold boot every attempt. This is operationally
simple and remains the behavior when a profile does not opt in. It does not
meet the pickup-latency goal for warm-enabled profiles.

## Decision

Implement single-use parked VM pools as phase 1. A profile opts in explicitly
with `warmPool: N`; zero is the default. `N` is the profile's total pool-owned
capacity, defined as `parked + claimed`, rather than an always-idle target.
Claiming a VM therefore transfers one resident capacity unit from parked to
active without immediately booting another VM. A replacement is created only
after the claimed VM is destroyed. Demand above `N` may use the existing cold
path only when normal host capacity remains.

Parked VMs consume physical slots, vCPUs, memory, host-local addresses,
devmapper space, and containerd leases. Admission accounts for idle parked
capacity before assigning work and avoids double-counting a matching parked VM
when it is claimed. Pool creation is rejected if it would exceed the worker's
slot or resource envelope. A profile is ready only when every configured pool
slot is either parked or claimed and the parked VMs remain healthy. A pool
that cannot reach or maintain its target degrades the worker's readiness and
fails closed for warm claims.

The runtime owns pool state and teardown. Graceful shutdown destroys parked
and claimed VMs. After an agent crash the runtime keeps the pool alive and a
new agent process reconciles the declared target. After a runtime crash,
systemd's control group terminates Firecracker children and startup recovery
removes both attempt and warm containerd leases, CNI allocations, devmapper
snapshots, and work directories before the pool is rebuilt.

## Consequences

- Warm pickup performs an atomic pool claim and a single MMDSv2 metadata write;
  it does not wait for kernel boot or runner initialization.
- Every VM and credential remains single-use, and all existing network-policy
  readiness checks still gate profile readiness.
- Warm capacity has a real resident resource cost. Operators must size it
  within `maxSlots`, CPU, memory, address, and thin-pool headroom.
- Pool health becomes part of readiness. Losing a parked VM may temporarily
  degrade a previously ready profile while the replacement boots.
- Opted-out profiles and warm-capacity misses retain the cold path.
- Phase 1 does not create or restore Firecracker snapshots.

## Follow-up work

A later snapshot-restore experiment may be justified after parked-pool latency
is measured. [Issue #41](https://github.com/Fanzzzd/erainfra/issues/41) tracks
that work. It must first prove stable per-clone disk/TAP indirection, support
the Firecracker network override API in the pinned SDK, define CPU/kernel and
snapshot compatibility, reseed guest uniqueness, and test crash recovery. It
must not weaken the per-attempt CNI or fresh-root invariants.

## Validation plan

KVM hardware remains an operator dependency tracked by
[issue #17](https://github.com/Fanzzzd/erainfra/issues/17). This change does
not claim live validation. On the existing hardware-backed validation host:

1. Configure one Firecracker profile with `warmPool: 2` and confirm two unique
   parked VM IDs, roots, leases, network namespaces, TAPs, and address
   reservations. Confirm reported capacity is `parked=2, claimed=0` and total
   physical occupancy does not exceed `maxSlots`.
2. Dispatch one job and compare MMDS-to-runner registration latency against an
   opted-out cold boot. Confirm the claimed VM was already waiting, the pool is
   `parked=1, claimed=1`, and no second kernel boot occurs on the pickup path.
3. Confirm the JIT appears once through MMDSv2, the claimed slot is never
   reused, teardown removes its root/network/lease/work directory, and its
   replacement has new identities and storage.
4. Re-run issue #17's public-egress and RFC1918, host, metadata, and east-west
   denial probes from a warm claim. Readiness must not become healthy until
   nftables policy verification succeeds.
5. Fill the pool and active attempts to the slot, CPU, memory, address, and
   thin-pool limits. Confirm a matching claim transfers an existing parked
   reservation without double-counting, while unrelated or excess work is
   rejected before overcommit.
6. Kill only the agent and confirm the runtime-owned pool stays intact; restart
   the agent and confirm it reconciles the same target. Then restart the
   runtime and confirm systemd terminates its VMM children, recovery removes
   attempt and warm artifacts, and the agent rebuilds the pool.
7. Inject CNI, MMDS-write, VMM-exit, and thin-pool failures. Confirm readiness
   degrades, credentials are not retried after an ambiguous write, failed VMs
   are destroyed, and recovery either replenishes the target or remains
   explicitly unhealthy.
8. Set `warmPool` to zero or remove the profile. Confirm idle VMs drain and all
   artifacts are reclaimed without interrupting an already claimed attempt.
