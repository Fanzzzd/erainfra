import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";

// A JIT runner registration exists on GitHub the moment generate-jitconfig
// returns, whether or not a runner ever consumes it. Every path that throws a
// command away therefore has to hand the registration back, or the repository
// slowly fills with offline "rc-*" runners that hide the real fleet state.

export async function enqueueRunnerDeletion(
  ctx: MutationCtx,
  command: Pick<Doc<"commands">, "runnerId" | "runnerName">,
  job: Pick<Doc<"jobs">, "repo" | "githubInstallationId"> | null,
) {
  if (command.runnerId === undefined || job === null) {
    return false;
  }
  await ctx.db.insert("runnerDeletions", {
    repo: job.repo,
    githubInstallationId: job.githubInstallationId,
    runnerId: command.runnerId,
    runnerName: command.runnerName,
    createdAt: Date.now(),
    attempts: 0,
  });
  return true;
}

/** Delete a command and hand its runner registration back to GitHub. */
export async function discardCommand(
  ctx: MutationCtx,
  command: Doc<"commands">,
  job: Pick<Doc<"jobs">, "repo" | "githubInstallationId"> | null,
) {
  await enqueueRunnerDeletion(ctx, command, job);
  await ctx.db.delete(command._id);
}

// Called by the drain action when generate-jitconfig succeeded but the command
// it belonged to had already been thrown away.
export const enqueue = internalMutation({
  args: {
    repo: v.string(),
    githubInstallationId: v.optional(v.number()),
    runnerId: v.number(),
    runnerName: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("runnerDeletions", {
      repo: args.repo,
      githubInstallationId: args.githubInstallationId,
      runnerId: args.runnerId,
      runnerName: args.runnerName,
      createdAt: Date.now(),
      attempts: 0,
    });
    return null;
  },
});

export const MAX_DELETION_ATTEMPTS = 5;

export const claimDeletions = internalMutation({
  args: { limit: v.number() },
  returns: v.array(
    v.object({
      _id: v.id("runnerDeletions"),
      repo: v.string(),
      githubInstallationId: v.optional(v.number()),
      runnerId: v.number(),
      runnerName: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const pending = await ctx.db
      .query("runnerDeletions")
      .withIndex("by_createdAt")
      .order("asc")
      .take(args.limit);
    return pending.map((deletion) => ({
      _id: deletion._id,
      repo: deletion.repo,
      githubInstallationId: deletion.githubInstallationId,
      runnerId: deletion.runnerId,
      runnerName: deletion.runnerName,
    }));
  },
});

export const settleDeletion = internalMutation({
  args: {
    deletionId: v.id("runnerDeletions"),
    ok: v.boolean(),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const deletion = await ctx.db.get(args.deletionId);
    if (deletion === null) {
      return null;
    }
    if (args.ok) {
      await ctx.db.delete(deletion._id);
      return null;
    }
    const attempts = deletion.attempts + 1;
    if (attempts >= MAX_DELETION_ATTEMPTS) {
      console.error(
        `Giving up deleting runner ${deletion.runnerName} in ${deletion.repo}: ${args.error ?? "unknown error"}`,
      );
      await ctx.db.delete(deletion._id);
      return null;
    }
    await ctx.db.patch(deletion._id, { attempts, lastError: args.error });
    return null;
  },
});
