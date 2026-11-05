// Push-to-deploy bindings (the Hub's `git_bindings`) and the push webhook intake.
//
// The Hub checked "(repo, branch) is unbound" and "fewer than 200 bindings" in code, then wrote,
// so two concurrent binds could both pass. Here both checks and the insert are one transaction.
//
// The Hub also deployed once per webhook request, so a GitHub redelivery deployed again. The
// intake here records every delivery by X-GitHub-Delivery in the same `webhookDeliveries` table
// the CI intake uses (webhooks.ts) and queues at most one run per delivery.
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { requirePermission } from "./access";
import { appendAudit } from "./auditLog";
import { createRun } from "./pipeline";
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

// ---------------------------------------------------------------------------
// Bind, unbind and list. One body each, run by the dashboard functions below and by the operator
// API (operatorGit.ts), so the two callers cannot disagree about a rule.

const APP_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Why `branch` cannot be bound, or null. The push intake matches the branch GitHub reports after
 * `refs/heads/` (githubDeploy.ts parsePush). A full ref, or a name git refuses
 * (git-check-ref-format), never matches a push, so binding it would deploy nothing and say nothing.
 */
export function branchProblem(branch: string) {
  if (branch.length === 0) return "Name a branch";
  if (branch.length > 255) return "A branch name is at most 255 characters";
  if (branch.startsWith("refs/")) return "Name the branch without refs/heads/";
  if (
    [...branch].some((ch) => ch.charCodeAt(0) <= 0x20 || ch.charCodeAt(0) === 0x7f) ||
    /[~^:?*[\\]/.test(branch) ||
    branch.includes("..") ||
    branch.includes("@{") ||
    branch.includes("//") ||
    branch.startsWith("/") ||
    branch.startsWith("-") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.endsWith(".lock") ||
    branch === "@"
  ) {
    return `${JSON.stringify(branch)} is not a branch name git accepts`;
  }
  return null;
}

/**
 * Bind (repo, branch) to an App and audit it as `git.bind`, in one transaction. Everything is
 * checked before the first write, so a caller that catches the refusal (operatorGit.ts) commits
 * only its own audit row.
 */
export async function bindBranch(
  ctx: MutationCtx,
  input: {
    repo: string;
    branch: string;
    app: string;
    buildNodeId?: Id<"nodes">;
    deployNodeId?: Id<"nodes">;
    port?: number;
    actor: string;
  },
) {
  const { actor, ...binding } = input;
  const problem = branchProblem(binding.branch);
  if (problem !== null) throw new ConvexError(problem);
  if (!APP_NAME.test(binding.app)) {
    throw new ConvexError("An App name is lowercase letters, digits and dashes, at most 63");
  }
  if (
    binding.port !== undefined &&
    (!Number.isInteger(binding.port) || binding.port < 1 || binding.port > 65535)
  ) {
    throw new ConvexError("port must be an integer from 1 to 65535");
  }
  const nodes = { buildNode: null as string | null, deployNode: null as string | null };
  for (const [key, id] of [
    ["buildNode", binding.buildNodeId],
    ["deployNode", binding.deployNodeId],
  ] as const) {
    if (id === undefined) continue;
    const node = await ctx.db.get(id);
    if (node === null) throw new ConvexError(`No Node with id ${id}`);
    nodes[key] = node.name;
  }
  const id = await insertBinding(ctx, binding);
  await appendAudit(ctx, {
    actor,
    action: "git.bind",
    target: `${binding.repo}@${binding.branch}`,
    outcome: "success",
    meta: { app: binding.app, ...nodes, port: binding.port ?? null },
  });
  return id;
}

/** Delete a binding and audit it as `git.unbind`. Pushes to the branch then deploy nothing. */
export async function unbindBranch(ctx: MutationCtx, binding: Doc<"gitBindings">, actor: string) {
  await ctx.db.delete(binding._id);
  await appendAudit(ctx, {
    actor,
    action: "git.unbind",
    target: `${binding.repo}@${binding.branch}`,
    outcome: "success",
    meta: { app: binding.app },
  });
}

/** Every binding, its Nodes by name, ordered by repository then branch. */
export async function listBindings(ctx: QueryCtx) {
  // At most MAX_GIT_BINDINGS rows exist (insertBinding), so this reads them all.
  return await bindingViews(ctx, await ctx.db.query("gitBindings").take(MAX_GIT_BINDINGS));
}

/** Bindings as callers see them: Nodes by name as well as by id, no internal keys. */
export async function bindingViews(ctx: QueryCtx, rows: Doc<"gitBindings">[]) {
  const names = new Map<Id<"nodes">, string | null>();
  const nodeName = async (id: Id<"nodes"> | undefined) => {
    if (id === undefined) return null;
    if (!names.has(id)) names.set(id, (await ctx.db.get(id))?.name ?? null);
    return names.get(id) ?? null;
  };
  const views = [];
  for (const row of rows) {
    views.push({
      _id: row._id,
      repo: row.repo,
      branch: row.branch,
      app: row.app,
      buildNodeId: row.buildNodeId,
      deployNodeId: row.deployNodeId,
      buildNode: await nodeName(row.buildNodeId),
      deployNode: await nodeName(row.deployNodeId),
      port: row.port,
      createdAt: row.createdAt,
      lastStatus: row.lastStatus ?? null,
    });
  }
  return views.toSorted(
    (a, b) =>
      repoKey(a.repo).localeCompare(repoKey(b.repo)) ||
      (a.branch < b.branch ? -1 : a.branch > b.branch ? 1 : 0),
  );
}

export type BindingView = Awaited<ReturnType<typeof bindingViews>>[number];

// ---------------------------------------------------------------------------
// Dashboard: signed-in people, through the permission table.

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
    return await bindBranch(ctx, { ...args, actor });
  },
});

export const unbind = mutation({
  args: { bindingId: v.id("gitBindings") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const { actor } = await requirePermission(ctx, "app.deploy");
    const binding = await ctx.db.get(args.bindingId);
    if (binding === null) return false;
    await unbindBranch(ctx, binding, actor);
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
      buildNode: v.union(v.string(), v.null()),
      deployNode: v.union(v.string(), v.null()),
      port: v.optional(v.number()),
      createdAt: v.number(),
      lastStatus: v.union(
        v.object({
          at: v.number(),
          sha: v.string(),
          ok: v.boolean(),
          stage: v.string(),
          error: v.optional(v.string()),
        }),
        v.null(),
      ),
    }),
  ),
  handler: async (ctx) => {
    await requirePermission(ctx, "app.read");
    return await listBindings(ctx);
  },
});

/**
 * Record a verified push delivery and queue its deploy. Keyed by X-GitHub-Delivery: a redelivery
 * returns `duplicate` and queues nothing. Called by the /github/webhook route after it verified the
 * signature (http.ts).
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

    // The run and the delivery row commit together, so one delivery starts at most one run even
    // when GitHub redelivers it or two copies arrive at once.
    const deploymentId = await createRun(ctx, {
      app: binding.app,
      operation: "deploy",
      trigger: { kind: "git", sha: args.sha, deliveryId: args.deliveryId, actor: "github:push" },
      source: {
        kind: "git",
        repo: binding.repo,
        ref: args.branch,
        ...(/^[0-9a-f]{40}$/.test(args.sha) ? { sha: args.sha } : {}),
      },
      ...(binding.buildNodeId === undefined ? {} : { buildNodeId: binding.buildNodeId }),
      ...(binding.deployNodeId === undefined ? {} : { defaultNodeId: binding.deployNodeId }),
      ...(binding.port === undefined ? {} : { port: binding.port }),
      gitBindingId: binding._id,
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
