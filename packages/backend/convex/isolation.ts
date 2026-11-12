import { ConvexError, v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import {
  egressEvidenceError,
  egressEvidenceValidator,
  egressRank,
  PUBLIC_EGRESS,
  type EgressEvidence,
  type ProfileEgress,
} from "./egress";

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
      poolReserveMiB: v.optional(v.number()),
    }),
  ),
  network: v.optional(
    v.object({
      policyName: v.optional(v.string()),
      policyHash: v.optional(v.string()),
      subnet: v.optional(v.string()),
      egressMode: v.optional(v.string()),
      egress: v.optional(egressEvidenceValidator),
    }),
  ),
  warmPool: v.optional(v.object({ target: v.number(), parked: v.number(), claimed: v.number() })),
  // The actions/runner version the Worker read from the Image Release. Not part of the isolation
  // contract: a malformed one is dropped rather than refused, so it can never fail readiness.
  runnerVersion: v.optional(v.string()),
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
    poolReserveMiB?: number;
  };
  network?: {
    policyName?: string;
    policyHash?: string;
    subnet?: string;
    egressMode?: string;
    egress?: EgressEvidence;
  };
  warmPool?: { target: number; parked: number; claimed: number };
  runnerVersion?: string;
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
  "snapshot-block-zeroing",
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
export function firecrackerReadinessError(
  facts: ReadinessFacts,
  profileEgress: ProfileEgress = PUBLIC_EGRESS,
): string | undefined {
  const problems: string[] = [];
  const egressProblem = egressEvidenceError(profileEgress, facts.network?.egress, facts.checks);
  if (egressProblem !== undefined) problems.push(egressProblem);
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
  const poolReserveMiB = facts.storage?.poolReserveMiB;
  if (
    poolReserveMiB !== undefined &&
    (!Number.isSafeInteger(poolReserveMiB) || poolReserveMiB < 0)
  ) {
    problems.push("storage.poolReserveMiB must be a non-negative integer when reported");
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
  if (egressRank(facts.network?.egressMode) < 0) {
    problems.push("network.egressMode must be public, audit or allowlist");
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
  "machineId" | "profile" | "executor" | "imageRelease" | "vcpus" | "memoryMiB" | "checkedAt"
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

/**
 * Why a nominally-ready row is ineligible, including stale split evidence and
 * evidence that does not prove the Profile's current egress policy. Every
 * reader passes the Profile's egress, so a Profile switched to allowlist stops
 * admitting a Worker the moment it changes, not at that Worker's next report.
 */
export function readinessAdmissionError(
  readiness: ReadinessRow,
  evidence: EvidenceRow | undefined,
  profileEgress: ProfileEgress,
): string | undefined {
  if (readiness.executor !== "firecracker") return undefined;
  if (evidence === undefined) {
    return "no readinessEvidence for this Worker and Profile";
  }
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
  const problem = firecrackerReadinessError(evidence, profileEgress);
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
  profileEgress: ProfileEgress,
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
    const problem = firecrackerReadinessError(facts, profileEgress);
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
 * The copy-on-write room each guest needs on a Worker whose runtime does not report
 * `storage.poolReserveMiB`: the `RC_MIN_POOL_FREE_MIB` default of runtimes up to v0.2.0-rc.20.
 * A newer runtime reports the value it enforces, and placement uses that. This constant describes
 * those older runtimes only, so it does not follow a later change to the runtime's default
 * (apps/runtime/internal/firecracker/config.go, MinPoolFreeMiB).
 */
export const LEGACY_POOL_RESERVE_MIB = 8 * 1024;

/**
 * Whether a Worker's thin-pool still has copy-on-write room for this many guests.
 *
 * CPU and memory admission already happens against the Worker's measured host
 * facts. Disk is the dimension that was missing, and it fails worst: a
 * thin-pool that runs out mid-job does not reject the Attempt, it fails the
 * running Job with an I/O error after the work is already done.
 *
 * Each guest needs the reserve the Worker reports, so an operator changes it in one place, the
 * Worker's `RC_MIN_POOL_FREE_MIB`. A Worker that reports no pool at all, a Docker or Tart Profile or
 * an older Action Runner Agent, is not blocked. Admission tightens as evidence arrives; it never
 * invents a constraint from missing data.
 */
export function hasSnapshotHeadroomForGuests(
  storage: { poolFreeMiB?: number; poolReserveMiB?: number } | undefined,
  guests: number,
) {
  const free = storage?.poolFreeMiB;
  if (free === undefined) return true;
  return free >= (storage?.poolReserveMiB ?? LEGACY_POOL_RESERVE_MIB) * guests;
}
