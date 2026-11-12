import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { retireAttempt } from "./attemptRetirement";
import { releaseAttemptSlot } from "./attemptScheduler";
import { IDLE_ATTEMPT_STATES } from "./attemptStates";
import { missingHostLabels, missingHostLabelsDetail } from "./hostLabels";

export type PinRetirement = { requeued: number; retired: number };

/**
 * Takes a pinned Profile's idle work off a Worker that no longer carries every label it is pinned
 * to (ADR 0017). The scheduler reads the pin at placement, but an Attempt it already placed keeps
 * its Worker, and once its Runner is online GitHub may hand it the Profile's next job:
 *
 * - `pending` with a Worker: placed, not yet claimed, its Runner not started. It goes back to the
 *   queue with its JIT config, and the scheduler places it on a Worker that carries the labels.
 * - `preparing` and `ready`: the Runner is starting or idle and registered. It is retired as a
 *   scale-down does (attemptRetirement.ts): the controller deletes its Runner, and only then is the
 *   Attempt cancelled and its executor stopped. If GitHub handed the Runner a job first, the job
 *   wins and finishes where it is. The controller stops counting a retiring Attempt and creates a
 *   replacement, which the scheduler places on a labelled Worker.
 * - `running`: GitHub has handed it a job. It finishes where it is.
 */
async function retireIfOffPin(
  ctx: MutationCtx,
  attempt: Doc<"attempts">,
  profile: Doc<"profiles"> | null,
  machine: Doc<"machines"> | null,
  tally: PinRetirement,
) {
  if (profile === null || machine === null) return;
  const missing = missingHostLabels(profile.workerLabels, machine.labels);
  if (missing.length === 0) return;
  const why = `Worker ${machine.name}: ${missingHostLabelsDetail(missing)}`;
  if (attempt.state === "pending") {
    await releaseAttemptSlot(ctx, attempt);
    await ctx.db.patch(attempt._id, { machineId: undefined, selectionReason: undefined });
    console.info(`Attempt ${attempt.runnerName} of ${profile.name} back in the queue. ${why}`);
    tally.requeued += 1;
    return;
  }
  if (await retireAttempt(ctx, attempt, "cancelled", `Retired before it took a job. ${why}`)) {
    console.info(`Runner ${attempt.runnerName} of ${profile.name} retiring. ${why}`);
    tally.retired += 1;
  }
}

/** After a Worker's labels change: its idle Attempts whose Profile it no longer qualifies for. */
export async function retireOffPinOnWorker(ctx: MutationCtx, machine: Doc<"machines">) {
  const tally: PinRetirement = { requeued: 0, retired: 0 };
  const profiles = new Map<string, Doc<"profiles"> | null>();
  for (const state of IDLE_ATTEMPT_STATES) {
    const attempts = await ctx.db
      .query("attempts")
      .withIndex("by_machine_state_finishedAt", (q) =>
        q.eq("machineId", machine._id).eq("state", state),
      )
      .collect();
    for (const attempt of attempts) {
      if (!profiles.has(attempt.profile)) {
        profiles.set(
          attempt.profile,
          await ctx.db
            .query("profiles")
            .withIndex("by_name", (q) => q.eq("name", attempt.profile))
            .unique(),
        );
      }
      await retireIfOffPin(ctx, attempt, profiles.get(attempt.profile) ?? null, machine, tally);
    }
  }
  return tally;
}

/** After a Profile's pin changes: its idle Attempts on Workers that do not carry the new pin. */
export async function retireOffPinForProfile(ctx: MutationCtx, profile: Doc<"profiles">) {
  const tally: PinRetirement = { requeued: 0, retired: 0 };
  if (profile.workerLabels === undefined || profile.workerLabels.length === 0) return tally;
  for (const state of IDLE_ATTEMPT_STATES) {
    const attempts = await ctx.db
      .query("attempts")
      .withIndex("by_profile_state", (q) => q.eq("profile", profile.name).eq("state", state))
      .collect();
    for (const attempt of attempts) {
      if (attempt.machineId === undefined) continue;
      await retireIfOffPin(ctx, attempt, profile, await ctx.db.get(attempt.machineId), tally);
    }
  }
  return tally;
}
