import { ConvexError, v, type Infer } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  mutation,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { requirePermission } from "./access";
import { appendAudit } from "./auditLog";
import { assertAppLease } from "./leases";
import { recordLogOutput } from "./logOutput";
import { requireNode } from "./nodes";
import {
  COMMAND_TTL_MS,
  commandOutcome,
  commandStatus,
  nodeCommand,
  validateOperation,
} from "./nodeCommandModel";
import { secretsForNodeDeploy } from "./secrets";
import { validateDockerArgs } from "./dockerArgs";
import { canonicalJson } from "./plan";
import { MAX_SPEC_BYTES } from "./spec";

export type NodeCommand = Infer<typeof nodeCommand>;

// Long enough for a pipeline step key: deployment id, step, a 63-character service name, Node id.
function keyOK(key: string) {
  if (!/^[A-Za-z0-9._:-]{1,192}$/.test(key))
    throw new ConvexError("Invalid idempotency key/claim owner");
}
/** The lease operation a command must run under: failover deploys under failover, all else under deploy. */
function leaseOperation(command: NodeCommand) {
  return command.kind === "deploy" ? (command.operation ?? "deploy") : "deploy";
}
async function appFence(ctx: QueryCtx, row: Doc<"nodeCommands">) {
  if (row.app !== undefined && row.appEpoch !== undefined) {
    const lease = await assertAppLease(ctx, row.app, row.appEpoch, Date.now());
    if (row.command.kind !== "operate" && lease.operation !== leaseOperation(row.command))
      throw new ConvexError("App lease operation does not match command");
  }
}
/**
 * The run a command belongs to, while it is live. A deploy command must come from one of the run's
 * target Nodes, the only Nodes that may read its secrets; a spec or build command from its build
 * Node, which receives the source and never a secret.
 */
async function activeDeployment(
  ctx: QueryCtx,
  deploymentId: Id<"appDeployments">,
  nodeId: Id<"nodes">,
  operation: "deploy" | "failover",
  role: "deploy" | "build" = "deploy",
) {
  const dep = await ctx.db.get(deploymentId);
  if (
    !dep ||
    (role === "deploy" ? !dep.targetNodeIds.includes(nodeId) : dep.buildNodeId !== nodeId) ||
    dep.leaseEpoch === undefined ||
    dep.stage === "done" ||
    dep.stage === "failed"
  ) {
    throw new ConvexError("Deployment is not active on this Node");
  }
  const lease = await assertAppLease(ctx, dep.app, dep.leaseEpoch, Date.now());
  if (lease.operation !== operation)
    throw new ConvexError("App lease operation does not match command");
  return dep;
}
async function deploymentSpec(
  ctx: QueryCtx,
  deploymentId: Id<"appDeployments">,
  nodeId: Id<"nodes">,
  operation: "deploy" | "failover" = "deploy",
) {
  const dep = await activeDeployment(ctx, deploymentId, nodeId, operation);
  // A pipeline run deploys its own plan; the stored App is only rewritten once every Node is up.
  // A run without a plan (enqueued by hand) deploys the stored App specification.
  const stored = await ctx.db
    .query("apps")
    .withIndex("by_name", (q) => q.eq("name", dep.app))
    .unique();
  const app = dep.plan
    ? { name: dep.app, nodeId: dep.plan.nodeId, services: dep.plan.services }
    : stored;
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

/**
 * Insert a Node command, or return the one already queued under the same (Node, idempotency key).
 * Shared by the human enqueue and by the deploy pipeline. A key names one intended operation step;
 * reusing it for different work is refused, so a retried enqueue can never queue a second effect.
 */
export async function insertNodeCommand(
  ctx: MutationCtx,
  input: {
    nodeId: Id<"nodes">;
    idempotencyKey: string;
    command: NodeCommand;
    app?: string;
    appEpoch?: number;
    deploymentId?: Id<"appDeployments">;
  },
) {
  keyOK(input.idempotencyKey);
  const prior = await ctx.db
    .query("nodeCommands")
    .withIndex("by_node_key", (q) =>
      q.eq("nodeId", input.nodeId).eq("idempotencyKey", input.idempotencyKey),
    )
    .unique();
  if (prior) {
    if (canonicalJson(prior.command) !== canonicalJson(input.command))
      throw new ConvexError("Idempotency key reused for different command");
    return { id: prior._id, created: false };
  }
  const queued = await ctx.db
    .query("nodeCommands")
    .withIndex("by_node_status", (q) => q.eq("nodeId", input.nodeId).eq("status", "pending"))
    .take(201);
  if (queued.length >= 200) throw new ConvexError("Node command queue is full");
  const id = await ctx.db.insert("nodeCommands", {
    nodeId: input.nodeId,
    idempotencyKey: input.idempotencyKey,
    command: input.command,
    ...(input.app === undefined ? {} : { app: input.app }),
    ...(input.appEpoch === undefined ? {} : { appEpoch: input.appEpoch }),
    ...(input.deploymentId === undefined ? {} : { deploymentId: input.deploymentId }),
    createdAt: Date.now(),
    status: "pending",
    unsettled: true,
    epoch: 0,
  });
  return { id, created: true };
}

// The only public enqueue path: a human permission check, durable audit, and (for deployment)
// a live App lease checked in this same transaction. No unchecked internal enqueue endpoint.
export const enqueue = mutation({
  args: { nodeId: v.id("nodes"), idempotencyKey: v.string(), command: nodeCommand },
  returns: v.id("nodeCommands"),
  handler: async (ctx, args) => {
    if (args.command.kind === "spec" || args.command.kind === "build")
      throw new ConvexError("Spec and build commands are issued by the deploy pipeline only");
    // A logs command uploads output, which only a logTails row bound to its requester may hold.
    if (args.command.kind === "logs")
      throw new ConvexError("Ask for logs through /api/v1/logs, which binds them to the requester");
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
      if (canonicalJson(prior.command) !== canonicalJson(args.command))
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
    const { id } = await insertNodeCommand(ctx, { ...args, app, appEpoch });
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
      row.command.kind === "operate" || row.command.kind === "logs" ? "node.run" : "app.deploy",
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
      if (row.deploymentId !== undefined)
        await ctx.scheduler.runAfter(0, internal.infra.pipeline.tick, {
          deploymentId: row.deploymentId,
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
  args: {
    ...claimFields,
    outcome: commandOutcome,
    spec: v.optional(v.string()),
    output: v.optional(v.string()),
    truncated: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Permit retry of the exact terminal report, but never a stale epoch or another owner.
    const row = await ownCommand(ctx, args.credential, args.commandId);
    if (row.status === args.outcome && row.owner === args.owner && row.epoch === args.epoch)
      return null;
    await claimed(ctx, args);
    if (args.spec !== undefined) {
      // Only a spec command returns data, and only with a success outcome.
      if (row.command.kind !== "spec" || args.outcome !== "success")
        throw new ConvexError("Only a successful spec command reports a spec");
      if (new TextEncoder().encode(args.spec).length > MAX_SPEC_BYTES)
        throw new ConvexError("Spec file too large");
    }
    if (args.output !== undefined || args.truncated !== undefined) {
      // Only a log tail uploads output, and it goes to the requester's row, never to this one.
      if (row.command.kind !== "logs" || args.outcome !== "success")
        throw new ConvexError("Only a successful logs command reports output");
    }
    if (row.command.kind === "logs") {
      await recordLogOutput(ctx, row, {
        outcome: args.outcome,
        ...(args.output === undefined ? {} : { output: args.output }),
        ...(args.truncated === undefined ? {} : { truncated: args.truncated }),
      });
    }
    await ctx.db.patch(row._id, {
      status: args.outcome,
      unsettled: false,
      outcome: args.outcome,
      finishedAt: Date.now(),
      ...(args.spec === undefined ? {} : { specText: args.spec }),
    });
    await appendAudit(ctx, {
      actor: `node:${row.nodeId}`,
      action: "nodes.result",
      target: row._id,
      outcome: args.outcome === "success" ? "success" : "failure",
      meta: { outcome: args.outcome, epoch: args.epoch },
    });
    // The run moves on as soon as its step settles, not at the next pulse.
    if (row.deploymentId !== undefined)
      await ctx.scheduler.runAfter(0, internal.infra.pipeline.tick, {
        deploymentId: row.deploymentId,
      });
    return null;
  },
});

/** How many command ids one status request may name (the Go agent's sweepBatch). */
export const MAX_STATUS_IDS = 200;

/**
 * The status of commands this Node holds journal keys for. The Infra Agent forgets a key once
 * its command is terminal here with the outcome it recorded: `claim` refuses a terminal command,
 * and no path moves a terminal row back to pending or deletes it, so that command can never be
 * delivered again. A command of another Node, or an id that is not a command, reads `missing`,
 * so a Node learns nothing about commands it does not own. Statuses only: no command data.
 */
export const statuses = internalQuery({
  args: { credential: v.string(), commandIds: v.array(v.string()) },
  returns: v.object({
    commands: v.array(
      v.object({
        id: v.string(),
        status: v.union(commandStatus, v.literal("missing")),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const { nodeId } = await requireNode(ctx, args.credential);
    if (args.commandIds.length > MAX_STATUS_IDS) throw new ConvexError("Too many command ids");
    const commands = [];
    for (const raw of args.commandIds) {
      if (raw.length > 64) throw new ConvexError("Invalid command id");
      const id = ctx.db.normalizeId("nodeCommands", raw);
      const row = id === null ? null : await ctx.db.get(id);
      commands.push({
        id: raw,
        status: row !== null && row.nodeId === nodeId ? row.status : ("missing" as const),
      });
    }
    return { commands };
  },
});

/**
 * Where a build Node fetches a run's source. An upload is a Convex file-storage URL: a capability
 * URL, handed only to the claimant of a live command and deleted with the blob when the run ends,
 * so it stops working with the run. A repository source carries no credential here; the HTTP route
 * mints a read-only token for that one repository after this claim check (infra/nodeHttp.ts).
 */
async function sourceOf(ctx: QueryCtx, dep: Doc<"appDeployments">) {
  const source = dep.source;
  if (source === undefined) throw new ConvexError("This deployment has no source");
  if (source.kind === "upload") {
    if (dep.sourceDeleted) throw new ConvexError("This deployment's upload is gone");
    const url = await ctx.storage.getUrl(source.storageId);
    if (url === null) throw new ConvexError("This deployment's upload is gone");
    return { kind: "upload" as const, url };
  }
  return { kind: "git" as const, repo: source.repo, ref: source.ref, sha: source.sha ?? "" };
}

export const payload = internalQuery({
  args: claimFields,
  handler: async (ctx, args) => {
    const row = await claimed(ctx, args);
    if (row.command.kind === "operate")
      return { kind: "operate" as const, operation: row.command.operation };
    if (row.command.kind === "logs") {
      const name = row.command.operation.name;
      if (name !== "container.logs" && name !== "service.logs")
        throw new ConvexError("A logs command runs a logs operation only");
      return { kind: "logs" as const, operation: row.command.operation };
    }
    if (row.command.kind === "spec") {
      const dep = await activeDeployment(
        ctx,
        row.command.deploymentId,
        row.nodeId,
        "deploy",
        "build",
      );
      if (dep.stage !== "reading-spec") throw new ConvexError("Deployment is past its spec step");
      return { kind: "spec" as const, source: await sourceOf(ctx, dep) };
    }
    if (row.command.kind === "build") {
      const dep = await activeDeployment(
        ctx,
        row.command.deploymentId,
        row.nodeId,
        "deploy",
        "build",
      );
      const service = row.command.service;
      const build = dep.plan?.builds.find((b) => b.service === service);
      if (dep.stage !== "building" || build === undefined)
        throw new ConvexError("Deployment has no such build step");
      return {
        kind: "build" as const,
        app: dep.app,
        service,
        source: await sourceOf(ctx, dep),
        dir: build.dir,
        image: build.image,
      };
    }
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
      const env = { ...s.env, ...scopes.appWide, ...scopes.services[s.name] };
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
    // Only an operator's deploy run adopts, and each Node only the containers it starts.
    const adopt =
      row.command.operation === "failover"
        ? []
        : (spec.dep.adopt ?? []).filter((name) =>
            spec.services.some((s) => `${spec.app.name}-${s.name}` === name),
          );
    const result = {
      kind: "deploy" as const,
      app: spec.app.name,
      services,
      ...(adopt.length === 0 ? {} : { adopt }),
    };
    if (new TextEncoder().encode(JSON.stringify(result)).length > 200 * 1024)
      throw new ConvexError("Deployment payload too large");
    return result;
  },
});
