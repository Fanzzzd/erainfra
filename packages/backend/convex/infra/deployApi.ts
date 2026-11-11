// What the operator API's deployment routes (infra/deployHttp.ts) run. Internal: the HTTP layer
// authenticates the API token and its scope, and passes the token's name as the audit actor.
import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type QueryCtx } from "../_generated/server";
import { appendAudit } from "./auditLog";
import { createRun, MAX_UPLOAD_BYTES } from "./pipeline";

const APP = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SERVICE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,255}$/;

/** An upload URL for one source tarball. Convex expires it after an hour. */
export const createUpload = internalMutation({
  args: { actor: v.string() },
  returns: v.object({ uploadUrl: v.string() }),
  handler: async (ctx, args) => {
    const uploadUrl = await ctx.storage.generateUploadUrl();
    await appendAudit(ctx, {
      actor: args.actor,
      action: "apps.deploy.upload",
      outcome: "success",
    });
    return { uploadUrl };
  },
});

async function nodeNamed(ctx: QueryCtx, name: string | undefined) {
  if (name === undefined) return undefined;
  const row = await ctx.db
    .query("nodes")
    .withIndex("by_name", (q) => q.eq("name", name))
    .unique();
  if (row === null) throw new ConvexError(`No Node named "${name}"`);
  return row._id;
}

/**
 * Queue a deploy of an uploaded tarball or a repository branch. Refusals are audited too, so the
 * audit log shows every mutating request an admin token made.
 */
export const start = internalMutation({
  args: {
    actor: v.string(),
    app: v.string(),
    upload: v.optional(v.string()),
    repo: v.optional(v.string()),
    branch: v.optional(v.string()),
    sha: v.optional(v.string()),
    port: v.optional(v.number()),
    buildNode: v.optional(v.string()),
    node: v.optional(v.string()),
    adopt: v.optional(v.array(v.string())),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), deploymentId: v.id("appDeployments") }),
    v.object({ ok: v.literal(false), error: v.string() }),
  ),
  handler: async (ctx, args) => {
    const refuse = async (error: string) => {
      await appendAudit(ctx, {
        actor: args.actor,
        action: "apps.deploy.request",
        target: args.app,
        outcome: "deny",
        meta: { error },
      });
      return { ok: false as const, error };
    };
    if (!APP.test(args.app)) return await refuse("app must be lowercase alphanumeric + dashes");
    if ((args.upload === undefined) === (args.repo === undefined))
      return await refuse("send exactly one of upload or repo");
    if (
      args.port !== undefined &&
      (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535)
    )
      return await refuse("port must be an integer from 1 to 65535");
    let source: NonNullable<Doc<"appDeployments">["source"]>;
    if (args.upload !== undefined) {
      const storageId = ctx.db.system.normalizeId("_storage", args.upload);
      const file = storageId === null ? null : await ctx.db.system.get(storageId);
      if (storageId === null || file === null) return await refuse("no such upload");
      if (file.size === 0 || file.size > MAX_UPLOAD_BYTES)
        return await refuse(`an upload must be 1 byte to ${MAX_UPLOAD_BYTES} bytes`);
      source = { kind: "upload", storageId };
    } else {
      if (!REPO.test(args.repo!)) return await refuse("repo must be owner/name");
      const branch = args.branch ?? "main";
      if (!BRANCH.test(branch) || branch.includes("..")) return await refuse("invalid branch");
      if (args.sha !== undefined && !/^[0-9a-f]{40}$/.test(args.sha))
        return await refuse("sha must be a full 40-character commit id");
      source = {
        kind: "git",
        repo: args.repo!,
        ref: branch,
        ...(args.sha === undefined ? {} : { sha: args.sha }),
      };
    }
    const adopt = args.adopt ?? [];
    if (adopt.length > 32) return await refuse("adopt names at most 32 containers");
    for (const name of adopt) {
      if (!name.startsWith(`${args.app}-`) || !SERVICE.test(name.slice(args.app.length + 1)))
        return await refuse(`adopt ${name}: name a container of this App, <app>-<service>`);
    }
    if (new Set(adopt).size !== adopt.length) return await refuse("adopt names a container twice");
    let buildNodeId: Id<"nodes"> | undefined;
    let defaultNodeId: Id<"nodes"> | undefined;
    try {
      buildNodeId = await nodeNamed(ctx, args.buildNode);
      defaultNodeId = await nodeNamed(ctx, args.node);
    } catch (e) {
      return await refuse(e instanceof ConvexError ? String(e.data) : "unknown Node");
    }
    const deploymentId = await createRun(ctx, {
      app: args.app,
      operation: "deploy",
      trigger: {
        kind: source.kind === "upload" ? "upload" : "manual",
        actor: args.actor,
        ...(source.kind === "git" && source.sha ? { sha: source.sha } : {}),
      },
      source,
      ...(buildNodeId === undefined ? {} : { buildNodeId }),
      ...(defaultNodeId === undefined ? {} : { defaultNodeId }),
      ...(args.port === undefined ? {} : { port: args.port }),
      ...(adopt.length === 0 ? {} : { adopt }),
    });
    await appendAudit(ctx, {
      actor: args.actor,
      action: "apps.deploy.request",
      target: args.app,
      outcome: "attempt",
      // An adoption replaces a container no ownership check vouched for: the log names it.
      meta: { deploymentId, source: source.kind, ...(adopt.length === 0 ? {} : { adopt }) },
    });
    return { ok: true as const, deploymentId };
  },
});

const iso = (ms: number | undefined) => (ms === undefined ? null : new Date(ms).toISOString());

async function view(ctx: QueryCtx, row: Doc<"appDeployments">) {
  const name = async (id: Id<"nodes"> | undefined) =>
    id === undefined ? null : ((await ctx.db.get(id))?.name ?? null);
  return {
    id: row._id,
    app: row.app,
    operation: row.operation ?? null,
    stage: row.stage,
    detail: row.detail,
    error: row.error ?? null,
    urls: row.urls,
    trigger: row.trigger?.kind ?? null,
    sha: row.trigger?.sha ?? (row.source?.kind === "git" ? (row.source.sha ?? null) : null),
    source:
      row.source === undefined
        ? null
        : row.source.kind === "upload"
          ? { kind: "upload" as const }
          : { kind: "git" as const, repo: row.source.repo, branch: row.source.ref },
    buildNode: await name(row.buildNodeId),
    nodes: await Promise.all(row.targetNodeIds.map((id) => name(id))),
    startedAt: iso(row.startedAt)!,
    finishedAt: iso(row.finishedAt),
  };
}

export const get = internalQuery({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("appDeployments", args.id);
    const row = id === null ? null : await ctx.db.get(id);
    return row === null ? null : await view(ctx, row);
  },
});

export const list = internalQuery({
  args: { app: v.optional(v.string()), limit: v.number() },
  handler: async (ctx, args) => {
    const rows =
      args.app === undefined
        ? await ctx.db
            .query("appDeployments")
            .withIndex("by_startedAt")
            .order("desc")
            .take(args.limit)
        : await ctx.db
            .query("appDeployments")
            .withIndex("by_app_startedAt", (q) => q.eq("app", args.app!))
            .order("desc")
            .take(args.limit);
    return await Promise.all(rows.map((row) => view(ctx, row)));
  },
});
