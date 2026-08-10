import { v } from "convex/values";
import { requireDashboardAuth } from "./dashboardAuth";
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
        const workers = readiness
          .filter(
            (row) =>
              row.profile === profile.name &&
              row.executor === profile.executor &&
              row.imageRelease === profile.imageRelease &&
              row.state === "ready" &&
              profile.state === "active" &&
              now - row.checkedAt < 12 * 60 * 60_000,
          )
          .map((row) => machineById.get(row.machineId))
          .filter(
            (machine): machine is NonNullable<typeof machine> =>
              machine !== undefined && now - machine.lastSeen < 120_000,
          );
        return {
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
