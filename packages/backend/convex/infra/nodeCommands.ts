import { ConvexError, v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, mutation, type QueryCtx } from "../_generated/server";
import { requirePermission } from "./access";
import { appendAudit } from "./auditLog";
import { assertAppLease } from "./leases";
import { requireNode } from "./nodes";
import { COMMAND_TTL_MS, commandOutcome, nodeCommand, validateOperation } from "./nodeCommandModel";
import { secretsForNodeDeploy } from "./secrets";
import { validateDockerArgs } from "./dockerArgs";

function keyOK(key: string) {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key))
    throw new ConvexError("Invalid idempotency key/claim owner");
}
async function appFence(ctx: QueryCtx, row: Doc<"nodeCommands">) {
  if (row.app !== undefined && row.appEpoch !== undefined) {
    const lease = await assertAppLease(ctx, row.app, row.appEpoch, Date.now());
    if (row.command.kind === "deploy" && lease.operation !== (row.command.operation ?? "deploy"))
      throw new ConvexError("App lease operation does not match command");
  }
}
async function deploymentSpec(
  ctx: QueryCtx,
  deploymentId: Id<"appDeployments">,
  nodeId: Id<"nodes">,
  operation: "deploy" | "failover" = "deploy",
) {
  const dep = await ctx.db.get(deploymentId);
  if (
    !dep ||
    !dep.targetNodeIds.includes(nodeId) ||
    dep.leaseEpoch === undefined ||
    dep.stage === "done" ||
    dep.stage === "failed"
  ) {
    throw new ConvexError("Deployment is not active on this Node");
  }
  const lease = await assertAppLease(ctx, dep.app, dep.leaseEpoch, Date.now());
  if (lease.operation !== operation)
    throw new ConvexError("App lease operation does not match command");
  const app = await ctx.db
    .query("apps")
    .withIndex("by_name", (q) => q.eq("name", dep.app))
    .unique();
  if (!app) throw new ConvexError("A stored App specification is required");
  const services = app.services.filter((s) => (s.nodeId ?? app.nodeId) === nodeId);
  if (!services.length || services.length > 32)
    throw new ConvexError("Invalid service placement/count");
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(app.name)) throw new ConvexError("Invalid App name");
  for (const s of services) {
    if (
      !/^[a-z0-9][a-z0-9-]{0,62}$/.test(s.name) ||
      !/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,511}$/.test(s.image) ||
      validateDockerArgs(s.args) !== null
    ) {
      throw new ConvexError("Invalid deployment specification");
    }
    if (
      Object.entries(s.env ?? {}).some(
        ([k, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || value.length > 8192,
      )
    )
      throw new ConvexError("Invalid plain environment");
  }
  if (new TextEncoder().encode(JSON.stringify(services)).length > 64 * 1024)
    throw new ConvexError("App specification too large");
  return { dep, app, services };
}

// The only public enqueue path: a human permission check, durable audit, and (for deployment)
// a live App lease checked in this same transaction. No unchecked internal enqueue endpoint.
export const enqueue = mutation({
  args: { nodeId: v.id("nodes"), idempotencyKey: v.string(), command: nodeCommand },
  returns: v.id("nodeCommands"),
  handler: async (ctx, args) => {
    const { actor } = await requirePermission(
      ctx,
      args.command.kind === "operate" ? "node.run" : "app.deploy",
    );
    keyOK(args.idempotencyKey);
    if (!(await ctx.db.get(args.nodeId))) throw new ConvexError("No such Node");
    const prior = await ctx.db
      .query("nodeCommands")
      .withIndex("by_node_key", (q) =>
        q.eq("nodeId", args.nodeId).eq("idempotencyKey", args.idempotencyKey),
      )
      .unique();
    if (prior) {
      if (JSON.stringify(prior.command) !== JSON.stringify(args.command))
        throw new ConvexError("Idempotency key reused for different command");
      return prior._id;
    }
    let app: string | undefined;
    let appEpoch: number | undefined;
    if (args.command.kind === "operate") validateOperation(args.command.operation);
    else {
      const spec = await deploymentSpec(
        ctx,
        args.command.deploymentId,
        args.nodeId,
        args.command.operation,
      );
      app = spec.dep.app;
      appEpoch = spec.dep.leaseEpoch;
    }
    const queued = await ctx.db
      .query("nodeCommands")
      .withIndex("by_node_status", (q) => q.eq("nodeId", args.nodeId).eq("status", "pending"))
      .take(201);
    if (queued.length >= 200) throw new ConvexError("Node command queue is full");
    const id = await ctx.db.insert("nodeCommands", {
      ...args,
      app,
      appEpoch,
      createdAt: Date.now(),
      status: "pending",
      unsettled: true,
      epoch: 0,
    });
    await appendAudit(ctx, {
      actor,
      action: "nodes.enqueue",
      target: id,
      outcome: "attempt",
      meta: { kind: args.command.kind, nodeId: args.nodeId },
    });
    return id;
  },
});
export const cancel = mutation({
  args: { commandId: v.id("nodeCommands") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.commandId);
    if (!row) throw new ConvexError("No such command");
    const { actor } = await requirePermission(
      ctx,
      row.command.kind === "operate" ? "node.run" : "app.deploy",
    );
    if (row.status === "running" || row.status === "pending") {
      await ctx.db.patch(row._id, {
        status: "cancelled",
        unsettled: false,
        finishedAt: Date.now(),
      });
      await appendAudit(ctx, {
        actor,
        action: "nodes.cancel",
        target: row._id,
        outcome: "success",
      });
    }
    return null;
  },
});

export async function ownCommand(ctx: QueryCtx, credential: string, commandId: Id<"nodeCommands">) {
  const { nodeId } = await requireNode(ctx, credential);
  const row = await ctx.db.get(commandId);
  if (!row || row.nodeId !== nodeId) throw new ConvexError("Command not found on this Node");
  return row;
}
async function claimed(ctx: QueryCtx, args: ClaimArgs) {
  const row = await ownCommand(ctx, args.credential, args.commandId);
  if (
    row.status !== "running" ||
    row.owner !== args.owner ||
    row.epoch !== args.epoch ||
    (row.leaseUntil ?? 0) <= Date.now()
  )
    throw new ConvexError("Stale command claim");
  await appFence(ctx, row);
  return row;
}
export const claimFields = {
  credential: v.string(),
  commandId: v.id("nodeCommands"),
  owner: v.string(),
  epoch: v.number(),
};
type ClaimArgs = {
  credential: string;
  commandId: Id<"nodeCommands">;
  owner: string;
  epoch: number;
};
export const claim = internalMutation({
  args: { credential: v.string(), commandId: v.id("nodeCommands"), owner: v.string() },
  handler: async (ctx, args) => {
    keyOK(args.owner);
    const row = await ownCommand(ctx, args.credential, args.commandId);
    await appFence(ctx, row);
    if (row.status !== "pending" && row.status !== "running")
      throw new ConvexError("Command is terminal");
    if (row.status === "running" && (row.leaseUntil ?? 0) > Date.now()) {
      if (row.owner !== args.owner) throw new ConvexError("Command is already claimed");
      return { epoch: row.epoch, leaseUntil: row.leaseUntil! };
    }
    // Serialize execution for the entire Node, a stricter bound than one command per App.
    const active = await ctx.db
      .query("nodeCommands")
      .withIndex("by_node_status", (q) => q.eq("nodeId", row.nodeId).eq("status", "running"))
      .take(201);
    if (
      active.length > 200 ||
      active.some((r) => r._id !== row._id && (r.leaseUntil ?? 0) > Date.now())
    )
      throw new ConvexError("Node has another active command");
    const epoch = row.epoch + 1;
    const leaseUntil = Date.now() + COMMAND_TTL_MS;
    await ctx.db.patch(row._id, { status: "running", owner: args.owner, epoch, leaseUntil });
    return { epoch, leaseUntil };
  },
});
export const renew = internalMutation({
  args: claimFields,
  handler: async (ctx, args) => {
    const row = await claimed(ctx, args);
    const leaseUntil = Date.now() + COMMAND_TTL_MS;
    await ctx.db.patch(row._id, { leaseUntil });
    return { leaseUntil };
  },
});
export const report = internalMutation({
  args: { ...claimFields, outcome: commandOutcome },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Permit retry of the exact terminal report, but never a stale epoch or another owner.
    const row = await ownCommand(ctx, args.credential, args.commandId);
    if (row.status === args.outcome && row.owner === args.owner && row.epoch === args.epoch)
      return null;
    await claimed(ctx, args);
    await ctx.db.patch(row._id, {
      status: args.outcome,
      unsettled: false,
      outcome: args.outcome,
      finishedAt: Date.now(),
    });
    await appendAudit(ctx, {
      actor: `node:${row.nodeId}`,
      action: "nodes.result",
      target: row._id,
      outcome: args.outcome === "success" ? "success" : "failure",
      meta: { outcome: args.outcome, epoch: args.epoch },
    });
    return null;
  },
});
export const payload = internalQuery({
  args: claimFields,
  handler: async (ctx, args) => {
    const row = await claimed(ctx, args);
    if (row.command.kind === "operate")
      return { kind: "operate" as const, operation: row.command.operation };
    const spec = await deploymentSpec(
      ctx,
      row.command.deploymentId,
      row.nodeId,
      row.command.operation,
    );
    const scopes = await secretsForNodeDeploy(ctx, {
      nodeId: row.nodeId,
      deploymentId: row.command.deploymentId,
      now: Date.now(),
    });
    const services = spec.services.map((s) => {
      const env = { ...s.env, ...scopes[spec.app.name], ...scopes[`${spec.app.name}-${s.name}`] };
      if (s.env?.PORT) env.PORT = s.env.PORT;
      if (
        Object.values(env).some(
          (value) => value.includes("\r") || value.includes("\n") || value.includes("\0"),
        )
      )
        throw new ConvexError(
          "Multiline environment values are not supported by env-file deployment",
        );
      return {
        name: s.name,
        image: s.image,
        args: s.args,
        port: s.port ?? 0,
        route: s.route ?? "",
        env,
      };
    });
    const result = { kind: "deploy" as const, app: spec.app.name, services };
    if (new TextEncoder().encode(JSON.stringify(result)).length > 200 * 1024)
      throw new ConvexError("Deployment payload too large");
    return result;
  },
});
export type NodeCommand = Infer<typeof nodeCommand>;
