import { ConvexError, v } from "convex/values";

export type Executor = "docker" | "firecracker" | "tart" | "hyperv";
export type Boundary = "guest-kernel" | "shared-kernel";

/**
 * The isolation boundary each executor can actually provide.
 *
 * This is the product's security claim in one place. Firecracker and Tart give
 * each Job its own guest kernel; Docker shares the host kernel and the Docker
 * daemon with every other Job on the machine. A Worker that reports a boundary
 * its executor cannot deliver is rejected rather than trusted.
 */
export const EXECUTOR_BOUNDARY: Record<Executor, Boundary> = {
  docker: "shared-kernel",
  firecracker: "guest-kernel",
  tart: "guest-kernel",
  hyperv: "guest-kernel",
};

/**
 * Executors that may only run code from mutually trusting repositories. A
 * shared kernel means one Job's kernel exploit is every other Job's problem, so
 * these Profiles are labelled as a transitional on-ramp everywhere they appear.
 */
export function isTrustedOnly(executor: Executor) {
  return EXECUTOR_BOUNDARY[executor] === "shared-kernel";
}

export const boundaryValidator = v.union(v.literal("guest-kernel"), v.literal("shared-kernel"));

export const readinessCheckValidator = v.object({
  name: v.string(),
  passed: v.boolean(),
  detail: v.optional(v.string()),
});

export const readinessFactsValidator = {
  isolation: v.optional(v.string()),
  boundary: v.optional(boundaryValidator),
  checks: v.optional(v.array(readinessCheckValidator)),
  cacheScope: v.optional(v.string()),
  cacheSharedWritable: v.optional(v.boolean()),
  hardware: v.optional(
    v.object({
      arch: v.optional(v.string()),
      cpus: v.optional(v.number()),
      memoryMiB: v.optional(v.number()),
      cpuModel: v.optional(v.string()),
      virtualization: v.optional(v.string()),
      kvm: v.optional(v.boolean()),
    }),
  ),
  storage: v.optional(
    v.object({
      snapshotter: v.optional(v.string()),
      poolTotalMiB: v.optional(v.number()),
      poolFreeMiB: v.optional(v.number()),
    }),
  ),
  network: v.optional(
    v.object({
      policyName: v.optional(v.string()),
      subnet: v.optional(v.string()),
      egressMode: v.optional(v.string()),
    }),
  ),
  warmPool: v.optional(v.object({ target: v.number(), parked: v.number(), claimed: v.number() })),
};

export type ReadinessFacts = {
  isolation?: string;
  boundary?: Boundary;
  checks?: { name: string; passed: boolean; detail?: string }[];
  cacheScope?: string;
  cacheSharedWritable?: boolean;
  hardware?: { cpus?: number; memoryMiB?: number; kvm?: boolean };
  storage?: { poolFreeMiB?: number };
  warmPool?: { target: number; parked: number; claimed: number };
};

/**
 * Refuses a "ready" report whose own evidence contradicts it.
 *
 * A Worker is the only thing that can measure its host, so the control plane
 * cannot re-run these checks — but it can insist the report is self-consistent.
 * The three ways a Worker could otherwise advertise capacity it does not have:
 * a failed check alongside a ready state, a boundary weaker than the executor
 * promises, and storage shared writably between Jobs.
 */
export function assertReadinessContract(
  state: "preparing" | "ready" | "failed",
  executor: Executor,
  facts: ReadinessFacts,
) {
  if (state !== "ready") return;

  const failed = (facts.checks ?? []).filter((check) => !check.passed);
  if (failed.length > 0) {
    throw new ConvexError(
      `A Worker cannot be ready with failing checks: ${failed.map((check) => check.name).join(", ")}`,
    );
  }
  if ((facts.checks ?? []).length === 0 && facts.boundary !== undefined) {
    throw new ConvexError("A Worker reporting an isolation boundary must report its checks");
  }
  const expected = EXECUTOR_BOUNDARY[executor];
  if (facts.boundary !== undefined && facts.boundary !== expected) {
    throw new ConvexError(
      `The ${executor} executor provides a ${expected} boundary; a Worker cannot report ${facts.boundary}`,
    );
  }
  if (facts.cacheSharedWritable === true) {
    throw new ConvexError(
      "A Worker sharing writable storage between Jobs cannot be ready: that is a cross-job path",
    );
  }
  if (facts.warmPool !== undefined) {
    const { target, parked, claimed } = facts.warmPool;
    if (
      ![target, parked, claimed].every(Number.isSafeInteger) ||
      target < 0 ||
      parked < 0 ||
      claimed < 0 ||
      parked + claimed !== target
    ) {
      throw new ConvexError("A ready warm pool must report target = parked + claimed");
    }
  }
}

/**
 * Copy-on-write room one running Attempt may consume before its snapshot is
 * discarded. A CI job that installs dependencies and builds writes a few GiB
 * over the immutable image; this is a deliberately generous reservation because
 * the failure it prevents is expensive.
 */
export const SNAPSHOT_RESERVE_MIB = 8 * 1024;

/**
 * Whether a Worker still has copy-on-write room for one more Attempt.
 *
 * CPU and memory admission already happens against the Worker's measured host
 * facts. Disk is the dimension that was missing, and it fails worst: a
 * thin-pool that runs out mid-job does not reject the Attempt, it fails the
 * running Job with an I/O error after the work is already done.
 *
 * A Worker that reports no pool at all — a Docker or Tart Profile, or an older
 * Agent — is not blocked. Admission tightens as evidence arrives; it never
 * invents a constraint from missing data.
 */
export function hasSnapshotHeadroom(
  storage: { poolFreeMiB?: number } | undefined,
  concurrentAttempts: number,
  reserveMiB: number = SNAPSHOT_RESERVE_MIB,
) {
  const free = storage?.poolFreeMiB;
  if (free === undefined) return true;
  return free >= reserveMiB * (concurrentAttempts + 1);
}

export function hasSnapshotHeadroomForGuests(
  storage: { poolFreeMiB?: number } | undefined,
  guests: number,
  reserveMiB: number = SNAPSHOT_RESERVE_MIB,
) {
  const free = storage?.poolFreeMiB;
  if (free === undefined) return true;
  return free >= reserveMiB * guests;
}
