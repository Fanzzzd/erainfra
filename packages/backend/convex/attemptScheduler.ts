import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import { ASSIGNED_ATTEMPT_STATES, ASSIGNED_EXPERIMENT_STATES } from "./attemptStates";
import { benchmarkScore, type FitPolicy } from "./benchmark";
import { profileEgressOf, type ProfileEgress } from "./egress";
import { carriesHostLabels } from "./hostLabels";
import { hasSnapshotHeadroomForGuests, readinessAdmissionError } from "./isolation";
import { READINESS_STATES } from "./readinessStates";
import { usableHostCapacity, WORKER_OFFLINE_AFTER_MS } from "./workerPolicy";

export const READINESS_STALE_AFTER_MS = 12 * 60 * 60_000;

export async function releaseMachineSlot(
  ctx: MutationCtx,
  machineId: Doc<"machines">["_id"] | undefined,
) {
  if (machineId === undefined) return;
  const machine = await ctx.db.get(machineId);
  if (machine === null) return;
  await ctx.db.patch(machine._id, {
    usedSlots: Math.max(0, machine.usedSlots - 1),
  });
}

export async function releaseAttemptSlot(ctx: MutationCtx, attempt: Doc<"attempts">) {
  await releaseMachineSlot(ctx, attempt.machineId);
}

/**
 * Whether a Worker's readiness row lets it take work for this exact contract now. This is the
 * single readiness rule: the scheduler, the Profile dashboard and the `/runs-on` capacity probe
 * all decide "ready" through it, so a Worker one of them counts is a Worker the others count.
 */
export function isSchedulableReadiness(
  readiness: Doc<"workerReadiness">,
  evidence: Doc<"readinessEvidence"> | undefined,
  machine: Doc<"machines"> | undefined,
  contract: {
    executor: Doc<"profiles">["executor"];
    imageRelease: string;
    // The host labels the Profile is pinned to (ADR 0017); a Worker must carry every one.
    workerLabels?: string[];
  },
  // The Profile's egress, which the evidence must prove; see egressEvidenceError.
  profileEgress: ProfileEgress,
  now: number,
): machine is Doc<"machines"> {
  return (
    readiness.state === "ready" &&
    machine !== undefined &&
    carriesHostLabels(contract.workerLabels, machine.labels) &&
    readiness.executor === contract.executor &&
    readiness.imageRelease === contract.imageRelease &&
    now - readiness.checkedAt < READINESS_STALE_AFTER_MS &&
    readinessAdmissionError(readiness, evidence, profileEgress) === undefined &&
    machine !== undefined &&
    now - machine.lastSeen < WORKER_OFFLINE_AFTER_MS
  );
}

/** The fields placement reads from an Attempt, an Experiment, or a hypothetical new job. */
type WorkContract = {
  profile: string;
  executor: Doc<"profiles">["executor"];
  imageRelease: string;
  vcpus: number;
  memoryMiB: number;
  createdAt: number;
};

type Reservation = { vcpus: number; memoryMiB: number; count: number };

/**
 * Everything placement reads, loaded once. `tryAssign` places real work from it; the capacity
 * probe places a hypothetical job behind the real queue without writing anything.
 */
export type SchedulerSnapshot = {
  now: number;
  pendingAttempts: Doc<"attempts">[];
  queuedExperiments: Doc<"experiments">[];
  activeProfileByName: Map<string, Doc<"profiles">>;
  machineById: Map<Id<"machines">, Doc<"machines">>;
  readyByProfile: Map<string, Doc<"workerReadiness">[]>;
  evidenceByMachineProfile: Map<string, Doc<"readinessEvidence">>;
  reservedByMachine: Map<string, Reservation>;
  idleWarmByMachineProfile: Map<string, number>;
  usedSlotsByMachine: Map<Id<"machines">, number>;
};

export async function loadSchedulerSnapshot(
  ctx: QueryCtx,
  now: number,
  pending?: { attempts: Doc<"attempts">[]; experiments: Doc<"experiments">[] },
): Promise<SchedulerSnapshot> {
  const [pendingAttempts, queuedExperiments] =
    pending === undefined
      ? await Promise.all([
          ctx.db
            .query("attempts")
            .withIndex("by_state", (query) => query.eq("state", "pending"))
            .collect(),
          ctx.db
            .query("experiments")
            .withIndex("by_state", (query) => query.eq("state", "queued"))
            .collect(),
        ])
      : [pending.attempts, pending.experiments];
  const [attemptRanges, experimentRanges, machines, profiles] = await Promise.all([
    Promise.all(
      ASSIGNED_ATTEMPT_STATES.map((state) =>
        ctx.db
          .query("attempts")
          .withIndex("by_state", (query) => query.eq("state", state))
          .collect(),
      ),
    ),
    Promise.all(
      ASSIGNED_EXPERIMENT_STATES.map((state) =>
        ctx.db
          .query("experiments")
          .withIndex("by_state", (query) => query.eq("state", state))
          .collect(),
      ),
    ),
    ctx.db
      .query("machines")
      .withIndex("by_lastSeen", (query) => query.gt("lastSeen", now - WORKER_OFFLINE_AFTER_MS))
      .collect(),
    ctx.db
      .query("profiles")
      .withIndex("by_state", (query) => query.eq("state", "active"))
      .collect(),
  ]);
  const allReadiness = (
    await Promise.all(
      profiles.flatMap((profile) =>
        READINESS_STATES.map((state) =>
          ctx.db
            .query("workerReadiness")
            .withIndex("by_profile_state", (query) =>
              query.eq("profile", profile.name).eq("state", state),
            )
            .collect(),
        ),
      ),
    )
  ).flat();
  const evidenceRows = (
    await Promise.all(
      allReadiness
        .filter((readiness) => readiness.state === "ready")
        .map((readiness) =>
          ctx.db
            .query("readinessEvidence")
            .withIndex("by_machine_profile", (query) =>
              query.eq("machineId", readiness.machineId).eq("profile", readiness.profile),
            )
            .unique(),
        ),
    )
  ).filter((evidence): evidence is NonNullable<typeof evidence> => evidence !== null);
  const attempts = [...pendingAttempts, ...attemptRanges.flat()];
  const experiments = [...queuedExperiments, ...experimentRanges.flat()];
  const activeProfileByName = new Map(profiles.map((profile) => [profile.name, profile]));
  const machineById = new Map(machines.map((machine) => [machine._id, machine]));
  const readyByProfile = new Map<string, Doc<"workerReadiness">[]>();
  for (const readiness of allReadiness) {
    if (readiness.state !== "ready") continue;
    const rows = readyByProfile.get(readiness.profile) ?? [];
    rows.push(readiness);
    readyByProfile.set(readiness.profile, rows);
  }
  const evidenceByMachineProfile = new Map(
    evidenceRows.map((evidence) => [`${evidence.machineId}:${evidence.profile}`, evidence]),
  );
  const activeByMachineProfile = new Map<string, number>();
  const idleWarmByMachineProfile = new Map<string, number>();
  // `count` is what disk admission needs: copy-on-write growth is per running
  // guest, not per vCPU.
  const reservedByMachine = new Map<string, Reservation>();
  for (const work of [...attempts, ...experiments]) {
    if (
      work.machineId === undefined ||
      work.state === "completed" ||
      work.state === "cancelled" ||
      work.state === "failed"
    ) {
      continue;
    }
    const reserved = reservedByMachine.get(work.machineId) ?? {
      vcpus: 0,
      memoryMiB: 0,
      count: 0,
    };
    reserved.vcpus += work.vcpus;
    reserved.memoryMiB += work.memoryMiB;
    reserved.count += 1;
    reservedByMachine.set(work.machineId, reserved);
    const key = `${work.machineId}:${work.profile}`;
    activeByMachineProfile.set(key, (activeByMachineProfile.get(key) ?? 0) + 1);
  }
  for (const readiness of allReadiness) {
    if (readiness.warmPool === undefined || !machineById.has(readiness.machineId)) continue;
    const profile = activeProfileByName.get(readiness.profile);
    if (
      profile === undefined ||
      profile.executor !== readiness.executor ||
      profile.imageRelease !== readiness.imageRelease ||
      (readiness.vcpus !== undefined && readiness.vcpus !== profile.vcpus) ||
      (readiness.memoryMiB !== undefined && readiness.memoryMiB !== profile.memoryMiB) ||
      (readiness.warmPool?.target ?? 0) !== (profile.warmPool ?? 0)
    )
      continue;
    const target = readiness.warmPool.parked + readiness.warmPool.claimed;
    const key = `${readiness.machineId}:${readiness.profile}`;
    const idle = Math.max(0, target - (activeByMachineProfile.get(key) ?? 0));
    if (idle === 0) continue;
    idleWarmByMachineProfile.set(key, idle);
    const reserved = reservedByMachine.get(readiness.machineId) ?? {
      vcpus: 0,
      memoryMiB: 0,
      count: 0,
    };
    reserved.vcpus += idle * profile.vcpus;
    reserved.memoryMiB += idle * profile.memoryMiB;
    reserved.count += idle;
    reservedByMachine.set(readiness.machineId, reserved);
  }
  return {
    now,
    pendingAttempts,
    queuedExperiments,
    activeProfileByName,
    machineById,
    readyByProfile,
    evidenceByMachineProfile,
    reservedByMachine,
    idleWarmByMachineProfile,
    usedSlotsByMachine: new Map(machines.map((machine) => [machine._id, machine.usedSlots])),
  };
}

/** Whether a Profile still describes exactly this work's contract. */
export function matchesActiveProfile(snapshot: SchedulerSnapshot, work: WorkContract) {
  const profile = snapshot.activeProfileByName.get(work.profile);
  return (
    profile !== undefined &&
    profile.executor === work.executor &&
    profile.imageRelease === work.imageRelease &&
    profile.vcpus === work.vcpus &&
    profile.memoryMiB === work.memoryMiB
  );
}

export type Placement<I> =
  | { item: I; machine: Doc<"machines">; selectionReason: string }
  | { item: I; machine: undefined; selectionReason?: undefined };

/**
 * Places `items` in order, first fit by resource pressure then benchmark. Consumes the
 * snapshot's reservations as it goes, so a later item sees the earlier ones' placements.
 * Pure over the snapshot: the caller decides whether to persist the result.
 */
export function placeInOrder<I extends { work: WorkContract }>(
  snapshot: SchedulerSnapshot,
  items: I[],
): Array<Placement<I>> {
  const { now, machineById, reservedByMachine, idleWarmByMachineProfile, usedSlotsByMachine } =
    snapshot;
  return items.map((item) => {
    const work = item.work;
    const profile = snapshot.activeProfileByName.get(work.profile);
    const fitPolicy: FitPolicy = profile?.fitPolicy ?? "balanced";
    // The pin is read from the Profile now, not copied onto the Attempt: a queued Attempt waits for
    // a Worker that carries the Profile's current labels.
    const contract = { ...work, workerLabels: profile?.workerLabels };
    const candidates = (snapshot.readyByProfile.get(work.profile) ?? [])
      .map((readiness) => ({ readiness, machine: machineById.get(readiness.machineId) }))
      .filter((entry): entry is { readiness: Doc<"workerReadiness">; machine: Doc<"machines"> } =>
        isSchedulableReadiness(
          entry.readiness,
          snapshot.evidenceByMachineProfile.get(
            `${entry.readiness.machineId}:${entry.readiness.profile}`,
          ),
          entry.machine,
          contract,
          profileEgressOf(profile ?? {}),
          now,
        ),
      )
      .map(({ readiness, machine }) => {
        const reserved = reservedByMachine.get(machine._id) ?? {
          vcpus: 0,
          memoryMiB: 0,
          count: 0,
        };
        const usableVCPUs =
          machine.cpus === undefined
            ? Number.POSITIVE_INFINITY
            : usableHostCapacity(machine.cpus, work.vcpus);
        const usableMemoryMiB =
          machine.memoryMiB === undefined
            ? Number.POSITIVE_INFINITY
            : usableHostCapacity(machine.memoryMiB, work.memoryMiB);
        const warmKey = `${machine._id}:${work.profile}`;
        const usesWarm = (idleWarmByMachineProfile.get(warmKey) ?? 0) > 0;
        const additionalVCPUs = usesWarm ? 0 : work.vcpus;
        const additionalMemoryMiB = usesWarm ? 0 : work.memoryMiB;
        const additionalGuests = usesWarm ? 0 : 1;
        const usedSlots = usedSlotsByMachine.get(machine._id) ?? machine.usedSlots;
        const occupiedGuests = Math.max(reserved.count, usedSlots);
        if (
          occupiedGuests + additionalGuests > machine.maxSlots ||
          reserved.vcpus + additionalVCPUs > usableVCPUs ||
          reserved.memoryMiB + additionalMemoryMiB > usableMemoryMiB ||
          !hasSnapshotHeadroomForGuests(readiness.storage, occupiedGuests + additionalGuests)
        ) {
          return undefined;
        }
        const resourcePressure = Math.max(
          machine.cpus === undefined ? 0 : reserved.vcpus / usableVCPUs,
          machine.memoryMiB === undefined ? 0 : reserved.memoryMiB / usableMemoryMiB,
          occupiedGuests / machine.maxSlots,
        );
        return {
          machine,
          usesWarm,
          resourcePressure,
          benchmark: benchmarkScore(machine.benchmark, fitPolicy, now),
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
      // Spread work before filling one host. Benchmark only ranks candidates
      // at equal pressure; name remains the deterministic final tie-break.
      .toSorted(
        (left, right) =>
          left.resourcePressure - right.resourcePressure ||
          right.benchmark.score - left.benchmark.score ||
          left.machine.name.localeCompare(right.machine.name),
      );
    const candidate = candidates[0];
    if (candidate === undefined) return { item, machine: undefined };
    const { machine, usesWarm } = candidate;
    const selectionReason =
      `hard compatibility passed; pressure=${candidate.resourcePressure.toFixed(3)}; ` +
      `${fitPolicy} benchmark=${candidate.benchmark.score}/100 (${candidate.benchmark.source}); ` +
      `eligible=${candidates.length}`;

    usedSlotsByMachine.set(machine._id, (usedSlotsByMachine.get(machine._id) ?? 0) + 1);
    const reserved = reservedByMachine.get(machine._id) ?? {
      vcpus: 0,
      memoryMiB: 0,
      count: 0,
    };
    const warmKey = `${machine._id}:${work.profile}`;
    if (usesWarm) {
      idleWarmByMachineProfile.set(warmKey, (idleWarmByMachineProfile.get(warmKey) ?? 1) - 1);
    } else {
      reserved.vcpus += work.vcpus;
      reserved.memoryMiB += work.memoryMiB;
      reserved.count += 1;
    }
    reservedByMachine.set(machine._id, reserved);
    return { item, machine, selectionReason };
  });
}

/** Unassigned work the scheduler would consider, oldest first. */
export function unassignedQueue(snapshot: SchedulerSnapshot) {
  return [
    ...snapshot.pendingAttempts
      .filter((attempt) => attempt.machineId === undefined)
      .map((attempt) => ({ kind: "attempt" as const, work: attempt })),
    ...snapshot.queuedExperiments
      .filter((experiment) => experiment.machineId === undefined)
      .map((experiment) => ({ kind: "experiment" as const, work: experiment })),
  ]
    .filter((item) => matchesActiveProfile(snapshot, item.work))
    .toSorted((left, right) => left.work.createdAt - right.work.createdAt);
}

export const tryAssign = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const now = Date.now();
    const [pendingAttempts, queuedExperiments] = await Promise.all([
      ctx.db
        .query("attempts")
        .withIndex("by_state", (query) => query.eq("state", "pending"))
        .collect(),
      ctx.db
        .query("experiments")
        .withIndex("by_state", (query) => query.eq("state", "queued"))
        .collect(),
    ]);
    if (
      !pendingAttempts.some((attempt) => attempt.machineId === undefined) &&
      !queuedExperiments.some((experiment) => experiment.machineId === undefined)
    ) {
      return 0;
    }
    const snapshot = await loadSchedulerSnapshot(ctx, now, {
      attempts: pendingAttempts,
      experiments: queuedExperiments,
    });
    const placements = placeInOrder(snapshot, unassignedQueue(snapshot));
    let assigned = 0;
    for (const placement of placements) {
      if (placement.machine === undefined) continue;
      const assignment = {
        machineId: placement.machine._id,
        selectionReason: placement.selectionReason,
      };
      if (placement.item.kind === "attempt") {
        await ctx.db.patch(placement.item.work._id, assignment);
      } else {
        await ctx.db.patch(placement.item.work._id, assignment);
      }
      assigned += 1;
    }
    for (const [machineId, usedSlots] of snapshot.usedSlotsByMachine) {
      const machine = snapshot.machineById.get(machineId);
      if (machine !== undefined && machine.usedSlots !== usedSlots) {
        await ctx.db.patch(machine._id, { usedSlots });
      }
    }
    return assigned;
  },
});
