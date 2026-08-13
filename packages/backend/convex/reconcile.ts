import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { deleteAttemptSecret } from "./attemptSecrets";
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
const ACTIVE_ATTEMPT_STATES = ["pending", "preparing", "ready", "running"] as const;
const ACTIVE_EXPERIMENT_STATES = ["queued", "preparing", "running"] as const;
const ACTIVE_COMMAND_STATES = ["pending", "claimed", "cancelled"] as const;

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

    const [
      assignedJobs,
      runningJobs,
      queuedJobs,
      commandRanges,
      finishedCommands,
      attemptRanges,
      experimentRanges,
    ] = await Promise.all([
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
      Promise.all(
        ACTIVE_COMMAND_STATES.map((status) =>
          ctx.db
            .query("commands")
            .withIndex("by_status", (query) => query.eq("status", status))
            .collect(),
        ),
      ),
      ctx.db
        .query("commands")
        .withIndex("by_status", (query) => query.eq("status", "finished"))
        .take(200),
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

    const commands = commandRanges.flat();
    const attempts = attemptRanges.flat();
    const experiments = experimentRanges.flat();
    const referencedMachineIds = new Set(
      [...assignedJobs, ...runningJobs, ...queuedJobs, ...attempts, ...experiments].flatMap(
        (row) => (row.machineId === undefined ? [] : [row.machineId]),
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
    const commandsByJob = new Map<string, typeof commands>();

    for (const command of finishedCommands) {
      await ctx.db.delete(command._id);
    }
    for (const command of commands) {
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
          await deleteAttemptSecret(ctx, attempt._id);
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
        await deleteAttemptSecret(ctx, attempt._id);
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
    const [expiredRegistrations, usedRegistrations] = await Promise.all([
      ctx.db
        .query("registrationTokens")
        .withIndex("by_createdAt", (query) =>
          query.lte("createdAt", now - REGISTRATION_TOKEN_RETENTION_MS),
        )
        .collect(),
      ctx.db
        .query("registrationTokens")
        .withIndex("by_usedAt", (query) => query.gt("usedAt", 0))
        .collect(),
    ]);
    for (const registrationId of new Set(
      [...expiredRegistrations, ...usedRegistrations].map((registration) => registration._id),
    )) {
      await ctx.db.delete(registrationId);
    }
    for (const status of ["processed", "rejected", "failed"] as const) {
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
    for (const recoveryState of ["recovered", "abandoned"] as const) {
      const settled = await ctx.db
        .query("webhookRecovery")
        .withIndex("by_state_lastRequestedAt", (q) =>
          q.eq("state", recoveryState).lte("lastRequestedAt", now - RECOVERY_RETENTION_MS),
        )
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
        .withIndex("by_status_queuedAt", (q) =>
          q.eq("status", status).lte("queuedAt", now - FINISHED_JOB_RETENTION_MS),
        )
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
    const [currentJobRanges, currentAttemptRanges, currentExperimentRanges] = await Promise.all([
      Promise.all(
        (["assigned", "running"] as const).map((status) =>
          ctx.db
            .query("jobs")
            .withIndex("by_status", (query) => query.eq("status", status))
            .collect(),
        ),
      ),
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
    const currentJobs = currentJobRanges.flat();
    const currentAttempts = currentAttemptRanges.flat();
    const currentExperiments = currentExperimentRanges.flat();
    const expectedByMachine = new Map<string, number>();
    function count(machineId: string | undefined) {
      if (machineId === undefined) return;
      expectedByMachine.set(machineId, (expectedByMachine.get(machineId) ?? 0) + 1);
    }
    for (const job of currentJobs) count(job.machineId);
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
