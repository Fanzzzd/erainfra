import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import {
  finishRetirement,
  keepForReturningWorker,
  retireAttempt,
  retirementBackstopDue,
  workerReports,
} from "./attemptRetirement";
import { deleteAttemptSecret } from "./attemptSecrets";
import { deleteAttemptEgress } from "./egress";
import { WORKER_OFFLINE_AFTER_MS } from "./workerPolicy";

// Measured from the moment the Worker claimed the Attempt, not from when it was
// created: a cold `docker pull` or a first `tart clone` legitimately takes many
// minutes, and tearing that down mid-flight provisions a second runner for a
// job that is already starting.
const ASSIGNMENT_STUCK_MS = 45 * 60_000;
const RUNNING_ABANDONED_MS = 10 * 60_000;
const QUEUE_EXPIRED_MS = 24 * 60 * 60_000;
const REGISTRATION_TOKEN_RETENTION_MS = 60 * 60_000;
// The dashboard shows only the newest 200 Attempts and 100 Experiments. Keep
// terminal work for a 30-day diagnostic window, then delete it in bounded
// batches; pending runner-cleanup tombstones are retained until their
// controller acknowledges them.
export const TERMINAL_WORK_RETENTION_MS = 30 * 24 * 60 * 60_000;
// A push delivery row is what makes a GitHub redelivery of it a duplicate
// (infra/git.ts). GitHub redelivers for up to three days.
export const DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60_000;
const ACTIVE_ATTEMPT_STATES = ["pending", "preparing", "ready", "running"] as const;
const ACTIVE_EXPERIMENT_STATES = ["queued", "preparing", "running"] as const;
const TERMINAL_ATTEMPT_STATES = ["completed", "cancelled", "failed"] as const;
const TERMINAL_EXPERIMENT_STATES = ["completed", "cancelled", "failed"] as const;

export const run = internalMutation({
  args: {},
  returns: v.object({
    requeued: v.number(),
    abandoned: v.number(),
    expired: v.number(),
    slotsRepaired: v.number(),
  }),
  handler: async (
    ctx,
  ): Promise<{
    requeued: number;
    abandoned: number;
    expired: number;
    slotsRepaired: number;
  }> => {
    const now = Date.now();

    const [attemptRanges, experimentRanges] = await Promise.all([
      Promise.all(
        ACTIVE_ATTEMPT_STATES.map((state) =>
          ctx.db
            .query("attempts")
            .withIndex("by_state", (query) => query.eq("state", state))
            .collect(),
        ),
      ),
      Promise.all(
        ACTIVE_EXPERIMENT_STATES.map((state) =>
          ctx.db
            .query("experiments")
            .withIndex("by_state", (query) => query.eq("state", state))
            .collect(),
        ),
      ),
    ]);

    const attempts = attemptRanges.flat();
    const experiments = experimentRanges.flat();
    const referencedMachineIds = new Set(
      [...attempts, ...experiments].flatMap((row) =>
        row.machineId === undefined ? [] : [row.machineId],
      ),
    );
    const [referencedMachines, machinesWithSlots] = await Promise.all([
      Promise.all([...referencedMachineIds].map((machineId) => ctx.db.get(machineId))),
      ctx.db
        .query("machines")
        .withIndex("by_usedSlots", (query) => query.gt("usedSlots", 0))
        .collect(),
    ]);
    const machinesById = new Map(
      [...referencedMachines.filter((machine) => machine !== null), ...machinesWithSlots].map(
        (machine) => [machine._id, machine],
      ),
    );
    const machines = [...machinesById.values()];

    const machineSlots = new Map(machines.map((machine) => [machine._id, machine.usedSlots]));

    let requeued = 0;
    let abandoned = 0;
    let expired = 0;

    for (const attempt of attempts) {
      if (attempt.machineId === undefined) {
        if (now - attempt.createdAt > QUEUE_EXPIRED_MS) {
          await deleteAttemptSecret(ctx, attempt._id);
          await ctx.db.patch(attempt._id, {
            state: "cancelled",
            cancelReason: "No compatible Worker became ready within 24 hours",
            finishedAt: now,
            runnerCleanupPending: true,
          });
          expired += 1;
        }
        continue;
      }
      const machine = machinesById.get(attempt.machineId);
      const offlineFor = machine === undefined ? Number.POSITIVE_INFINITY : now - machine.lastSeen;
      if (attempt.state === "pending" && offlineFor > WORKER_OFFLINE_AFTER_MS) {
        await ctx.db.patch(attempt._id, { machineId: undefined });
        requeued += 1;
        continue;
      }
      if (attempt.retirement !== undefined) {
        // Already waiting for its controller to delete the Runner (attemptRetirement.ts). A
        // running one whose Worker reports again was retired only for the silence: its job runs
        // on. The heartbeat calls that off first; this catches a report that raced the retirement.
        if (machine !== undefined && workerReports(machine, now)) {
          if (await keepForReturningWorker(ctx, attempt)) continue;
        }
        // Otherwise only a retirement nothing can settle any more is ended here, so the slot
        // comes back (retirementBackstopDue).
        if (await retirementBackstopDue(ctx, attempt, machine, now)) {
          await finishRetirement(ctx, attempt, { unconfirmed: true });
          if (machine !== undefined) {
            const current = await ctx.db.get(machine._id);
            if (current !== null) machineSlots.set(machine._id, current.usedSlots);
          }
          abandoned += 1;
        }
        continue;
      }
      const stuckPreparing =
        (attempt.state === "preparing" || attempt.state === "ready") &&
        now - (attempt.claimedAt ?? attempt.createdAt) > ASSIGNMENT_STUCK_MS;
      const abandonedRunning = attempt.state === "running" && offlineFor > RUNNING_ABANDONED_MS;
      if (
        ((attempt.state === "preparing" || attempt.state === "ready") &&
          offlineFor > WORKER_OFFLINE_AFTER_MS) ||
        stuckPreparing ||
        abandonedRunning
      ) {
        // Each of these may have a Runner online with a job: a Worker that stopped reporting may
        // only have lost its link to Convex, and an idle Runner may have taken a job whose
        // JobStarted is still on its way. So the Attempt is retired rather than failed: it fails
        // once GitHub has deleted the Runner, and a job GitHub reports keeps it alive until its
        // JobCompleted. The slot stays held until then.
        await retireAttempt(
          ctx,
          attempt,
          "failed",
          abandonedRunning
            ? "Worker stopped reporting during the GitHub job"
            : stuckPreparing
              ? "Executor did not become usable within 45 minutes"
              : "Worker stopped reporting while preparing the runner",
        );
        abandoned += 1;
      }
    }

    for (const experiment of experiments) {
      if (experiment.machineId === undefined) {
        if (now - experiment.createdAt > QUEUE_EXPIRED_MS) {
          await ctx.db.patch(experiment._id, {
            state: "failed",
            finishedAt: now,
            lastError: "No compatible Worker became ready within 24 hours",
          });
          expired += 1;
        }
        continue;
      }
      const machine = machinesById.get(experiment.machineId);
      const offlineFor = machine === undefined ? Number.POSITIVE_INFINITY : now - machine.lastSeen;
      if (experiment.state === "queued" && offlineFor > WORKER_OFFLINE_AFTER_MS) {
        await ctx.db.patch(experiment._id, { machineId: undefined });
        requeued += 1;
        continue;
      }
      const stuckPreparing =
        experiment.state === "preparing" &&
        now - (experiment.claimedAt ?? experiment.createdAt) > ASSIGNMENT_STUCK_MS;
      const exceededDeadline =
        experiment.state === "running" &&
        now - (experiment.startedAt ?? experiment.claimedAt ?? experiment.createdAt) >
          experiment.timeoutSeconds * 1_000 + 5 * 60_000;
      const abandonedRunning = experiment.state === "running" && offlineFor > RUNNING_ABANDONED_MS;
      if (
        (experiment.state === "preparing" && offlineFor > WORKER_OFFLINE_AFTER_MS) ||
        stuckPreparing ||
        exceededDeadline ||
        abandonedRunning
      ) {
        await ctx.db.patch(experiment._id, {
          state: "failed",
          finishedAt: now,
          lastError: exceededDeadline
            ? "Experiment exceeded its timeout without exiting"
            : abandonedRunning
              ? "Worker stopped reporting during the Experiment"
              : stuckPreparing
                ? "Experiment executor did not start within 45 minutes"
                : "Worker stopped reporting while preparing the Experiment",
        });
        abandoned += 1;
      }
    }

    // Retention: expired registration tokens, settled deliveries, and
    // month-old finished work.
    const [expiredRegistrations, usedRegistrations] = await Promise.all([
      ctx.db
        .query("registrationTokens")
        .withIndex("by_createdAt", (query) =>
          query.lte("createdAt", now - REGISTRATION_TOKEN_RETENTION_MS),
        )
        .take(200),
      ctx.db
        .query("registrationTokens")
        .withIndex("by_usedAt", (query) => query.gt("usedAt", 0))
        .take(200),
    ]);
    for (const registrationId of new Set(
      [...expiredRegistrations, ...usedRegistrations].map((registration) => registration._id),
    )) {
      await ctx.db.delete(registrationId);
    }
    // "pending" too: a workflow_job row left pending by the retired intake has nothing to retry it.
    for (const status of ["pending", "processed", "rejected", "failed"] as const) {
      const settled = await ctx.db
        .query("webhookDeliveries")
        .withIndex("by_status_receivedAt", (q) =>
          q.eq("status", status).lte("receivedAt", now - DELIVERY_RETENTION_MS),
        )
        .order("asc")
        .take(200);
      for (const delivery of settled) {
        if (now - (delivery.settledAt ?? delivery.receivedAt) >= DELIVERY_RETENTION_MS) {
          await ctx.db.delete(delivery._id);
        }
      }
    }
    for (const state of TERMINAL_ATTEMPT_STATES) {
      const [finished, legacyWithoutFinishedAt] = await Promise.all([
        ctx.db
          .query("attempts")
          .withIndex("by_state_cleanupPending_finishedAt", (query) =>
            query
              .eq("state", state)
              .eq("runnerCleanupPending", undefined)
              .gt("finishedAt", 0)
              .lte("finishedAt", now - TERMINAL_WORK_RETENTION_MS),
          )
          .order("asc")
          .take(100),
        ctx.db
          .query("attempts")
          .withIndex("by_state_cleanupPending_finishedAt", (query) =>
            query
              .eq("state", state)
              .eq("runnerCleanupPending", undefined)
              .eq("finishedAt", undefined),
          )
          .order("asc")
          .take(100),
      ]);
      const staleLegacy = legacyWithoutFinishedAt.filter(
        (attempt) => now - attempt.createdAt >= TERMINAL_WORK_RETENTION_MS,
      );
      for (const attempt of [...finished, ...staleLegacy]) {
        await deleteAttemptSecret(ctx, attempt._id);
        await deleteAttemptEgress(ctx, attempt._id);
        await ctx.db.delete(attempt._id);
      }
    }
    for (const state of TERMINAL_EXPERIMENT_STATES) {
      const [finished, legacyWithoutFinishedAt] = await Promise.all([
        ctx.db
          .query("experiments")
          .withIndex("by_state_finishedAt", (query) =>
            query
              .eq("state", state)
              .gt("finishedAt", 0)
              .lte("finishedAt", now - TERMINAL_WORK_RETENTION_MS),
          )
          .order("asc")
          .take(100),
        ctx.db
          .query("experiments")
          .withIndex("by_state_finishedAt", (query) =>
            query.eq("state", state).eq("finishedAt", undefined),
          )
          .order("asc")
          .take(100),
      ]);
      for (const experiment of [
        ...finished,
        ...legacyWithoutFinishedAt.filter(
          (row) => now - row.createdAt >= TERMINAL_WORK_RETENTION_MS,
        ),
      ]) {
        await ctx.db.delete(experiment._id);
      }
    }

    // Recompute from durable active work after recovery.
    const [currentAttemptRanges, currentExperimentRanges] = await Promise.all([
      Promise.all(
        ACTIVE_ATTEMPT_STATES.map((state) =>
          ctx.db
            .query("attempts")
            .withIndex("by_state", (query) => query.eq("state", state))
            .collect(),
        ),
      ),
      Promise.all(
        ACTIVE_EXPERIMENT_STATES.map((state) =>
          ctx.db
            .query("experiments")
            .withIndex("by_state", (query) => query.eq("state", state))
            .collect(),
        ),
      ),
    ]);
    const currentAttempts = currentAttemptRanges.flat();
    const currentExperiments = currentExperimentRanges.flat();
    const expectedByMachine = new Map<string, number>();
    function count(machineId: string | undefined) {
      if (machineId === undefined) return;
      expectedByMachine.set(machineId, (expectedByMachine.get(machineId) ?? 0) + 1);
    }
    for (const attempt of currentAttempts) count(attempt.machineId);
    for (const experiment of currentExperiments) count(experiment.machineId);

    let slotsRepaired = 0;
    for (const machine of machines) {
      const expectedSlots = expectedByMachine.get(machine._id) ?? 0;
      const currentSlots = machineSlots.get(machine._id) ?? machine.usedSlots;
      if (currentSlots === expectedSlots) continue;

      await ctx.db.patch(machine._id, { usedSlots: expectedSlots });
      machineSlots.set(machine._id, expectedSlots);
      slotsRepaired += 1;
    }

    if (requeued > 0 || abandoned > 0 || expired > 0 || slotsRepaired > 0) {
      await ctx.scheduler.runAfter(0, internal.attemptScheduler.tryAssign, {});
    }

    return { requeued, abandoned, expired, slotsRepaired };
  },
});
