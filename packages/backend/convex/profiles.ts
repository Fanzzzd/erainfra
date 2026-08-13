import { v } from "convex/values";
import { requireDashboardAuth } from "./dashboardAuth";
import {
  boundaryValidator,
  EXECUTOR_BOUNDARY,
  isTrustedOnly,
  readinessCheckValidator,
} from "./isolation";
import { query } from "./_generated/server";

const executorValidator = v.union(
  v.literal("docker"),
  v.literal("firecracker"),
  v.literal("tart"),
  v.literal("hyperv"),
);

export const list = query({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("profiles"),
      name: v.string(),
      scaleSetName: v.string(),
      executor: executorValidator,
      imageRelease: v.string(),
      vcpus: v.number(),
      memoryMiB: v.number(),
      minRunners: v.number(),
      maxRunners: v.number(),
      state: v.union(v.literal("active"), v.literal("paused")),
      updatedAt: v.number(),
      readyWorkers: v.number(),
      readySlots: v.number(),
      freeSlots: v.number(),
      // What this Profile's executor can actually promise, and what its Workers
      // proved. A workflow author choosing `runs-on` needs to see the real
      // boundary, not infer it from the Profile name.
      boundary: boundaryValidator,
      trustedOnly: v.boolean(),
      workers: v.array(
        v.object({
          machineId: v.id("machines"),
          machineName: v.string(),
          state: v.union(
            v.literal("preparing"),
            v.literal("ready"),
            v.literal("degraded"),
            v.literal("failed"),
          ),
          checkedAt: v.number(),
          preparedAt: v.optional(v.number()),
          statusDetail: v.optional(v.string()),
          online: v.boolean(),
          maxSlots: v.number(),
          usedSlots: v.number(),
          isolation: v.optional(v.string()),
          boundary: v.optional(boundaryValidator),
          cacheScope: v.optional(v.string()),
          cacheSharedWritable: v.optional(v.boolean()),
          checks: v.optional(v.array(readinessCheckValidator)),
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
          lastError: v.optional(v.string()),
        }),
      ),
    }),
  ),
  handler: async (ctx) => {
    await requireDashboardAuth(ctx);
    const now = Date.now();
    const [profiles, readiness, machines] = await Promise.all([
      ctx.db.query("profiles").collect(),
      ctx.db.query("workerReadiness").collect(),
      ctx.db.query("machines").collect(),
    ]);
    const machineById = new Map(machines.map((machine) => [machine._id, machine]));
    return profiles
      .toSorted((left, right) => left.name.localeCompare(right.name))
      .map((profile) => {
        const rows = readiness.filter(
          (row) =>
            row.profile === profile.name &&
            row.executor === profile.executor &&
            row.imageRelease === profile.imageRelease,
        );
        const workers = rows
          .filter(
            (row) =>
              row.state === "ready" &&
              profile.state === "active" &&
              now - row.checkedAt < 12 * 60 * 60_000,
          )
          .map((row) => machineById.get(row.machineId))
          .filter(
            (machine): machine is NonNullable<typeof machine> =>
              machine !== undefined && now - machine.lastSeen < 120_000,
          );
        const workerDetail = rows.flatMap((row) => {
          const machine = machineById.get(row.machineId);
          if (machine === undefined) return [];
          return [
            {
              machineId: row.machineId,
              machineName: machine.name,
              state: row.state,
              checkedAt: row.checkedAt,
              preparedAt: row.preparedAt,
              statusDetail: row.statusDetail,
              online: now - machine.lastSeen < 120_000,
              maxSlots: machine.maxSlots,
              usedSlots: machine.usedSlots,
              isolation: row.isolation,
              boundary: row.boundary,
              cacheScope: row.cacheScope,
              cacheSharedWritable: row.cacheSharedWritable,
              checks: row.checks,
              hardware: row.hardware,
              storage: row.storage,
              network: row.network,
              lastError: row.lastError,
            },
          ];
        });
        return {
          boundary: EXECUTOR_BOUNDARY[profile.executor],
          trustedOnly: isTrustedOnly(profile.executor),
          workers: workerDetail.toSorted((left, right) =>
            left.machineName.localeCompare(right.machineName),
          ),
          _id: profile._id,
          name: profile.name,
          scaleSetName: profile.scaleSetName,
          executor: profile.executor,
          imageRelease: profile.imageRelease,
          vcpus: profile.vcpus,
          memoryMiB: profile.memoryMiB,
          minRunners: profile.minRunners,
          maxRunners: profile.maxRunners,
          state: profile.state,
          updatedAt: profile.updatedAt,
          readyWorkers: workers.length,
          readySlots: workers.reduce((total, machine) => total + machine.maxSlots, 0),
          freeSlots: workers.reduce(
            (total, machine) => total + Math.max(0, machine.maxSlots - machine.usedSlots),
            0,
          ),
        };
      });
  },
});
