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
const DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60_000;

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
    const [assignedJobs, runningJobs, queuedJobs, machines, commands] = await Promise.all([
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
    ]);

    const machinesById = new Map(machines.map((machine) => [machine._id, machine]));
    const machineSlots = new Map(machines.map((machine) => [machine._id, machine.usedSlots]));
    const activeJobsByMachine = new Map<string, number>();
    const commandsByJob = new Map<string, typeof commands>();

    for (const job of [...assignedJobs, ...runningJobs]) {
      if (job.machineId === undefined) continue;
      activeJobsByMachine.set(job.machineId, (activeJobsByMachine.get(job.machineId) ?? 0) + 1);
    }
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
        activeJobsByMachine.set(
          machine._id,
          Math.max(0, (activeJobsByMachine.get(machine._id) ?? 0) - 1),
        );
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
        activeJobsByMachine.set(
          machine._id,
          Math.max(0, (activeJobsByMachine.get(machine._id) ?? 0) - 1),
        );
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

    let slotsRepaired = 0;
    for (const machine of machines) {
      const expectedSlots = activeJobsByMachine.get(machine._id) ?? 0;
      const currentSlots = machineSlots.get(machine._id) ?? machine.usedSlots;
      if (currentSlots === expectedSlots) continue;

      await ctx.db.patch(machine._id, { usedSlots: expectedSlots });
      machineSlots.set(machine._id, expectedSlots);
      slotsRepaired += 1;
    }

    const deliveries = await ctx.runMutation(internal.webhooks.retryStalledDeliveries, { now });

    if (requeued > 0) {
      await ctx.scheduler.runAfter(0, internal.scheduler.tryAssign, {});
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
