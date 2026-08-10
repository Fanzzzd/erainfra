import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { decideAttemptOutcome } from "./retry";
import { discardCommand, enqueueRunnerDeletion } from "./runners";

const AGENT_OFFLINE_MS = 120_000;
// Measured from the moment the agent claimed the command, not from when it was
// created: a cold `docker pull` or a first `tart clone` legitimately takes many
// minutes, and tearing that down mid-flight provisions a second runner for a
// job that is already starting.
const ASSIGNMENT_STUCK_MS = 45 * 60_000;
const RUNNING_ABANDONED_MS = 10 * 60_000;
const QUEUE_EXPIRED_MS = 24 * 60 * 60_000;
const REGISTRATION_TOKEN_RETENTION_MS = 60 * 60_000;
const FINISHED_JOB_RETENTION_MS = 30 * 24 * 60 * 60_000;
// Must stay strictly greater than recovery.RECOVERY_WINDOW_MS — asserted in
// tests/recovery.test.ts. These rows are what tells the recovery scan a
// delivery already arrived. If one expired while GitHub could still list its
// delivery, the scan would read that absence as a loss, ask for a redelivery,
// and re-apply a stale `queued` event for a job that finished days ago.
export const DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60_000;
// Settled recovery rows are diagnostics, kept on the same clock as the
// deliveries they describe.
const RECOVERY_RETENTION_MS = DELIVERY_RETENTION_MS;

export const run = internalMutation({
  args: {},
  returns: v.object({
    requeued: v.number(),
    abandoned: v.number(),
    expired: v.number(),
    slotsRepaired: v.number(),
    deliveriesRetried: v.number(),
  }),
  handler: async (
    ctx,
  ): Promise<{
    requeued: number;
    abandoned: number;
    expired: number;
    slotsRepaired: number;
    deliveriesRetried: number;
  }> => {
    const now = Date.now();

    // ponytail: full-table scans, fine for <100 machines
    const [assignedJobs, runningJobs, queuedJobs, machines, commands, attempts, experiments] =
      await Promise.all([
        ctx.db
          .query("jobs")
          .withIndex("by_status", (q) => q.eq("status", "assigned"))
          .collect(),
        ctx.db
          .query("jobs")
          .withIndex("by_status", (q) => q.eq("status", "running"))
          .collect(),
        ctx.db
          .query("jobs")
          .withIndex("by_status", (q) => q.eq("status", "queued"))
          .collect(),
        ctx.db.query("machines").collect(),
        ctx.db.query("commands").collect(),
        ctx.db.query("attempts").collect(),
        ctx.db.query("experiments").collect(),
      ]);

    const machinesById = new Map(machines.map((machine) => [machine._id, machine]));
    const machineSlots = new Map(machines.map((machine) => [machine._id, machine.usedSlots]));
    const commandsByJob = new Map<string, typeof commands>();

    for (const command of commands) {
      // Retention: nothing reads finished commands, so drop them here.
      if (command.status === "finished") {
        await ctx.db.delete(command._id);
        continue;
      }
      const jobCommands = commandsByJob.get(command.jobId) ?? [];
      jobCommands.push(command);
      commandsByJob.set(command.jobId, jobCommands);
    }

    let requeued = 0;
    let abandoned = 0;
    let expired = 0;

    for (const job of assignedJobs) {
      const machine = job.machineId === undefined ? undefined : machinesById.get(job.machineId);
      const agentOffline = machine === undefined || now - machine.lastSeen > AGENT_OFFLINE_MS;
      const currentCommands = (commandsByJob.get(job._id) ?? []).filter(
        (command) => command.runnerName === job.runnerName && command.machineId === job.machineId,
      );
      const startedAt = currentCommands.reduce(
        (latest, command) => Math.max(latest, command.claimedAt ?? command._creationTime),
        0,
      );
      const assignmentStuck = startedAt > 0 && now - startedAt > ASSIGNMENT_STUCK_MS;

      if (!agentOffline && !assignmentStuck) continue;

      for (const command of commandsByJob.get(job._id) ?? []) {
        await discardCommand(ctx, command, job);
      }
      if (machine !== undefined) {
        const usedSlots = Math.max(0, (machineSlots.get(machine._id) ?? machine.usedSlots) - 1);
        machineSlots.set(machine._id, usedSlots);
        await ctx.db.patch(machine._id, { usedSlots });
      }

      // Same bounded-retry path as a provisioner failure: an agent that never
      // comes back must not keep the job cycling forever.
      const reason = agentOffline
        ? `Agent for ${machine?.name ?? "the assigned machine"} stopped reporting`
        : `Provisioning did not start within ${Math.round(ASSIGNMENT_STUCK_MS / 60_000)} minutes`;
      const outcome = decideAttemptOutcome(job.attempts ?? 1, now, reason);
      if (outcome.kind === "exhausted") {
        await ctx.db.patch(job._id, {
          status: "failed",
          conclusion: "provision-failed",
          finishedAt: now,
          lastError: outcome.lastError,
          machineId: undefined,
          runnerName: undefined,
          nextAttemptAt: undefined,
        });
      } else {
        await ctx.db.patch(job._id, {
          status: "queued",
          machineId: undefined,
          runnerName: undefined,
          lastError: outcome.lastError,
          nextAttemptAt: outcome.nextAttemptAt,
          lastFailedMachineId: job.machineId,
        });
        requeued += 1;
      }
    }

    for (const job of runningJobs) {
      const machine = job.machineId === undefined ? undefined : machinesById.get(job.machineId);
      const agentAbandoned = machine === undefined || now - machine.lastSeen > RUNNING_ABANDONED_MS;

      if (!agentAbandoned) continue;

      await ctx.db.patch(job._id, {
        status: "failed",
        conclusion: "abandoned",
        finishedAt: now,
      });
      for (const command of commandsByJob.get(job._id) ?? []) {
        if (command.status !== "finished") {
          await ctx.db.patch(command._id, { status: "finished" });
        }
        // The host vanished mid-job, so its runner cannot deregister itself.
        await enqueueRunnerDeletion(ctx, command, job);
      }
      if (machine !== undefined) {
        const usedSlots = Math.max(0, (machineSlots.get(machine._id) ?? machine.usedSlots) - 1);
        machineSlots.set(machine._id, usedSlots);
        await ctx.db.patch(machine._id, { usedSlots });
      }
      abandoned += 1;
    }

    for (const job of queuedJobs) {
      if (now - job.queuedAt <= QUEUE_EXPIRED_MS) continue;

      await ctx.db.patch(job._id, {
        status: "failed",
        conclusion: "expired",
        finishedAt: now,
        nextAttemptAt: undefined,
      });
      expired += 1;
    }

    for (const attempt of attempts) {
      if (
        attempt.state === "completed" ||
        attempt.state === "cancelled" ||
        attempt.state === "failed"
      ) {
        continue;
      }
      if (attempt.machineId === undefined) {
        if (now - attempt.createdAt > QUEUE_EXPIRED_MS) {
          await ctx.db.patch(attempt._id, {
            state: "cancelled",
            jitConfig: undefined,
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
      if (attempt.state === "pending" && offlineFor > AGENT_OFFLINE_MS) {
        await ctx.db.patch(attempt._id, { machineId: undefined });
        requeued += 1;
        continue;
      }
      const stuckPreparing =
        (attempt.state === "preparing" || attempt.state === "ready") &&
        now - (attempt.claimedAt ?? attempt.createdAt) > ASSIGNMENT_STUCK_MS;
      const abandonedRunning = attempt.state === "running" && offlineFor > RUNNING_ABANDONED_MS;
      if (
        ((attempt.state === "preparing" || attempt.state === "ready") &&
          offlineFor > AGENT_OFFLINE_MS) ||
        stuckPreparing ||
        abandonedRunning
      ) {
        await ctx.db.patch(attempt._id, {
          state: "failed",
          jitConfig: undefined,
          finishedAt: now,
          runnerCleanupPending: true,
          lastError: abandonedRunning
            ? "Worker stopped reporting during the GitHub job"
            : stuckPreparing
              ? "Executor did not become usable within 45 minutes"
              : "Worker stopped reporting while preparing the runner",
        });
        abandoned += 1;
      }
    }

    for (const experiment of experiments) {
      if (
        experiment.state === "completed" ||
        experiment.state === "cancelled" ||
        experiment.state === "failed"
      ) {
        continue;
      }
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
      if (experiment.state === "queued" && offlineFor > AGENT_OFFLINE_MS) {
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
        (experiment.state === "preparing" && offlineFor > AGENT_OFFLINE_MS) ||
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
    // month-old finished jobs.
    for (const registration of await ctx.db.query("registrationTokens").collect()) {
      if (
        registration.usedAt !== undefined ||
        now - registration.createdAt >= REGISTRATION_TOKEN_RETENTION_MS
      ) {
        await ctx.db.delete(registration._id);
      }
    }
    for (const status of ["processed", "rejected", "failed"] as const) {
      const settled = await ctx.db
        .query("webhookDeliveries")
        .withIndex("by_status", (q) => q.eq("status", status))
        .order("asc")
        .take(200);
      for (const delivery of settled) {
        if (now - (delivery.settledAt ?? delivery.receivedAt) >= DELIVERY_RETENTION_MS) {
          await ctx.db.delete(delivery._id);
        }
      }
    }
    for (const recoveryState of ["recovered", "abandoned"] as const) {
      const settled = await ctx.db
        .query("webhookRecovery")
        .withIndex("by_state", (q) => q.eq("state", recoveryState))
        .order("asc")
        .take(200);
      for (const row of settled) {
        if (now - row.lastRequestedAt >= RECOVERY_RETENTION_MS) {
          await ctx.db.delete(row._id);
        }
      }
    }
    for (const status of ["done", "failed"] as const) {
      const finishedJobs = await ctx.db
        .query("jobs")
        .withIndex("by_status", (q) => q.eq("status", status))
        .order("asc")
        .take(100);
      for (const job of finishedJobs) {
        if (now - (job.finishedAt ?? job._creationTime) >= FINISHED_JOB_RETENTION_MS) {
          await ctx.db.delete(job._id);
        }
      }
    }

    // Recompute from durable active work after recovery. The old implementation
    // counted only legacy Jobs and silently reset scale-set/Experiment slots to
    // zero every minute.
    const [currentJobs, currentAttempts, currentExperiments] = await Promise.all([
      ctx.db.query("jobs").collect(),
      ctx.db.query("attempts").collect(),
      ctx.db.query("experiments").collect(),
    ]);
    const expectedByMachine = new Map<string, number>();
    function count(machineId: string | undefined) {
      if (machineId === undefined) return;
      expectedByMachine.set(machineId, (expectedByMachine.get(machineId) ?? 0) + 1);
    }
    for (const job of currentJobs) {
      if (job.status === "assigned" || job.status === "running") count(job.machineId);
    }
    for (const attempt of currentAttempts) {
      if (
        attempt.state === "pending" ||
        attempt.state === "preparing" ||
        attempt.state === "ready" ||
        attempt.state === "running"
      ) {
        count(attempt.machineId);
      }
    }
    for (const experiment of currentExperiments) {
      if (
        experiment.state === "queued" ||
        experiment.state === "preparing" ||
        experiment.state === "running"
      ) {
        count(experiment.machineId);
      }
    }

    let slotsRepaired = 0;
    for (const machine of machines) {
      const expectedSlots = expectedByMachine.get(machine._id) ?? 0;
      const currentSlots = machineSlots.get(machine._id) ?? machine.usedSlots;
      if (currentSlots === expectedSlots) continue;

      await ctx.db.patch(machine._id, { usedSlots: expectedSlots });
      machineSlots.set(machine._id, expectedSlots);
      slotsRepaired += 1;
    }

    const deliveries = await ctx.runMutation(internal.webhooks.retryStalledDeliveries, { now });

    if (requeued > 0 || abandoned > 0 || expired > 0 || slotsRepaired > 0) {
      await ctx.scheduler.runAfter(0, internal.scheduler.tryAssign, {});
      await ctx.scheduler.runAfter(0, internal.attemptScheduler.tryAssign, {});
    }
    const orphanedRunners = await ctx.db.query("runnerDeletions").take(1);
    if (orphanedRunners.length > 0) {
      await ctx.scheduler.runAfter(0, internal.github.drainRunnerDeletions, {});
    }

    return {
      requeued,
      abandoned,
      expired,
      slotsRepaired,
      deliveriesRetried: deliveries.retried,
    };
  },
});
