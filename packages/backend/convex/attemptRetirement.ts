import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { releaseAttemptSlot } from "./attemptScheduler";
import { deleteAttemptSecret } from "./attemptSecrets";
import { controllerLiveness } from "./controllerLiveness";
import { WORKER_OFFLINE_AFTER_MS } from "./workerPolicy";

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
 *
 * Every retirement is called off when its reason goes away:
 *
 * - Scale-down (`cancelAttempt`), lost host label (`pinnedAttempts.ts`), and the reconciler's
 *   silent Worker or executor not usable within 45 minutes retire an idle (`preparing` or
 *   `ready`) Attempt. A JobStarted calls it off (`keepForJob`): GitHub gave the Runner a job.
 *   An idle Runner whose Worker reports again stays retiring. It has no job, its controller has
 *   already created a replacement, and ending it costs nothing.
 * - The reconciler retires a `running` Attempt for one reason only: its Worker went silent
 *   mid-job. The Worker's next report calls it off (`keepForReturningWorker`). Left retiring, the
 *   controller would keep counting it out of capacity and create one Runner too many, and its end
 *   would be left to the backstop.
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
    runnerCleanupPending: true,
    retirement: { outcome, reason: reason.slice(0, 500), requestedAt: Date.now() },
  });
  return true;
}

/**
 * How long a retirement waits to be settled before the reconciler may end the Attempt anyway
 * (`retirementBackstopDue` decides whether it does). A listening controller confirms an idle
 * Runner's delete within one message, about a minute. A busy Runner's delete succeeds only when
 * its job ends, which may take as long as the job's `timeout-minutes`. The backstop keeps a
 * Worker's slot from being held for good by an Attempt nothing can settle any more. The Runner
 * stays in `listRunnerCleanups` for whichever controller comes back.
 */
export const RETIREMENT_UNCONFIRMED_MS = 6 * 60 * 60_000;

/** Bounds the read of a Profile's controller reports; one row per controller host. */
const CONTROLLER_REPORT_LIMIT = 50;

/** The cutoff every scheduling and reconciliation decision uses for a Worker being online. */
export function workerReports(machine: Doc<"machines">, now: number) {
  return now - machine.lastSeen <= WORKER_OFFLINE_AFTER_MS;
}

/**
 * Whether the reconciler ends a retirement nobody settled within RETIREMENT_UNCONFIRMED_MS. Time
 * alone is not enough. A job may run for longer than that, and ending its Attempt drops it from
 * the Worker's live set, which makes the Agent stop the VM mid-job. So past the deadline the
 * Attempt ends only when nothing can still settle it:
 *
 * - No controller reports for its Profile: none within CONTROLLER_OFFLINE_AFTER_MS, or only a
 *   stop. A live one, listening or waiting for the lease, either deletes the Runner or relays the
 *   job's JobCompleted, and either settles the Attempt.
 * - It is not a `running` Attempt on a Worker that reports. That Worker settles it with
 *   `reportAttempt` when the job's executor exits. The reconciler calls off such an Attempt's
 *   retirement before it gets here (`keepForReturningWorker`); this check keeps the backstop safe
 *   without relying on that.
 *
 * A Profile with no heartbeat rows counts as unserved: a controller that predates the heartbeat
 * cannot be observed, and a Profile nobody serves must still get its slots back.
 */
export async function retirementBackstopDue(
  ctx: MutationCtx,
  attempt: Doc<"attempts">,
  machine: Doc<"machines"> | undefined,
  now: number,
) {
  if (attempt.retirement === undefined) return false;
  if (now - attempt.retirement.requestedAt <= RETIREMENT_UNCONFIRMED_MS) return false;
  if (attempt.state === "running" && machine !== undefined && workerReports(machine, now)) {
    return false;
  }
  const reports = await ctx.db
    .query("controllerHeartbeats")
    .withIndex("by_profile_hostname", (q) => q.eq("profile", attempt.profile))
    .take(CONTROLLER_REPORT_LIMIT);
  return controllerLiveness(reports, now).live === 0;
}

/**
 * Calls off the retirement of a running Attempt whose Worker reports again. The reconciler retired
 * it because the Worker went silent mid-job, and the Worker may only have lost its link to Convex
 * while the job ran on. The Attempt goes back to how it was: running, counted by its controller,
 * its Runner no longer to be deleted, settled by JobCompleted or by the Worker's `reportAttempt`.
 * Returns whether there was a retirement to call off.
 */
export async function keepForReturningWorker(ctx: MutationCtx, attempt: Doc<"attempts">) {
  if (attempt.state !== "running" || attempt.retirement === undefined) return false;
  console.info(
    `The Worker running Runner ${attempt.runnerName} of ${attempt.profile} reports again; its ` +
      `job keeps running. Retirement was: ${attempt.retirement.reason}`,
  );
  await ctx.db.patch(attempt._id, { retirement: undefined, runnerCleanupPending: undefined });
  return true;
}

/**
 * A Worker's first heartbeat after a silence: calls off the retirement of each of its running
 * Attempts (`keepForReturningWorker`). The heartbeat calls it only after a silence longer than
 * WORKER_OFFLINE_AFTER_MS, so a Worker reporting on time reads nothing extra.
 */
export async function keepRunningAttemptsOfReturningWorker(
  ctx: MutationCtx,
  machineId: Id<"machines">,
) {
  const running = await ctx.db
    .query("attempts")
    .withIndex("by_machine_state_finishedAt", (q) =>
      q.eq("machineId", machineId).eq("state", "running"),
    )
    .collect();
  let kept = 0;
  for (const attempt of running) {
    if (await keepForReturningWorker(ctx, attempt)) kept += 1;
  }
  return kept;
}

/**
 * Ends a retiring Attempt as its retirement asked. The Agent sees it leave the live set and stops
 * the executor. Called when GitHub has deleted the Runner (`completeRunnerCleanup`), or by the
 * reconciler once `retirementBackstopDue` says nothing else can settle it, in which case the
 * Runner is still owed a delete.
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
