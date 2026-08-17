import { ConvexError, v } from "convex/values";
import type { Doc } from "./_generated/dataModel";

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
      poolName: v.optional(v.string()),
      poolTotalMiB: v.optional(v.number()),
      poolFreeMiB: v.optional(v.number()),
    }),
  ),
  network: v.optional(
    v.object({
      policyName: v.optional(v.string()),
      policyHash: v.optional(v.string()),
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
  storage?: {
    snapshotter?: string;
    poolName?: string;
    poolTotalMiB?: number;
    poolFreeMiB?: number;
  };
  network?: {
    policyName?: string;
    policyHash?: string;
    subnet?: string;
    egressMode?: string;
  };
  warmPool?: { target: number; parked: number; claimed: number };
};

export const FIRECRACKER_REQUIRED_CHECKS = [
  "firecracker-binary",
  "guest-kernel-image",
  "guest-kernel-arguments",
  "kvm-device",
  "cni-plugins",
  "cni-network-configuration",
  "job-network-policy",
  "containerd-snapshotter",
  "cni-address-reservations",
  "snapshot-storage-headroom",
  "cache-isolation",
  "image-release",
  "warm-pool",
] as const;

const POLICY_HASH = /^sha256:[0-9a-f]{64}$/;

/**
 * Names every missing or contradictory fact in a Firecracker ready report.
 *
 * The Worker remains the authority that measures the host, but admission does
 * not turn an absent field into a successful measurement. Keeping this pure
 * lets the write path, scheduler, and dashboard apply the same fail-closed
 * rule to new reports and schema-compatible historical rows.
 */
export function firecrackerReadinessError(facts: ReadinessFacts): string | undefined {
  const problems: string[] = [];
  if (facts.isolation !== "firecracker-microvm") {
    problems.push("isolation must be firecracker-microvm");
  }
  if (facts.boundary !== "guest-kernel") {
    problems.push("boundary must be guest-kernel");
  }
  if (facts.hardware?.kvm !== true) {
    problems.push("hardware.kvm must be true");
  }
  if (facts.storage?.snapshotter !== "devmapper") {
    problems.push("storage.snapshotter must be devmapper");
  }
  if (facts.storage?.poolName?.trim() === "" || facts.storage?.poolName === undefined) {
    problems.push("storage.poolName is required");
  }
  const poolTotalMiB = facts.storage?.poolTotalMiB;
  const poolFreeMiB = facts.storage?.poolFreeMiB;
  if (!Number.isSafeInteger(poolTotalMiB) || (poolTotalMiB ?? 0) <= 0) {
    problems.push("storage.poolTotalMiB must be a positive integer");
  }
  if (
    !Number.isSafeInteger(poolFreeMiB) ||
    (poolFreeMiB ?? 0) <= 0 ||
    (poolTotalMiB !== undefined && (poolFreeMiB ?? 0) > poolTotalMiB)
  ) {
    problems.push("storage.poolFreeMiB must be positive headroom within the pool");
  }
  if (facts.network?.policyName?.trim() === "" || facts.network?.policyName === undefined) {
    problems.push("network.policyName is required");
  }
  if (!POLICY_HASH.test(facts.network?.policyHash ?? "")) {
    problems.push("network.policyHash must be an exact sha256 identity");
  }
  if (facts.network?.subnet?.trim() === "" || facts.network?.subnet === undefined) {
    problems.push("network.subnet is required");
  }
  if (facts.network?.egressMode !== "public" && facts.network?.egressMode !== "allowlist") {
    problems.push("network.egressMode must be public or allowlist");
  }
  if (facts.cacheScope !== "immutable-image") {
    problems.push("cacheScope must be immutable-image");
  }
  if (facts.cacheSharedWritable !== false) {
    problems.push("cacheSharedWritable must be false");
  }

  const checkNames = new Set<string>();
  const duplicateChecks = new Set<string>();
  for (const check of facts.checks ?? []) {
    if (checkNames.has(check.name)) duplicateChecks.add(check.name);
    checkNames.add(check.name);
  }
  const failedChecks = (facts.checks ?? [])
    .filter((check) => !check.passed)
    .map((check) => check.name);
  if (failedChecks.length > 0) {
    problems.push(`checks must pass: ${failedChecks.join(", ")}`);
  }
  if (duplicateChecks.size > 0) {
    problems.push(`checks must be unique: ${[...duplicateChecks].join(", ")}`);
  }
  const missingChecks = FIRECRACKER_REQUIRED_CHECKS.filter((name) => !checkNames.has(name));
  if (missingChecks.length > 0) {
    problems.push(`required checks are missing: ${missingChecks.join(", ")}`);
  }
  return problems.length === 0 ? undefined : problems.join("; ");
}

type ReadinessRow = Pick<
  Doc<"workerReadiness">,
  | "machineId"
  | "profile"
  | "executor"
  | "imageRelease"
  | "vcpus"
  | "memoryMiB"
  | "checkedAt"
  | "isolation"
  | "boundary"
  | "checks"
  | "cacheScope"
  | "cacheSharedWritable"
  | "hardware"
  | "storage"
  | "network"
>;

type EvidenceRow = Pick<
  Doc<"readinessEvidence">,
  | "machineId"
  | "profile"
  | "executor"
  | "imageRelease"
  | "vcpus"
  | "memoryMiB"
  | "checkedAt"
  | "isolation"
  | "boundary"
  | "checks"
  | "cacheScope"
  | "cacheSharedWritable"
  | "hardware"
  | "storage"
  | "network"
>;

/** Why a nominally-ready row is ineligible, including stale split evidence. */
export function readinessAdmissionError(
  readiness: ReadinessRow,
  evidence: EvidenceRow | undefined,
): string | undefined {
  if (readiness.executor !== "firecracker") return undefined;
  let facts: ReadinessFacts;
  if (evidence === undefined) {
    // Historical rows stored facts inline. They remain schema-valid, but the
    // same completeness check applies and normally explains exactly what their
    // older evidence did not prove.
    facts = readiness;
  } else {
    const exactCurrentEvidence =
      evidence.machineId === readiness.machineId &&
      evidence.profile === readiness.profile &&
      evidence.executor === readiness.executor &&
      evidence.imageRelease === readiness.imageRelease &&
      evidence.vcpus === readiness.vcpus &&
      evidence.memoryMiB === readiness.memoryMiB &&
      evidence.checkedAt === readiness.checkedAt;
    if (!exactCurrentEvidence) {
      return "current readinessEvidence does not match this Worker, Profile contract, and checkedAt";
    }
    facts = evidence;
  }
  const problem = firecrackerReadinessError(facts);
  return problem === undefined
    ? undefined
    : `Firecracker readiness evidence is incomplete: ${problem}`;
}

/**
 * Refuses a "ready" report whose own evidence contradicts it.
 *
 * A Worker is the only thing that can measure its host, so the control plane
 * cannot re-run these checks — but it can insist the report is self-consistent.
 * This rejects failed checks, a boundary weaker than the executor promises,
 * shared writable storage, and Firecracker's executor-specific omissions.
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
  if (executor === "firecracker") {
    const problem = firecrackerReadinessError(facts);
    if (problem !== undefined) {
      throw new ConvexError(`Firecracker readiness evidence is incomplete: ${problem}`);
    }
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
