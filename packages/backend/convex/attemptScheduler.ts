import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";

const WORKER_OFFLINE_AFTER_MS = 120_000;
const READINESS_STALE_AFTER_MS = 12 * 60 * 60_000;

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
    const [attempts, experiments, readinessRows, machines, profiles] = await Promise.all([
      ctx.db.query("attempts").collect(),
      ctx.db.query("experiments").collect(),
      ctx.db.query("workerReadiness").collect(),
      ctx.db.query("machines").collect(),
      ctx.db.query("profiles").collect(),
    ]);
    const activeProfileByName = new Map(
      profiles
        .filter((profile) => profile.state === "active")
        .map((profile) => [profile.name, profile]),
    );
    const machineById = new Map(machines.map((machine) => [machine._id, machine]));
    const reservedByMachine = new Map<string, { vcpus: number; memoryMiB: number }>();
    for (const attempt of attempts) {
      if (
        attempt.machineId === undefined ||
        attempt.state === "completed" ||
        attempt.state === "cancelled" ||
        attempt.state === "failed"
      ) {
        continue;
      }
      const reserved = reservedByMachine.get(attempt.machineId) ?? { vcpus: 0, memoryMiB: 0 };
      reserved.vcpus += attempt.vcpus;
      reserved.memoryMiB += attempt.memoryMiB;
      reservedByMachine.set(attempt.machineId, reserved);
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
      };
      reserved.vcpus += experiment.vcpus;
      reserved.memoryMiB += experiment.memoryMiB;
      reservedByMachine.set(experiment.machineId, reserved);
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
      const candidates = readinessRows
        .filter(
          (readiness) =>
            readiness.profile === work.profile &&
            readiness.executor === work.executor &&
            readiness.imageRelease === work.imageRelease &&
            readiness.state === "ready" &&
            now - readiness.checkedAt < READINESS_STALE_AFTER_MS,
        )
        .map((readiness) => machineById.get(readiness.machineId))
        .filter(
          (machine): machine is NonNullable<typeof machine> =>
            machine !== undefined &&
            now - machine.lastSeen < WORKER_OFFLINE_AFTER_MS &&
            machine.usedSlots < machine.maxSlots,
        )
        .map((machine) => {
          const reserved = reservedByMachine.get(machine._id) ?? { vcpus: 0, memoryMiB: 0 };
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
          if (
            reserved.vcpus + work.vcpus > usableVCPUs ||
            reserved.memoryMiB + work.memoryMiB > usableMemoryMiB
          ) {
            return undefined;
          }
          const resourcePressure = Math.max(
            machine.cpus === undefined ? 0 : reserved.vcpus / usableVCPUs,
            machine.memoryMiB === undefined ? 0 : reserved.memoryMiB / usableMemoryMiB,
            machine.usedSlots / machine.maxSlots,
          );
          return { machine, resourcePressure };
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
        // Spread work before filling one host. Name is the deterministic tie-break.
        .toSorted(
          (left, right) =>
            left.resourcePressure - right.resourcePressure ||
            left.machine.name.localeCompare(right.machine.name),
        );
      const candidate = candidates[0];
      if (candidate === undefined) continue;
      const { machine } = candidate;

      await ctx.db.patch(machine._id, { usedSlots: machine.usedSlots + 1 });
      machine.usedSlots += 1;
      if (item.kind === "attempt") {
        await ctx.db.patch(item.work._id, { machineId: machine._id });
      } else {
        await ctx.db.patch(item.work._id, { machineId: machine._id });
      }
      const reserved = reservedByMachine.get(machine._id) ?? { vcpus: 0, memoryMiB: 0 };
      reserved.vcpus += work.vcpus;
      reserved.memoryMiB += work.memoryMiB;
      reservedByMachine.set(machine._id, reserved);
      assigned += 1;
    }
    return assigned;
  },
});
