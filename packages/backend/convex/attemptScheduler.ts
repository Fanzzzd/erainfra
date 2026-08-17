import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { benchmarkScore, type FitPolicy } from "./benchmark";
import { hasSnapshotHeadroomForGuests, readinessAdmissionError } from "./isolation";
import { WORKER_OFFLINE_AFTER_MS } from "./workerPolicy";

const READINESS_STALE_AFTER_MS = 12 * 60 * 60_000;
const RESERVED_ATTEMPT_STATES = ["preparing", "ready", "running"] as const;
const RESERVED_EXPERIMENT_STATES = ["preparing", "running"] as const;

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
    const [attemptRanges, experimentRanges, machines, profiles] = await Promise.all([
      Promise.all(
        RESERVED_ATTEMPT_STATES.map((state) =>
          ctx.db
            .query("attempts")
            .withIndex("by_state", (query) => query.eq("state", state))
            .collect(),
        ),
      ),
      Promise.all(
        RESERVED_EXPERIMENT_STATES.map((state) =>
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
    const readinessStates = ["preparing", "ready", "degraded", "failed"] as const;
    const allReadiness = (
      await Promise.all(
        profiles.flatMap((profile) =>
          readinessStates.map((state) =>
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
    const readinessByProfile = new Map<string, Doc<"workerReadiness">[]>();
    const evidenceByMachineProfile = new Map(
      evidenceRows.map((evidence) => [`${evidence.machineId}:${evidence.profile}`, evidence]),
    );
    const activeByMachineProfile = new Map<string, number>();
    const idleWarmByMachineProfile = new Map<string, number>();
    // `count` is what disk admission needs: copy-on-write growth is per running
    // guest, not per vCPU.
    const reservedByMachine = new Map<
      string,
      { vcpus: number; memoryMiB: number; count: number }
    >();
    for (const attempt of attempts) {
      if (
        attempt.machineId === undefined ||
        attempt.state === "completed" ||
        attempt.state === "cancelled" ||
        attempt.state === "failed"
      ) {
        continue;
      }
      const reserved = reservedByMachine.get(attempt.machineId) ?? {
        vcpus: 0,
        memoryMiB: 0,
        count: 0,
      };
      reserved.vcpus += attempt.vcpus;
      reserved.memoryMiB += attempt.memoryMiB;
      reserved.count += 1;
      reservedByMachine.set(attempt.machineId, reserved);
      const key = `${attempt.machineId}:${attempt.profile}`;
      activeByMachineProfile.set(key, (activeByMachineProfile.get(key) ?? 0) + 1);
    }
    for (const experiment of experiments) {
      if (
        experiment.machineId === undefined ||
        experiment.state === "completed" ||
        experiment.state === "cancelled" ||
        experiment.state === "failed"
      ) {
        continue;
      }
      const reserved = reservedByMachine.get(experiment.machineId) ?? {
        vcpus: 0,
        memoryMiB: 0,
        count: 0,
      };
      reserved.vcpus += experiment.vcpus;
      reserved.memoryMiB += experiment.memoryMiB;
      reserved.count += 1;
      reservedByMachine.set(experiment.machineId, reserved);
      const key = `${experiment.machineId}:${experiment.profile}`;
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
    const pending = [
      ...attempts
        .filter((attempt) => attempt.state === "pending" && attempt.machineId === undefined)
        .map((attempt) => ({ kind: "attempt" as const, work: attempt })),
      ...experiments
        .filter((experiment) => experiment.state === "queued" && experiment.machineId === undefined)
        .map((experiment) => ({ kind: "experiment" as const, work: experiment })),
    ]
      .filter((item) => {
        const profile = activeProfileByName.get(item.work.profile);
        return (
          profile !== undefined &&
          profile.executor === item.work.executor &&
          profile.imageRelease === item.work.imageRelease &&
          profile.vcpus === item.work.vcpus &&
          profile.memoryMiB === item.work.memoryMiB
        );
      })
      .toSorted((left, right) => left.work.createdAt - right.work.createdAt);
    let assigned = 0;

    for (const item of pending) {
      const work = item.work;
      const fitPolicy: FitPolicy = activeProfileByName.get(work.profile)?.fitPolicy ?? "balanced";
      let readinessRows = readinessByProfile.get(work.profile);
      if (readinessRows === undefined) {
        readinessRows = await ctx.db
          .query("workerReadiness")
          .withIndex("by_profile_state", (query) =>
            query.eq("profile", work.profile).eq("state", "ready"),
          )
          .collect();
        readinessByProfile.set(work.profile, readinessRows);
      }
      const candidates = readinessRows
        .filter(
          (readiness) =>
            readiness.executor === work.executor &&
            readiness.imageRelease === work.imageRelease &&
            now - readiness.checkedAt < READINESS_STALE_AFTER_MS &&
            readinessAdmissionError(
              readiness,
              evidenceByMachineProfile.get(`${readiness.machineId}:${readiness.profile}`),
            ) === undefined,
        )
        .map((readiness) => ({ readiness, machine: machineById.get(readiness.machineId) }))
        .filter(
          (entry): entry is { readiness: typeof entry.readiness; machine: Doc<"machines"> } =>
            entry.machine !== undefined && now - entry.machine.lastSeen < WORKER_OFFLINE_AFTER_MS,
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
              : machine.cpus <= work.vcpus
                ? machine.cpus
                : Math.floor(machine.cpus * 0.9);
          const usableMemoryMiB =
            machine.memoryMiB === undefined
              ? Number.POSITIVE_INFINITY
              : machine.memoryMiB <= work.memoryMiB
                ? machine.memoryMiB
                : Math.floor(machine.memoryMiB * 0.9);
          const warmKey = `${machine._id}:${work.profile}`;
          const usesWarm = (idleWarmByMachineProfile.get(warmKey) ?? 0) > 0;
          const additionalVCPUs = usesWarm ? 0 : work.vcpus;
          const additionalMemoryMiB = usesWarm ? 0 : work.memoryMiB;
          const additionalGuests = usesWarm ? 0 : 1;
          const occupiedGuests = Math.max(reserved.count, machine.usedSlots);
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
      if (candidate === undefined) continue;
      const { machine, usesWarm } = candidate;
      const selectionReason =
        `hard compatibility passed; pressure=${candidate.resourcePressure.toFixed(3)}; ` +
        `${fitPolicy} benchmark=${candidate.benchmark.score}/100 (${candidate.benchmark.source}); ` +
        `eligible=${candidates.length}`;

      await ctx.db.patch(machine._id, { usedSlots: machine.usedSlots + 1 });
      machine.usedSlots += 1;
      if (item.kind === "attempt") {
        await ctx.db.patch(item.work._id, { machineId: machine._id, selectionReason });
      } else {
        await ctx.db.patch(item.work._id, { machineId: machine._id, selectionReason });
      }
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
      assigned += 1;
    }
    return assigned;
  },
});
