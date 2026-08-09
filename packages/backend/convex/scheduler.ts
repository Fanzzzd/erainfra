import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { selectImageForMachine } from "./catalog";
import { decideAttemptOutcome, summarizeError } from "./retry";
import { discardCommand } from "./runners";

export const tryAssign = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx): Promise<number> => {
    const now = Date.now();
    const [queuedJobs, machineDocs] = await Promise.all([
      ctx.db
        .query("jobs")
        .withIndex("by_status", (q) => q.eq("status", "queued"))
        .collect(),
      ctx.db.query("machines").collect(),
    ]);

    const eligibleJobs = queuedJobs
      // A job that just failed to provision waits out its backoff.
      .filter((job) => (job.nextAttemptAt ?? 0) <= now)
      .toSorted((a, b) => a.queuedAt - b.queuedAt);
    const machines = machineDocs.map((machine) => ({
      doc: machine,
      usedSlots: machine.usedSlots,
    }));
    let assigned = 0;

    for (const job of eligibleJobs) {
      let candidate: (typeof machines)[number] | undefined;
      let catalogEntry: ReturnType<typeof selectImageForMachine>;
      // Prefer a machine other than the one that just failed this job, and only
      // fall back to it when nothing else can serve the labels.
      let fallback: (typeof machines)[number] | undefined;
      let fallbackEntry: ReturnType<typeof selectImageForMachine>;

      for (const machine of machines) {
        if (machine.usedSlots >= machine.doc.maxSlots || now - machine.doc.lastSeen >= 120_000) {
          continue;
        }
        const entry = selectImageForMachine(job.labels, machine.doc);
        if (entry === undefined) {
          continue;
        }
        if (job.lastFailedMachineId === machine.doc._id) {
          fallback ??= machine;
          fallbackEntry ??= entry;
          continue;
        }
        candidate = machine;
        catalogEntry = entry;
        break;
      }
      if (candidate === undefined) {
        candidate = fallback;
        catalogEntry = fallbackEntry;
      }
      if (candidate === undefined || catalogEntry === undefined) {
        continue;
      }

      // Unique per attempt: a retry of the same job must not collide with a
      // stale offline registration left by a previous dead runner.
      const attempts = (job.attempts ?? 0) + 1;
      const runnerName = `rc-${candidate.doc.name}-${job.ghJobId}-${attempts}`;
      candidate.usedSlots += 1;
      await ctx.db.patch(candidate.doc._id, {
        usedSlots: candidate.usedSlots,
      });
      await ctx.db.patch(job._id, {
        status: "assigned",
        machineId: candidate.doc._id,
        runnerName,
        attempts,
        nextAttemptAt: undefined,
      });
      const commandId = await ctx.db.insert("commands", {
        machineId: candidate.doc._id,
        jobId: job._id,
        image: catalogEntry.image,
        runnerName,
        status: "pending",
      });
      await ctx.scheduler.runAfter(0, internal.github.issueJit, {
        commandId,
        jobId: job._id,
        repo: job.repo,
        githubInstallationId: job.githubInstallationId,
        runnerName,
        labels: job.labels,
      });
      assigned += 1;
    }

    return assigned;
  },
});

export const storeJitConfig = internalMutation({
  args: {
    commandId: v.id("commands"),
    jitConfig: v.string(),
    runnerId: v.optional(v.number()),
  },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const command = await ctx.db.get(args.commandId);
    if (command === null || command.status !== "pending") {
      // The command was cancelled or reconciled away while GitHub was minting
      // the config. The caller hands the registration back.
      return false;
    }
    await ctx.db.patch(command._id, {
      jitConfig: args.jitConfig,
      runnerId: args.runnerId,
    });
    return true;
  },
});

/**
 * Record a failed provisioning attempt for an assigned job.
 *
 * Frees the slot, hands any JIT registration back to GitHub, and either
 * reschedules the job behind a growing backoff or gives up with an
 * operator-readable reason. Without the cap a host that can never provision
 * (no Docker, missing image, a GitHub permission error) would bounce the job
 * forever and mint a throwaway runner registration every time.
 */
export const failAttempt = internalMutation({
  args: {
    commandId: v.optional(v.id("commands")),
    jobId: v.id("jobs"),
    error: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const command = args.commandId === undefined ? null : await ctx.db.get(args.commandId);
    // A JIT action captures its original job id before GitHub can assign the
    // label-matched runner to a different queued job. Reconciliation may move
    // the command while that action is still in flight, so the command's live
    // ownership wins over the stale action argument.
    const job = command === null ? await ctx.db.get(args.jobId) : await ctx.db.get(command.jobId);
    const now = Date.now();

    if (command !== null) {
      await discardCommand(ctx, command, job);
    }
    if (job === null || job.status !== "assigned") {
      return null;
    }

    const machineId = job.machineId ?? command?.machineId;
    if (machineId !== undefined) {
      const machine = await ctx.db.get(machineId);
      if (machine !== null) {
        await ctx.db.patch(machine._id, {
          usedSlots: Math.max(0, machine.usedSlots - 1),
        });
      }
    }

    const outcome = decideAttemptOutcome(job.attempts ?? 1, now, args.error);
    if (outcome.kind === "exhausted") {
      console.error(
        `Job ${job.ghJobId} (${job.repo}) failed after ${outcome.attempts} attempts: ${outcome.lastError}`,
      );
      await ctx.db.patch(job._id, {
        status: "failed",
        conclusion: "provision-failed",
        finishedAt: now,
        lastError: outcome.lastError,
        machineId: undefined,
        runnerName: undefined,
        nextAttemptAt: undefined,
      });
      return null;
    }

    await ctx.db.patch(job._id, {
      status: "queued",
      machineId: undefined,
      runnerName: undefined,
      lastError: outcome.lastError,
      nextAttemptAt: outcome.nextAttemptAt,
      lastFailedMachineId: machineId,
    });
    await ctx.scheduler.runAfter(
      Math.max(0, outcome.nextAttemptAt - now),
      internal.scheduler.tryAssign,
      {},
    );
    return null;
  },
});

/** Surface a failure that is not tied to a specific attempt (e.g. a rejected delivery). */
export const recordJobError = internalMutation({
  args: { jobId: v.id("jobs"), error: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (job === null) {
      return null;
    }
    await ctx.db.patch(job._id, { lastError: summarizeError(args.error) });
    return null;
  },
});
