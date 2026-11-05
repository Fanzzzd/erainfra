import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import {
  isSchedulableReadiness,
  loadSchedulerSnapshot,
  placeInOrder,
  unassignedQueue,
} from "./attemptScheduler";

const LIVE_ATTEMPT_STATES = ["pending", "preparing", "ready", "running"] as const;

const executorValidator = v.union(
  v.literal("docker"),
  v.literal("firecracker"),
  v.literal("tart"),
  v.literal("hyperv"),
);

export const fallbackReasonValidator = v.union(
  v.literal("unknown-profile"),
  v.literal("paused"),
  v.literal("no-ready-worker"),
  v.literal("saturated"),
);

/**
 * Whether a job sent to this Profile now would start without waiting, for the `/runs-on` router.
 *
 * It needs an active Profile, at least one Worker that passes the scheduler's readiness predicate,
 * and live Attempts below `maxRunners` (the bound the controller's scaler applies). Then the
 * answer is "profile" in two cases:
 * - a Runner of this Profile is online and not promised to a job already waiting (one of the
 *   `minRunners` kept warm), so GitHub hands it the next job directly; or
 * - the scheduler would place one more Attempt on a Worker right now, behind every Attempt and
 *   Experiment already waiting. Placement is the scheduler's own dry run over the same snapshot
 *   `tryAssign` reads, so the readiness, slot, CPU, memory, disk and warm-pool rules are the
 *   scheduler's rules, not a second copy of them.
 *
 * Everything else is a fallback, including a backlog of any length: GitHub gives no estimate of
 * how long a queued job will wait, so a free slot now is the only promise this can keep.
 */
export const profileRoute = internalQuery({
  args: { profile: v.string() },
  returns: v.union(
    v.object({ route: v.literal("profile"), executor: executorValidator }),
    v.object({
      route: v.literal("fallback"),
      reason: fallbackReasonValidator,
      executor: v.optional(executorValidator),
    }),
  ),
  handler: async (ctx, args) => {
    const now = Date.now();
    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_name", (query) => query.eq("name", args.profile))
      .unique();
    if (profile === null) {
      return { route: "fallback" as const, reason: "unknown-profile" as const };
    }
    const executor = profile.executor;
    if (profile.state !== "active") {
      return { route: "fallback" as const, reason: "paused" as const, executor };
    }

    const snapshot = await loadSchedulerSnapshot(ctx, now);
    const readyWorkers = (snapshot.readyByProfile.get(profile.name) ?? []).filter((readiness) =>
      isSchedulableReadiness(
        readiness,
        snapshot.evidenceByMachineProfile.get(`${readiness.machineId}:${readiness.profile}`),
        snapshot.machineById.get(readiness.machineId),
        profile,
        now,
      ),
    );
    if (readyWorkers.length === 0) {
      return { route: "fallback" as const, reason: "no-ready-worker" as const, executor };
    }

    // Bounded per state: the decision only needs to know whether the total reaches maxRunners.
    const [pending, preparing, ready, running] = await Promise.all(
      LIVE_ATTEMPT_STATES.map(
        async (state) =>
          (
            await ctx.db
              .query("attempts")
              .withIndex("by_profile_state", (query) =>
                query.eq("profile", profile.name).eq("state", state),
              )
              .take(profile.maxRunners)
          ).length,
      ),
    );
    const live = (pending ?? 0) + (preparing ?? 0) + (ready ?? 0) + (running ?? 0);
    // At the cap the controller creates nothing more, and GitHub may hold jobs this side cannot
    // see, so even a Runner that looks idle may already be promised to one of them.
    if (live >= profile.maxRunners) {
      return { route: "fallback" as const, reason: "saturated" as const, executor };
    }
    // Below the cap the scaler keeps live = minRunners + jobs GitHub assigned to the scale set, so
    // the jobs still waiting for a Runner are live - minRunners - running. A ready Runner beyond
    // those is idle and takes the next job at once.
    const waitingJobs = Math.max(0, live - profile.minRunners - (running ?? 0));
    if ((ready ?? 0) > waitingJobs) {
      return { route: "profile" as const, executor };
    }

    const probe = {
      work: {
        profile: profile.name,
        executor: profile.executor,
        imageRelease: profile.imageRelease,
        vcpus: profile.vcpus,
        memoryMiB: profile.memoryMiB,
        createdAt: now,
      },
    };
    const placements = placeInOrder(snapshot, [...unassignedQueue(snapshot), probe]);
    const placed = placements.at(-1)?.machine !== undefined;
    return placed
      ? { route: "profile" as const, executor }
      : { route: "fallback" as const, reason: "saturated" as const, executor };
  },
});
