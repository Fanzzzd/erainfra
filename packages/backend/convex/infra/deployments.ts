// Deploy pipeline records (the Hub's `deployments`) and App-scoped coordination for deploy and
// failover. Their Convex progress/placement writes are fenced on the App lease epoch (leases.ts).
// The pipeline that drives these rows is infra/pipeline.ts; it explains how Node-side effects are
// made safe, which the lease alone cannot do.
//
// The Hub marked in-flight deploys failed at boot (`failStale`), because a restart killed them.
// There is no boot here; `sweepStale` runs on a schedule and fails any run whose lease lapsed.
import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, query, type MutationCtx } from "../_generated/server";
import { requirePermission } from "./access";
import { loadRouteOwner } from "./apps";
import { appendAudit } from "./auditLog";
import { bumpCounter, readCounter, writeCounter } from "./counters";
import { convexWrite } from "./hubProvenance";
import { acquireAppLease, assertAppLease, releaseAppLease, renewAppLease } from "./leases";
import {
  DEPLOY_STAGES,
  DEPLOYMENTS_KEPT,
  isTerminalStage,
  leaseAdmits,
  type DeployStage,
} from "./policy";
import { deployStageValidator } from "./tables";

/** A queued run that never got its App's lease in this long is failed by the sweep. */
export const QUEUED_RUN_TIMEOUT_MS = 60 * 60_000;

type Trigger = NonNullable<Doc<"appDeployments">["trigger"]>;

/**
 * Insert a deployment record and trim history to the newest DEPLOYMENTS_KEPT, as the Hub did on
 * every create. The retained count is a counter row, so trimming reads only the rows it deletes.
 */
export async function createDeployment(
  ctx: MutationCtx,
  input: {
    app: string;
    targetNodeIds: Id<"nodes">[];
    trigger: Trigger;
    stage?: DeployStage;
    detail?: string;
    urls?: string[];
    error?: string;
    startedAt?: number;
    finishedAt?: number;
    legacyId?: string;
  },
) {
  const stage = input.stage ?? "queued";
  const id = await ctx.db.insert("appDeployments", {
    app: input.app,
    stage,
    detail: input.detail ?? stage,
    urls: input.urls ?? [],
    startedAt: input.startedAt ?? Date.now(),
    targetNodeIds: input.targetNodeIds,
    trigger: input.trigger,
    ...(input.error === undefined ? {} : { error: input.error }),
    ...(input.finishedAt === undefined ? {} : { finishedAt: input.finishedAt }),
    ...(input.legacyId === undefined ? {} : { legacyId: input.legacyId }),
  });
  const retained = await bumpCounter(ctx, "deployments", 1);
  if (retained > DEPLOYMENTS_KEPT) {
    const excess = await ctx.db
      .query("appDeployments")
      .withIndex("by_startedAt")
      .order("asc")
      .take(retained - DEPLOYMENTS_KEPT);
    for (const row of excess) await ctx.db.delete(row._id);
    await writeCounter(ctx, "deployments", retained - excess.length);
  }
  return id;
}

const holderOf = (deploymentId: Id<"appDeployments">) => `deployment:${deploymentId}`;

/**
 * Start a queued run by taking its App's lease. A second run for the same App waits in `queued`
 * until the first finishes or its lease lapses. Only one live lease can commit fenced Convex
 * writes; an earlier holder's outstanding external work must be fenced at the runtime as well.
 */
export const begin = internalMutation({
  args: { deploymentId: v.id("appDeployments") },
  returns: v.union(
    v.object({ started: v.literal(true), epoch: v.number() }),
    v.object({ started: v.literal(false), heldBy: v.string() }),
  ),
  handler: async (ctx, args) => {
    const deployment = await ctx.db.get(args.deploymentId);
    if (deployment === null) throw new ConvexError("No such deployment");
    if (deployment.stage !== "queued" || deployment.leaseEpoch !== undefined) {
      throw new ConvexError(`Deployment is ${deployment.stage}; only a queued run can begin`);
    }
    const now = Date.now();
    const lease = await acquireAppLease(ctx, {
      app: deployment.app,
      holder: holderOf(deployment._id),
      operation: "deploy",
      now,
    });
    if (!lease.grant) return { started: false as const, heldBy: lease.heldBy };
    await ctx.db.patch(deployment._id, { leaseEpoch: lease.epoch });
    return { started: true as const, epoch: lease.epoch };
  },
});

/**
 * Record a pipeline step, fenced on the run's lease epoch. Renews the lease while the run is
 * moving; a terminal stage records the finish time and gives the lease up.
 */
export const advance = internalMutation({
  args: {
    deploymentId: v.id("appDeployments"),
    epoch: v.number(),
    stage: deployStageValidator,
    detail: v.optional(v.string()),
    urls: v.optional(v.array(v.string())),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const deployment = await ctx.db.get(args.deploymentId);
    if (deployment === null) throw new ConvexError("No such deployment");
    if (deployment.leaseEpoch !== args.epoch || isTerminalStage(deployment.stage)) {
      throw new ConvexError("Stale lease: this run no longer owns its deployment");
    }
    const now = Date.now();
    await assertAppLease(ctx, deployment.app, args.epoch, now);
    const terminal = isTerminalStage(args.stage);
    await ctx.db.patch(deployment._id, {
      stage: args.stage,
      detail: args.detail ?? args.stage,
      ...(args.urls === undefined ? {} : { urls: args.urls }),
      ...(args.error === undefined ? {} : { error: args.error }),
      ...(terminal ? { finishedAt: now } : {}),
    });
    if (terminal) {
      await releaseAppLease(ctx, deployment.app, args.epoch);
    } else {
      await renewAppLease(ctx, { app: deployment.app, epoch: args.epoch, now });
    }
    return null;
  },
});

/**
 * Fail every run that can no longer finish: one whose App lease lapsed or passed to another
 * holder, and one that sat queued past QUEUED_RUN_TIMEOUT_MS. A mutation, so running it twice
 * fails nothing twice.
 */
export const sweepStale = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const now = Date.now();
    let failed = 0;
    for (const stage of DEPLOY_STAGES) {
      if (isTerminalStage(stage)) continue;
      const rows = await ctx.db
        .query("appDeployments")
        .withIndex("by_stage", (q) => q.eq("stage", stage))
        .take(200);
      for (const row of rows) {
        // A run copied from the Hub belongs to the Hub, which settles it; the next import copies
        // the outcome.
        if (row.trigger?.kind === "hub-import") continue;
        let reason: string | null = null;
        if (row.leaseEpoch === undefined) {
          if (now - row.startedAt > QUEUED_RUN_TIMEOUT_MS)
            reason = "never started: its App stayed busy";
        } else {
          const lease = await ctx.db
            .query("appLeases")
            .withIndex("by_app", (q) => q.eq("app", row.app))
            .unique();
          if (!leaseAdmits(lease, row.leaseEpoch, now)) reason = "lost its App lease mid-run";
        }
        if (reason !== null) {
          await ctx.db.patch(row._id, { stage: "failed", error: reason, finishedAt: now });
          // A pipeline run also cancels its queued Node steps, deletes its upload and lets the
          // next queued run of its App start.
          if (row.operation !== undefined)
            await ctx.scheduler.runAfter(0, internal.infra.pipeline.afterSweep, {
              deploymentId: row._id,
            });
          failed += 1;
        }
      }
    }
    return failed;
  },
});

/** Take an App's lease to move it off a lost Node. Refused while a deploy or another failover holds it. */
export const beginFailover = internalMutation({
  args: { app: v.string(), lostNodeId: v.id("nodes") },
  returns: v.union(
    v.object({ granted: v.literal(true), epoch: v.number() }),
    v.object({ granted: v.literal(false), heldBy: v.string() }),
  ),
  handler: async (ctx, args) => {
    const lease = await acquireAppLease(ctx, {
      app: args.app,
      holder: `failover:${args.lostNodeId}`,
      operation: "failover",
      now: Date.now(),
    });
    return lease.grant
      ? { granted: true as const, epoch: lease.epoch }
      : { granted: false as const, heldBy: lease.heldBy };
  },
});

/**
 * Point an App, and the routes of its services, at the Node it was redeployed onto. Fenced: a
 * failover that lost its lease cannot move an App another operation now owns.
 *
 * A moved service keeps its name but not its port: the new Node allocates its own (key
 * `<app>/<service>`), so the redeploy on it must have allocated one. Each moved service's App row
 * entry and route row get the new Node and that Node's port together, in this one fenced
 * transaction. The old port number on the new Node may belong to another App, so a service with
 * no allocation there is refused, not moved with its old port (gateway ingress would otherwise
 * expose another App's port under this App's name; infra/nodeState.ts refuses such a route too).
 * The deploy pipeline's failover (pipeline.ts `commit`) writes the plan's node and port the same way.
 */
export const completeFailover = internalMutation({
  args: { app: v.string(), epoch: v.number(), fromNodeId: v.id("nodes"), toNodeId: v.id("nodes") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertAppLease(ctx, args.app, args.epoch, Date.now());
    const app = await ctx.db
      .query("apps")
      .withIndex("by_name", (q) => q.eq("name", args.app))
      .unique();
    if (app === null)
      throw new ConvexError(
        `${args.app} has no App row, so its new port is unknown; redeploy it through the pipeline`,
      );
    // Move every service that ran on the lost Node, by its own placement, not only the App's
    // primary Node: the Hub moved the primary and left services[].node pointing at the lost one.
    const services = [];
    for (const s of app.services) {
      if ((s.nodeId ?? app.nodeId) !== args.fromNodeId) {
        services.push(s);
        continue;
      }
      let port: number | undefined;
      if (s.port !== undefined) {
        const allocation = await ctx.db
          .query("portAllocations")
          .withIndex("by_node_key", (q) =>
            q.eq("nodeId", args.toNodeId).eq("key", `${app.name}/${s.name}`),
          )
          .unique();
        if (allocation === null)
          throw new ConvexError(
            `${app.name}/${s.name} has no port on the target Node; redeploy it there first`,
          );
        port = allocation.port;
      }
      services.push({
        ...s,
        nodeId: args.toNodeId,
        ...(port === undefined ? {} : { port }),
      });
    }
    const now = Date.now();
    await ctx.db.patch(app._id, {
      nodeId: app.nodeId === args.fromNodeId ? args.toNodeId : app.nodeId,
      services,
      provenance: convexWrite(now),
      updatedAt: now,
    });
    for (const s of services) {
      if (s.route === undefined || s.nodeId !== args.toNodeId) continue;
      const route = await ctx.db
        .query("appRoutes")
        .withIndex("by_name", (q) => q.eq("name", s.route!))
        .unique();
      // Only this App's own route moves with it.
      if (route === null || route.nodeId !== args.fromNodeId) continue;
      const owner = await loadRouteOwner(ctx, route);
      if (owner !== "ambiguous" && owner.app === app.name) {
        await ctx.db.patch(route._id, {
          nodeId: args.toNodeId,
          ...(s.port === undefined ? {} : { port: s.port }),
          provenance: convexWrite(now),
          updatedAt: now,
        });
      }
    }
    await releaseAppLease(ctx, args.app, args.epoch);
    await appendAudit(ctx, {
      actor: "system:failover",
      action: "apps.failover",
      target: args.app,
      outcome: "success",
      meta: { from: args.fromNodeId, to: args.toNodeId },
    });
    return null;
  },
});

const deploymentView = v.object({
  _id: v.id("appDeployments"),
  app: v.string(),
  stage: deployStageValidator,
  detail: v.string(),
  urls: v.array(v.string()),
  error: v.optional(v.string()),
  startedAt: v.number(),
  finishedAt: v.optional(v.number()),
  // Absent on a run copied from the Hub, which predates the pipeline.
  operation: v.optional(v.union(v.literal("deploy"), v.literal("failover"))),
  trigger: v.optional(v.string()),
  actor: v.optional(v.string()),
  sha: v.optional(v.string()),
});

function view(row: Doc<"appDeployments">) {
  return {
    _id: row._id,
    app: row.app,
    stage: row.stage,
    detail: row.detail,
    urls: row.urls,
    error: row.error,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    operation: row.operation,
    trigger: row.trigger?.kind,
    actor: row.trigger?.actor,
    sha: row.trigger?.sha,
  };
}

/** Newest first, optionally for one App. */
export const list = query({
  args: { app: v.optional(v.string()), limit: v.optional(v.number()) },
  returns: v.array(deploymentView),
  handler: async (ctx, args) => {
    await requirePermission(ctx, "app.read");
    const limit = Math.min(Math.max(Math.floor(args.limit ?? 20), 1), 200);
    const rows =
      args.app === undefined
        ? await ctx.db.query("appDeployments").withIndex("by_startedAt").order("desc").take(limit)
        : await ctx.db
            .query("appDeployments")
            .withIndex("by_app_startedAt", (q) => q.eq("app", args.app!))
            .order("desc")
            .take(limit);
    return rows.map(view);
  },
});

/** How many records the retention counter says are kept; for tests and the dashboard. */
export const retainedCount = query({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    await requirePermission(ctx, "app.read");
    return await readCounter(ctx, "deployments");
  },
});
