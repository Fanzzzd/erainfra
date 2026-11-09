import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { carriesHostLabels } from "./hostLabels";

// Workers heartbeat well inside this window. Two missed minutes is the shared
// cutoff for availability, scheduling, and reconciliation decisions.
export const WORKER_OFFLINE_AFTER_MS = 2 * 60_000;

/**
 * The active Profiles a Worker serves: an executor its OS can run, and every
 * label the Profile is pinned to (ADR 0017). This is the list the Worker reads
 * to prepare images and report readiness, and the list its slot envelope is
 * sized against.
 */
export async function servedProfiles(
  ctx: QueryCtx,
  worker: Pick<Doc<"machines">, "os" | "labels">,
) {
  const compatibleExecutors =
    worker.os === "linux"
      ? new Set(["docker", "firecracker"])
      : new Set([worker.os === "mac" ? "tart" : "hyperv"]);
  return (
    await ctx.db
      .query("profiles")
      .withIndex("by_state", (q) => q.eq("state", "active"))
      .collect()
  )
    .filter(
      (profile) =>
        compatibleExecutors.has(profile.executor) &&
        carriesHostLabels(profile.workerLabels, worker.labels),
    )
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

/**
 * The memory one slot needs on this Worker: the largest Profile it serves, or
 * undefined when it serves none yet. Read when host facts or a benchmark are
 * reported, so a Profile added or resized later reaches the slot count at the
 * Worker's next boot or daily benchmark, not immediately.
 */
export async function largestServedProfileMemoryMiB(
  ctx: QueryCtx,
  worker: Pick<Doc<"machines">, "os" | "labels">,
) {
  const sizes = (await servedProfiles(ctx, worker)).map((profile) => profile.memoryMiB);
  return sizes.length === 0 ? undefined : Math.max(...sizes);
}
