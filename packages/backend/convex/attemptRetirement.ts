import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { releaseAttemptSlot } from "./attemptScheduler";
import { deleteAttemptSecret } from "./attemptSecrets";

/**
 * Ending an Attempt whose GitHub Runner may be online, in the order ARC uses for an ephemeral
 * runner: GitHub first, the executor last.
 *
 * GitHub hands a pending job to any idle Runner of the scale set, and the JobStarted for it reaches
 * Convex only after the controller's next message. So an Attempt that looks idle here (`preparing`
 * or `ready`) may already be running the user's job. Stopping its executor first loses that job,
 * and GitHub then refuses to delete the Runner (JobStillRunningException) until the job ends.
 *
 * `retireAttempt` therefore only records the intent. The Attempt keeps its state, its slot and its
 * place in the Worker's live set, so the Agent leaves the executor alone. `runnerCleanupPending` is
 * set with it, so the controller, including one built before retirement existed, finds the Runner
 * in `listRunnerCleanups` and deletes it. Then:
 *
 * - GitHub confirms the delete: `completeRunnerCleanup` calls `finishRetirement`, which ends the
 *   Attempt. It leaves the live set and the Agent stops the executor. No job can reach a deleted
 *   Runner, so nothing is lost.
 * - GitHub answers that the Runner is busy: the controller leaves it and retries later. The
 *   JobStarted that follows calls `keepForJob`, and the job runs to its JobCompleted.
 *
 * A `pending` Attempt has no Runner online (its Agent has not claimed the JIT config), so it is
 * cancelled at once by `cancelUnclaimedAttempt`; a claim that races it finds the Attempt gone.
 */
export type RetirementOutcome = "cancelled" | "failed";

/** The states in which an Attempt's Runner may be registered and online with GitHub. */
export function runnerMayBeOnline(state: Doc<"attempts">["state"]) {
  return state === "preparing" || state === "ready" || state === "running";
}

export function isRetiring(attempt: Doc<"attempts">) {
  return attempt.retirement !== undefined && runnerMayBeOnline(attempt.state);
}

/**
 * Asks the controller to delete the Attempt's Runner and ends the Attempt only once it has.
 * Idempotent: a second request keeps the first reason and time. Returns whether this call started
 * the retirement.
 */
export async function retireAttempt(
  ctx: MutationCtx,
  attempt: Doc<"attempts">,
  outcome: RetirementOutcome,
  reason: string,
) {
  if (!runnerMayBeOnline(attempt.state)) {
    throw new Error(`retireAttempt on a ${attempt.state} Attempt`);
  }
  if (attempt.retirement !== undefined) return false;
  await deleteAttemptSecret(ctx, attempt._id);
  await ctx.db.patch(attempt._id, {
    jitConfig: undefined,
    runnerCleanupPending: true,
    retirement: { outcome, reason: reason.slice(0, 500), requestedAt: Date.now() },
  });
  return true;
}

/**
 * How long a retirement may wait for a controller to confirm the delete before Convex ends the
 * Attempt anyway. A listening controller confirms the delete, or sees the job start, within one
 * message, about a minute. This only fires when no controller serves the Profile (it was retired,
 * or every controller is down), and keeps a Worker's slot from being held for good. The Runner
 * stays in `listRunnerCleanups` for whichever controller comes back.
 */
export const RETIREMENT_UNCONFIRMED_MS = 6 * 60 * 60_000;

/**
 * Ends a retiring Attempt as its retirement asked. The Agent sees it leave the live set and stops
 * the executor. Called when GitHub has deleted the Runner (`completeRunnerCleanup`), or by the
 * reconciler when no controller confirmed the delete within RETIREMENT_UNCONFIRMED_MS, in which
 * case the Runner is still owed a delete.
 */
export async function finishRetirement(
  ctx: MutationCtx,
  attempt: Doc<"attempts">,
  { unconfirmed = false }: { unconfirmed?: boolean } = {},
) {
  const retirement = attempt.retirement;
  if (retirement === undefined) throw new Error("finishRetirement on an Attempt not retiring");
  const reason = unconfirmed
    ? `${retirement.reason} (no controller confirmed the Runner was deleted within ` +
      `${RETIREMENT_UNCONFIRMED_MS / 3_600_000} hours)`
    : retirement.reason;
  await releaseAttemptSlot(ctx, attempt);
  await deleteAttemptSecret(ctx, attempt._id);
  await ctx.db.patch(attempt._id, {
    state: retirement.outcome,
    jitConfig: undefined,
    finishedAt: Date.now(),
    runnerCleanupPending: unconfirmed ? true : undefined,
    retirement: undefined,
    ...(retirement.outcome === "cancelled"
      ? { cancelReason: reason.slice(0, 500) }
      : { lastError: reason.slice(0, 500) }),
  });
}

/**
 * Ends an Attempt whose Agent has not claimed it: frees its slot, drops its JIT config, and marks
 * its GitHub Runner for the controller to delete. The registration exists, but nothing runs it, so
 * GitHub cannot have handed it a job.
 */
export async function cancelUnclaimedAttempt(
  ctx: MutationCtx,
  attempt: Doc<"attempts">,
  reason: string,
) {
  if (attempt.state !== "pending") {
    throw new Error(`cancelUnclaimedAttempt on a ${attempt.state} Attempt`);
  }
  await releaseAttemptSlot(ctx, attempt);
  await deleteAttemptSecret(ctx, attempt._id);
  await ctx.db.patch(attempt._id, {
    state: "cancelled",
    jitConfig: undefined,
    cancelReason: reason.slice(0, 500),
    finishedAt: Date.now(),
    runnerCleanupPending: true,
  });
}

/**
 * Ends an Attempt that has no job yet, as a scale-down or a pin retirement does: an unclaimed one
 * at once, a `preparing` or `ready` one once GitHub has deleted its Runner. Never call it on a
 * running Attempt: that one has a job.
 */
export async function endIdleAttempt(ctx: MutationCtx, attempt: Doc<"attempts">, reason: string) {
  if (attempt.state === "pending") {
    await cancelUnclaimedAttempt(ctx, attempt, reason);
    return "cancelled" as const;
  }
  await retireAttempt(ctx, attempt, "cancelled", reason);
  return "retiring" as const;
}

/**
 * GitHub handed a retiring Runner a job before the controller could delete it. The job wins: the
 * Attempt stays, its Runner is no longer to be deleted, and JobCompleted settles it as any other.
 * Returns the fields to patch alongside the move to `running`.
 */
export function keepForJob(attempt: Doc<"attempts">) {
  if (attempt.retirement === undefined) return {};
  console.info(
    `Runner ${attempt.runnerName} of ${attempt.profile} took a job while retiring; it keeps it. ` +
      `Retirement was: ${attempt.retirement.reason}`,
  );
  return { retirement: undefined, runnerCleanupPending: undefined };
}
