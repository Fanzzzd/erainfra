// Push-to-deploy bindings (the Hub's `git_bindings`) and the push webhook intake.
//
// The Hub checked "(repo, branch) is unbound" and "fewer than 200 bindings" in code, then wrote,
// so two concurrent binds could both pass. Here both checks and the insert are one transaction.
//
// The Hub also deployed once per webhook request, so a GitHub redelivery deployed again. The
// intake here records every delivery by X-GitHub-Delivery in the same `webhookDeliveries` table
// the CI intake uses (webhooks.ts) and queues at most one run per delivery.
import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { requirePermission } from "./access";
import { appendAudit } from "./auditLog";
import { createDeployment } from "./deployments";
import { MAX_GIT_BINDINGS, repoKey } from "./policy";

export async function findBinding(ctx: QueryCtx, repo: string, branch: string) {
  return await ctx.db
    .query("gitBindings")
    .withIndex("by_repoKey_branch", (q) => q.eq("repoKey", repoKey(repo)).eq("branch", branch))
    .unique();
}

export async function insertBinding(
  ctx: MutationCtx,
  input: {
    repo: string;
    branch: string;
    app: string;
    buildNodeId?: Id<"nodes">;
    deployNodeId?: Id<"nodes">;
    port?: number;
    createdAt?: number;
    legacyId?: string;
    lastStatus?: { at: number; sha: string; ok: boolean; stage: string; error?: string };
  },
) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(input.repo))
    throw new ConvexError("Name the repository as owner/name");
  if (input.branch.length === 0) throw new ConvexError("Name a branch");
  if ((await findBinding(ctx, input.repo, input.branch)) !== null) {
    throw new ConvexError(`Already bound: ${input.repo}@${input.branch}`);
  }
  // At most MAX_GIT_BINDINGS rows, so reading one past the cap is a bounded read.
  const bound = await ctx.db.query("gitBindings").take(MAX_GIT_BINDINGS);
  if (bound.length >= MAX_GIT_BINDINGS) {
    throw new ConvexError(`Binding limit reached (${MAX_GIT_BINDINGS})`);
  }
  return await ctx.db.insert("gitBindings", {
    ...input,
    repoKey: repoKey(input.repo),
    createdAt: input.createdAt ?? Date.now(),
  });
}

export const bind = mutation({
  args: {
    repo: v.string(),
    branch: v.string(),
    app: v.string(),
    buildNodeId: v.optional(v.id("nodes")),
    deployNodeId: v.optional(v.id("nodes")),
    port: v.optional(v.number()),
  },
  returns: v.id("gitBindings"),
  handler: async (ctx, args) => {
    const { actor } = await requirePermission(ctx, "app.deploy");
    const id = await insertBinding(ctx, args);
    await appendAudit(ctx, {
      actor,
      action: "git.bind",
      target: `${args.repo}@${args.branch}`,
      outcome: "success",
    });
    return id;
  },
});

export const unbind = mutation({
  args: { bindingId: v.id("gitBindings") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const { actor } = await requirePermission(ctx, "app.deploy");
    const binding = await ctx.db.get(args.bindingId);
    if (binding === null) return false;
    await ctx.db.delete(binding._id);
    await appendAudit(ctx, {
      actor,
      action: "git.unbind",
      target: `${binding.repo}@${binding.branch}`,
      outcome: "success",
    });
    return true;
  },
});

export const list = query({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("gitBindings"),
      repo: v.string(),
      branch: v.string(),
      app: v.string(),
      buildNodeId: v.optional(v.id("nodes")),
      deployNodeId: v.optional(v.id("nodes")),
      port: v.optional(v.number()),
    }),
  ),
  handler: async (ctx) => {
    await requirePermission(ctx, "app.read");
    const rows = await ctx.db.query("gitBindings").take(MAX_GIT_BINDINGS);
    return rows.map(({ _id, repo, branch, app, buildNodeId, deployNodeId, port }) => ({
      _id,
      repo,
      branch,
      app,
      buildNodeId,
      deployNodeId,
      port,
    }));
  },
});

/**
 * Record a verified push delivery and queue its deploy. Keyed by X-GitHub-Delivery: a redelivery
 * returns `duplicate` and queues nothing. The HTTP route that verifies the signature and calls
 * this arrives with the deploy pipeline in phase 3; the dedup is in place before it.
 */
export const acceptPush = internalMutation({
  args: {
    deliveryId: v.string(),
    repo: v.string(),
    branch: v.string(),
    sha: v.string(),
  },
  returns: v.union(
    v.object({ outcome: v.literal("duplicate") }),
    v.object({ outcome: v.literal("no-binding") }),
    v.object({ outcome: v.literal("queued"), deploymentId: v.id("appDeployments") }),
  ),
  handler: async (ctx, args) => {
    const seen = await ctx.db
      .query("webhookDeliveries")
      .withIndex("by_deliveryId", (q) => q.eq("deliveryId", args.deliveryId))
      .unique();
    if (seen !== null) return { outcome: "duplicate" as const };

    const now = Date.now();
    const binding = await findBinding(ctx, args.repo, args.branch);
    const push = { repo: args.repo, branch: args.branch, sha: args.sha };
    if (binding === null) {
      await ctx.db.insert("webhookDeliveries", {
        deliveryId: args.deliveryId,
        event: "push",
        receivedAt: now,
        status: "processed",
        attempts: 1,
        settledAt: now,
        push: { ...push, outcome: "no-binding" },
      });
      return { outcome: "no-binding" as const };
    }

    const deploymentId = await createDeployment(ctx, {
      app: binding.app,
      targetNodeIds: binding.deployNodeId === undefined ? [] : [binding.deployNodeId],
      trigger: { kind: "git", sha: args.sha, deliveryId: args.deliveryId },
    });
    await ctx.db.insert("webhookDeliveries", {
      deliveryId: args.deliveryId,
      event: "push",
      receivedAt: now,
      status: "processed",
      attempts: 1,
      settledAt: now,
      push: { ...push, outcome: "queued", deploymentId },
    });
    await appendAudit(ctx, {
      actor: "github:push",
      action: "git.deploy",
      target: `${binding.repo}@${binding.branch}`,
      outcome: "attempt",
      meta: { sha: args.sha, deliveryId: args.deliveryId, deploymentId },
    });
    return { outcome: "queued" as const, deploymentId };
  },
});
