// The deploy pipeline, run from Convex for Nodes in connect-convex mode (ADR 0016 phase 3). A port
// of the Hub's runDeploy (apps/hub/src/runtime/appdeploy.ts) as a state machine over the
// appDeployments row:
//
//   queued → reading-spec → planning → building → deploying → linking → done
//                                                                      ↘ failed (from any stage)
//
// A failover run starts at planning and never builds: it redeploys the images the App already runs.
//
// Each run holds its App's lease (leases.ts) from the moment it leaves `queued` until it is
// terminal, so a second run of the same App waits in `queued`. Every transition is a mutation
// fenced on the run's lease epoch: a run that lost its lease cannot commit a stage, a plan, the App
// row or a route. Nothing here sleeps. A step that needs a Node is a Node command (#187); the run
// moves on when the Node reports (nodeCommands.report schedules a tick) or at the next pulse (a
// cron every 10 seconds), which also renews the lease while the run waits.
//
// Leases fence Convex writes only. They cannot stop a Node that already claimed a step from
// finishing it. What makes the Node-side effects safe is that each step's command has a
// deterministic idempotency key, `<deploymentId>:<step>:<nodeId>`: enqueueing a step twice returns
// the command already queued, and the Infra Agent's journal turns a re-delivered command into a
// replay of the outcome it recorded instead of a second build or deploy. Image tags are derived
// from the run (git sha or deployment id), so even a repeated push writes the same tag.
import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { appendAudit } from "./auditLog";
import { upsertApp, upsertMeshLink, upsertRoute } from "./apps";
import { createDeployment } from "./deployments";
import { acquireAppLease, assertAppLease, releaseAppLease, renewAppLease } from "./leases";
import { namespaceRefusal } from "./namespace";
import { insertNodeCommand, type NodeCommand } from "./nodeCommands";
import { changedNodes, planDeploy } from "./plan";
import { isNodeLive, isTerminalStage, leaseAdmits, type DeployStage } from "./policy";
import { allocatePort } from "./ports";
import { implicitSpec, parseSpec, type AppSpec } from "./spec";

type Run = Doc<"appDeployments">;
type Source = NonNullable<Run["source"]>;

/** How long a step may take once its command is queued, as the Hub allowed each request. */
export const STEP_TIMEOUT_MS = {
  spec: 2 * 60_000,
  build: 15 * 60_000,
  deploy: 5 * 60_000,
} as const;
/** Extra time a step may sit queued behind other commands on the same Node. */
export const QUEUE_ALLOWANCE_MS = 5 * 60_000;
/** Largest source upload accepted, the Hub's request body limit. */
export const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;

const ACTIVE_STAGES = ["reading-spec", "planning", "building", "deploying", "linking"] as const;

/** Where builds push and Nodes pull. See docs/infra-management.md, "Image registry". */
export function registryAddress() {
  return process.env.ERAINFRA_REGISTRY || "127.0.0.1:5000";
}
function appDomain() {
  return process.env.ERAINFRA_APP_DOMAIN || undefined;
}
const holderOf = (id: Id<"appDeployments">) => `deployment:${id}`;
const stepKey = (run: Run, step: string, nodeId: Id<"nodes">) => `${run._id}:${step}:${nodeId}`;

// ---------------------------------------------------------------------------
// Creating and starting runs

export async function createRun(
  ctx: MutationCtx,
  input: {
    app: string;
    operation: "deploy" | "failover";
    trigger: NonNullable<Run["trigger"]>;
    source?: Source;
    buildNodeId?: Id<"nodes">;
    defaultNodeId?: Id<"nodes">;
    port?: number;
    gitBindingId?: Id<"gitBindings">;
    failover?: NonNullable<Run["failover"]>;
  },
) {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.app))
    throw new ConvexError("App names are lowercase alphanumeric + dashes");
  const id = await createDeployment(ctx, {
    app: input.app,
    targetNodeIds: [],
    trigger: input.trigger,
  });
  await ctx.db.patch(id, {
    operation: input.operation,
    ...(input.source === undefined ? {} : { source: input.source }),
    ...(input.buildNodeId === undefined ? {} : { buildNodeId: input.buildNodeId }),
    ...(input.defaultNodeId === undefined ? {} : { defaultNodeId: input.defaultNodeId }),
    ...(input.port === undefined ? {} : { port: input.port }),
    ...(input.gitBindingId === undefined ? {} : { gitBindingId: input.gitBindingId }),
    ...(input.failover === undefined ? {} : { failover: input.failover }),
  });
  await ctx.scheduler.runAfter(0, internal.infra.pipeline.tick, { deploymentId: id });
  return id;
}

/** Live connect-convex Nodes, by name, so "the first Node" is the same Node every time. */
async function liveNodes(ctx: MutationCtx, now: number) {
  const nodes = await ctx.db.query("nodes").take(500);
  return nodes
    .filter((n) => isNodeLive(n.lastSeenAt, now))
    .toSorted((a, b) => a.name.localeCompare(b.name));
}

/**
 * Take the App's lease and leave `queued`. Refused while another run (or a failover) holds it: the
 * run stays queued and is started when that one finishes (`kickApp`) or at a later pulse.
 */
async function begin(ctx: MutationCtx, run: Run) {
  const now = Date.now();
  // Oldest first: a run never overtakes an earlier queued run of the same App. Read through the
  // stage index: few runs are queued at once, while an App's history can hold a thousand.
  const earlier = await ctx.db
    .query("appDeployments")
    .withIndex("by_stage", (q) => q.eq("stage", "queued"))
    .filter((q) =>
      q.and(
        q.eq(q.field("app"), run.app),
        q.neq(q.field("operation"), undefined),
        q.lt(q.field("startedAt"), run.startedAt),
      ),
    )
    .first();
  if (earlier !== null) return;
  const lease = await acquireAppLease(ctx, {
    app: run.app,
    holder: holderOf(run._id),
    operation: run.operation!,
    now,
  });
  if (!lease.grant) return;
  const patch: Partial<Run> = { leaseEpoch: lease.epoch, stageStartedAt: now };
  if (run.operation === "deploy") {
    const live = await liveNodes(ctx, now);
    const buildNodeId = run.buildNodeId ?? live[0]?._id;
    const defaultNodeId = run.defaultNodeId ?? live[0]?._id;
    if (buildNodeId === undefined || defaultNodeId === undefined) {
      await ctx.db.patch(run._id, patch);
      await finish(ctx, { ...run, ...patch }, "failed", {
        detail: "reading-spec",
        error: "No Node is connected to Convex; start an Infra Agent in connect-convex mode",
      });
      return;
    }
    Object.assign(patch, {
      buildNodeId,
      defaultNodeId,
      stage: "reading-spec" as const,
      detail: "reading the spec file",
    });
  } else {
    Object.assign(patch, { stage: "planning" as const, detail: "planning the failover" });
  }
  await ctx.db.patch(run._id, patch);
  await appendAudit(ctx, {
    actor: run.trigger?.actor ?? `system:${run.operation}`,
    action: run.operation === "failover" ? "apps.failover.start" : "apps.deploy.start",
    target: run.app,
    outcome: "attempt",
    meta: { deploymentId: run._id, epoch: lease.epoch },
  });
  await advance(ctx, (await ctx.db.get(run._id))!);
}

/** Start the oldest queued run of an App, if its lease is free. */
async function kickApp(ctx: MutationCtx, app: string) {
  const next = await ctx.db
    .query("appDeployments")
    .withIndex("by_stage", (q) => q.eq("stage", "queued"))
    .filter((q) => q.and(q.eq(q.field("app"), app), q.neq(q.field("operation"), undefined)))
    .first();
  if (next !== null) await begin(ctx, next);
}

// ---------------------------------------------------------------------------
// Advancing a run

/**
 * Move a run as far as it can go now. Called with the lease already checked and renewed. Each
 * stage either finishes in this transaction and falls through to the next, or leaves a Node
 * command queued and returns until that command settles.
 */
async function advance(ctx: MutationCtx, run: Run) {
  for (let guard = 0; guard < 8; guard++) {
    if (isTerminalStage(run.stage)) return;
    const next = await runStage(ctx, run);
    if (next === null) return;
    run = next;
  }
}

/** One stage. Returns the updated run to continue with, or null to wait. */
async function runStage(ctx: MutationCtx, run: Run): Promise<Run | null> {
  switch (run.stage) {
    case "reading-spec": {
      const nodeId = run.buildNodeId!;
      const state = await runStep(ctx, run, nodeId, "spec", {
        kind: "spec",
        deploymentId: run._id,
      });
      if (state.kind !== "done") return state.kind === "wait" ? null : await fail(ctx, run, state);
      const text = state.command.specText ?? "";
      let spec: AppSpec;
      if (text.trim().length > 0) {
        const parsed = parseSpec(text, run.app);
        if (!parsed.ok) return await fail(ctx, run, { error: parsed.error });
        spec = parsed.spec;
      } else if (run.port !== undefined) {
        spec = implicitSpec(run.app, run.port);
      } else {
        return await fail(ctx, run, {
          error: "the source has no erainfra.yaml or portless.yaml; add one, or set a port",
        });
      }
      if (spec.app !== run.app)
        return await fail(ctx, run, {
          error: `the spec names App "${spec.app}", but this run deploys "${run.app}"`,
        });
      return await moveTo(ctx, run, "planning", "planning placement and ports", { spec });
    }
    case "planning":
      return await planStage(ctx, run);
    case "building": {
      const builds = run.plan!.builds;
      for (const [i, build] of builds.entries()) {
        const nodeId = run.buildNodeId!;
        const state = await runStep(ctx, run, nodeId, `build-${build.service}`, {
          kind: "build",
          deploymentId: run._id,
          service: build.service,
        });
        if (state.kind === "failed") return await fail(ctx, run, state);
        if (state.kind === "wait") {
          const detail = `building ${build.service} (${i + 1}/${builds.length})`;
          if (run.detail !== detail) await ctx.db.patch(run._id, { detail });
          return null;
        }
      }
      return await moveTo(ctx, run, "deploying", deployDetail(run.plan!));
    }
    case "deploying": {
      // Every Node's group at once; each Node runs its own commands one at a time.
      let waiting = false;
      for (const nodeId of run.plan!.deployNodeIds) {
        const state = await runStep(ctx, run, nodeId, "deploy", {
          kind: "deploy",
          deploymentId: run._id,
          ...(run.operation === "failover" ? { operation: "failover" as const } : {}),
        });
        if (state.kind === "failed") return await fail(ctx, run, state);
        if (state.kind === "wait") waiting = true;
      }
      if (waiting) return null;
      return await moveTo(ctx, run, "linking", `recording ${run.plan!.links.length} link(s)`);
    }
    case "linking":
      await commit(ctx, run);
      return null;
    default:
      return null;
  }
}

function deployDetail(plan: { deployNodeIds: readonly unknown[] }) {
  return `deploying on ${plan.deployNodeIds.length} Node(s)`;
}

async function moveTo(
  ctx: MutationCtx,
  run: Run,
  stage: DeployStage,
  detail: string,
  extra: Partial<Run> = {},
) {
  await ctx.db.patch(run._id, { stage, detail, stageStartedAt: Date.now(), ...extra });
  return (await ctx.db.get(run._id))!;
}

type StepState =
  | { kind: "wait" }
  | { kind: "done"; command: Doc<"nodeCommands"> }
  | { kind: "failed"; error: string };

/**
 * Queue a step's Node command (idempotently, by its deterministic key) and report where it stands.
 * A step fails when its command fails or ends unknown, when its Node stops heartbeating, or when it
 * outlives its timeout.
 */
async function runStep(
  ctx: MutationCtx,
  run: Run,
  nodeId: Id<"nodes">,
  step: string,
  command: NodeCommand,
): Promise<StepState> {
  const node = await ctx.db.get(nodeId);
  const name = node?.name ?? nodeId;
  const { id } = await insertNodeCommand(ctx, {
    nodeId,
    idempotencyKey: stepKey(run, step, nodeId),
    command,
    app: run.app,
    appEpoch: run.leaseEpoch,
    deploymentId: run._id,
  });
  const row = (await ctx.db.get(id))!;
  switch (row.status) {
    case "success":
      return { kind: "done", command: row };
    case "failure":
      return { kind: "failed", error: `${step} failed on ${name}; the Infra Agent's log says why` };
    case "unknown":
      return {
        kind: "failed",
        error: `${step} on ${name} ended with an unknown outcome (the Infra Agent restarted mid-step); inspect the Node before deploying again`,
      };
    case "cancelled":
      return { kind: "failed", error: `${step} on ${name} was cancelled` };
  }
  const now = Date.now();
  if (!isNodeLive(node?.lastSeenAt, now))
    return { kind: "failed", error: `${name} has stopped sending heartbeats` };
  const kind = command.kind === "build" ? "build" : command.kind === "spec" ? "spec" : "deploy";
  if (now - row.createdAt > STEP_TIMEOUT_MS[kind] + QUEUE_ALLOWANCE_MS)
    return { kind: "failed", error: `${step} on ${name} timed out` };
  return { kind: "wait" };
}

async function fail(ctx: MutationCtx, run: Run, failure: { error: string }) {
  await finish(ctx, run, "failed", { detail: run.stage, error: failure.error });
  return null;
}

// ---------------------------------------------------------------------------
// Planning

async function planStage(ctx: MutationCtx, run: Run): Promise<Run | null> {
  const now = Date.now();
  const live = await liveNodes(ctx, now);
  const liveIds = new Set(live.map((n) => n._id));
  let spec: AppSpec;
  let defaultNodeId: Id<"nodes">;
  let placement: Record<string, Id<"nodes">> | undefined;
  let images: Record<string, string> | undefined;
  let before: Doc<"apps"> | null = null;
  if (run.operation === "failover") {
    before = await ctx.db
      .query("apps")
      .withIndex("by_name", (q) => q.eq("name", run.app))
      .unique();
    const lost = run.failover!.lostNodeId;
    if (before === null) return await fail(ctx, run, { error: "the App no longer exists" });
    if (before.spec === undefined)
      return await fail(ctx, run, {
        error:
          "the App has no stored spec (it was copied from the Hub); deploy it once through Convex to enable failover",
      });
    const onLost = before.services.filter((s) => (s.nodeId ?? before!.nodeId) === lost);
    if (onLost.length === 0) {
      await finish(ctx, run, "done", { detail: "nothing ran on the lost Node", urls: [] });
      return null;
    }
    const survivor = liveIds.has(run.failover!.toNodeId)
      ? run.failover!.toNodeId
      : live.find((n) => n._id !== lost)?._id;
    if (survivor === undefined || survivor === lost)
      return await fail(ctx, run, { error: "no surviving Node to move the App to" });
    if (survivor !== run.failover!.toNodeId)
      await ctx.db.patch(run._id, { failover: { lostNodeId: lost, toNodeId: survivor } });
    spec = before.spec;
    defaultNodeId = before.nodeId === lost ? survivor : before.nodeId;
    // The Hub moved a group by its primary Node only and left services[].node pointing at the lost
    // Node. Here every service is placed by its own Node, so a service on a secondary Node that was
    // lost moves, and every moved service records where it went.
    placement = {};
    images = {};
    for (const s of before.services) {
      const node = s.nodeId ?? before.nodeId;
      placement[s.name] = node === lost ? survivor : node;
      images[s.name] = s.image;
    }
  } else {
    spec = run.spec!;
    defaultNodeId = run.defaultNodeId!;
  }
  const nodeIds = new Map<string, Id<"nodes">>();
  for (const s of spec.services) {
    if (s.node === undefined || nodeIds.has(s.node)) continue;
    const row = await ctx.db
      .query("nodes")
      .withIndex("by_name", (q) => q.eq("name", s.node!))
      .unique();
    if (row !== null) nodeIds.set(s.node, row._id);
  }
  const revision =
    run.source?.kind === "git" && run.source.sha ? run.source.sha : (run._id as string);
  let planned;
  try {
    planned = await planDeploy({
      spec,
      defaultNodeId,
      nodeIdOf: (name) => nodeIds.get(name) ?? null,
      placement,
      images,
      registry: registryAddress(),
      revision,
      allocate: (nodeId, key) => allocatePort(ctx, nodeId, key),
    });
  } catch (e) {
    return await fail(ctx, run, {
      error: e instanceof ConvexError ? String(e.data) : "planning failed",
    });
  }
  if (!planned.ok) return await fail(ctx, run, { error: planned.error });
  const plan = planned.plan;
  // Every name the plan derives (containers, volumes, network, links, routes) must be this App's
  // or nobody's (namespace.ts). Checked before anything reaches a Node.
  const taken = await namespaceRefusal(ctx, run.app, plan);
  if (taken !== null) return await fail(ctx, run, { error: taken });
  const deployNodeIds =
    before === null
      ? [...new Set(plan.services.map((s) => s.nodeId))]
      : changedNodes(before.services, before.nodeId, plan.services);
  for (const nodeId of deployNodeIds) {
    if (!liveIds.has(nodeId)) {
      const node = await ctx.db.get(nodeId);
      return await fail(ctx, run, { error: `${node?.name ?? nodeId} is not connected to Convex` });
    }
  }
  const domain = appDomain();
  const urls = plan.services.flatMap((s) =>
    s.route ? [domain ? `https://${s.route}.${domain}` : s.route] : [],
  );
  // The registry must be reachable from the build Node (push) and every Node that starts a
  // service (pull) before either step runs.
  const registryError = await ensureRegistryLinks(ctx, [
    ...deployNodeIds,
    ...(plan.builds.length > 0 && run.buildNodeId !== undefined ? [run.buildNodeId] : []),
  ]);
  if (registryError !== null) return await fail(ctx, run, { error: registryError });
  // A container retirement queued for a Node by an earlier failover must not remove what this run
  // is about to start there.
  for (const nodeId of deployNodeIds)
    await cancelRetirements(
      ctx,
      nodeId,
      plan.services.filter((s) => s.nodeId === nodeId).map((s) => containerName(run.app, s.name)),
    );
  const stored = { ...plan, deployNodeIds, urls };
  if (plan.builds.length > 0)
    return await moveTo(ctx, run, "building", `building ${plan.builds.length} service(s)`, {
      plan: stored,
      targetNodeIds: deployNodeIds,
    });
  return await moveTo(ctx, run, "deploying", deployDetail(stored), {
    plan: stored,
    targetNodeIds: deployNodeIds,
  });
}

/**
 * The Hub's registry model: one registry container on the Node named by ERAINFRA_REGISTRY_NODE,
 * reached by every other Node at the same loopback address over a mesh link, so Docker treats it
 * as a local insecure registry and no daemon needs configuring. Each link is a standalone
 * `meshLinks` row named `registry-<node>`, which the Nodes' mesh snapshots carry
 * (nodeState.ts); the links persist, so a later failover can still pull. Unset, the registry is
 * one every Node reaches by itself (ERAINFRA_REGISTRY), and nothing is linked.
 */
async function ensureRegistryLinks(ctx: MutationCtx, nodeIds: Id<"nodes">[]) {
  const registryNode = process.env.ERAINFRA_REGISTRY_NODE;
  if (!registryNode) return null;
  const provider = await ctx.db
    .query("nodes")
    .withIndex("by_name", (q) => q.eq("name", registryNode))
    .unique();
  if (provider === null) return `ERAINFRA_REGISTRY_NODE names no Node "${registryNode}"`;
  const port = Number(registryAddress().split(":").pop());
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    return `cannot read a port from ERAINFRA_REGISTRY="${registryAddress()}"`;
  for (const nodeId of new Set(nodeIds)) {
    if (nodeId === provider._id) continue;
    const node = await ctx.db.get(nodeId);
    if (node === null) continue;
    const name = `registry-${node.name}`.slice(0, 63);
    const existing = await ctx.db
      .query("meshLinks")
      .withIndex("by_name", (q) => q.eq("name", name))
      .unique();
    if (existing !== null && existing.createdBy !== "deploy")
      return `the mesh link name ${name} is taken by a link someone declared`;
    if (
      existing !== null &&
      existing.providerNodeId === provider._id &&
      existing.consumerNodeId === nodeId &&
      existing.providerPort === port &&
      existing.localPort === port
    )
      continue;
    await upsertMeshLink(ctx, {
      name,
      providerNodeId: provider._id,
      providerPort: port,
      consumerNodeId: nodeId,
      localPort: port,
      createdBy: "deploy",
    });
  }
  return null;
}

const retireKey = (run: Id<"appDeployments">, service: string, nodeId: Id<"nodes">) =>
  `${run}:retire-${service}:${nodeId}`;
const containerName = (app: string, service: string) => `${app}-${service}`;

/**
 * Cancel the queued retirements of exactly the containers this run starts on a Node. Matched by
 * exact name, never by an `<app>-` prefix: another App's containers can share that prefix (App
 * `shop-web`'s are `shop-web-*`), and the namespace check makes each exact name one App's.
 */
async function cancelRetirements(ctx: MutationCtx, nodeId: Id<"nodes">, containers: string[]) {
  const names = new Set(containers);
  const pending = await ctx.db
    .query("nodeCommands")
    .withIndex("by_node_status", (q) => q.eq("nodeId", nodeId).eq("status", "pending"))
    .take(200);
  for (const row of pending) {
    if (
      row.command.kind === "operate" &&
      row.command.operation.name === "container.remove" &&
      names.has(row.command.operation.args.name ?? "") &&
      row.idempotencyKey.includes(":retire-")
    )
      await ctx.db.patch(row._id, {
        status: "cancelled",
        unsettled: false,
        finishedAt: Date.now(),
      });
  }
}

// ---------------------------------------------------------------------------
// Committing and finishing

/**
 * Every Node is up: record the App (what failover, the mesh state and later redeploys read), then
 * flip its routes, then finish. Cross-node links are part of the App row, so each Node's next
 * state poll carries them (nodeState.ts).
 */
async function commit(ctx: MutationCtx, run: Run) {
  const plan = run.plan!;
  // The App row and its route rows take the node AND port of the placement just deployed, in this
  // one transaction under the App lease epoch. Gateway ingress serves a route only while the two
  // agree with the port allocation (nodeState.ts), so a route never names a port another App holds.
  await assertAppLease(ctx, run.app, run.leaseEpoch!, Date.now());
  // Planning checked the names. This catches a route or name another writer (a Hub import) took
  // since: the run fails instead of taking it.
  const taken = await namespaceRefusal(ctx, run.app, plan);
  if (taken !== null) {
    await fail(ctx, run, { error: taken });
    return;
  }
  const before = await ctx.db
    .query("apps")
    .withIndex("by_name", (q) => q.eq("name", run.app))
    .unique();
  const spec = run.operation === "failover" ? before?.spec : run.spec;
  await upsertApp(ctx, {
    name: run.app,
    nodeId: plan.nodeId,
    services: plan.services,
    links: plan.links,
    ...(spec === undefined ? {} : { spec }),
  });
  for (const s of plan.services)
    if (s.route && s.port !== undefined)
      await upsertRoute(ctx, {
        name: s.route,
        nodeId: s.nodeId ?? plan.nodeId,
        image: s.image,
        port: s.port,
        app: run.app,
        service: s.name,
      });
  if (run.operation === "failover" && before !== null) {
    // The lost Node may only be partitioned, still running the old containers. Queue their removal
    // there; it runs if the Node comes back, under a key that a retry cannot repeat.
    const lost = run.failover!.lostNodeId;
    for (const s of before.services) {
      if ((s.nodeId ?? before.nodeId) !== lost) continue;
      const moved = plan.services.find((p) => p.name === s.name);
      if (moved === undefined || moved.nodeId === lost) continue;
      await insertNodeCommand(ctx, {
        nodeId: lost,
        idempotencyKey: retireKey(run._id, s.name, lost),
        command: {
          kind: "operate",
          operation: { name: "container.remove", args: { name: containerName(run.app, s.name) } },
        },
      }).catch(() => undefined);
    }
  }
  await finish(ctx, run, "done", {
    detail: run.operation === "failover" ? "failed over" : "deployed",
    urls: plan.urls,
  });
}

/**
 * End a run: record the terminal stage, give up its lease, cancel its unsettled steps, delete its
 * uploaded source, note the result on its git binding, audit, and start the next queued run.
 */
async function finish(
  ctx: MutationCtx,
  run: Run,
  stage: "done" | "failed",
  result: { detail: string; error?: string; urls?: string[] },
) {
  const now = Date.now();
  await ctx.db.patch(run._id, {
    stage,
    detail: result.detail,
    finishedAt: now,
    ...(result.error === undefined ? {} : { error: result.error }),
    ...(result.urls === undefined ? {} : { urls: result.urls }),
  });
  if (run.leaseEpoch !== undefined) await releaseAppLease(ctx, run.app, run.leaseEpoch);
  await cleanUp(ctx, (await ctx.db.get(run._id))!);
  await appendAudit(ctx, {
    actor: `system:${run.operation ?? "deploy"}`,
    action: run.operation === "failover" ? "apps.failover" : "apps.deploy",
    target: run.app,
    outcome: stage === "done" ? "success" : "failure",
    meta: {
      deploymentId: run._id,
      ...(result.error === undefined ? {} : { error: result.error.slice(0, 300) }),
      ...(run.failover === undefined
        ? {}
        : { from: run.failover.lostNodeId, to: run.failover.toNodeId }),
    },
  });
  await ctx.scheduler.runAfter(0, internal.infra.pipeline.kick, { app: run.app });
}

/** The parts of ending a run that do not need its lease; the stale sweep runs them too. */
async function cleanUp(ctx: MutationCtx, run: Run) {
  const steps = await ctx.db
    .query("nodeCommands")
    .withIndex("by_deployment", (q) => q.eq("deploymentId", run._id))
    .take(100);
  for (const row of steps)
    if (row.status === "pending" || row.status === "running")
      await ctx.db.patch(row._id, {
        status: "cancelled",
        unsettled: false,
        finishedAt: Date.now(),
      });
  if (run.source?.kind === "upload" && !run.sourceDeleted) {
    await ctx.storage.delete(run.source.storageId).catch(() => undefined);
    await ctx.db.patch(run._id, { sourceDeleted: true });
  }
  if (run.gitBindingId !== undefined) {
    const binding = await ctx.db.get(run.gitBindingId);
    if (binding !== null)
      await ctx.db.patch(binding._id, {
        lastStatus: {
          at: Date.now(),
          sha: run.trigger?.sha ?? "",
          ok: run.stage === "done",
          stage: run.stage === "done" ? "done" : run.detail,
          ...(run.error === undefined ? {} : { error: run.error }),
        },
      });
  }
}

// ---------------------------------------------------------------------------
// Entry points

/**
 * Advance one run. Scheduled when a run is created, when one of its steps settles, and by the
 * pulse. A tick for an older epoch, or for a run whose lease lapsed, writes nothing to the App: it
 * only marks the run failed, as the stale sweep would.
 */
export const tick = internalMutation({
  args: { deploymentId: v.id("appDeployments") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.deploymentId);
    if (run === null || run.operation === undefined || isTerminalStage(run.stage)) return null;
    if (run.stage === "queued") {
      await begin(ctx, run);
      return null;
    }
    const now = Date.now();
    const lease = await ctx.db
      .query("appLeases")
      .withIndex("by_app", (q) => q.eq("app", run.app))
      .unique();
    if (run.leaseEpoch === undefined || !leaseAdmits(lease, run.leaseEpoch, now)) {
      await ctx.db.patch(run._id, {
        stage: "failed",
        detail: run.stage,
        error: "lost its App lease mid-run",
        finishedAt: now,
      });
      await cleanUp(ctx, (await ctx.db.get(run._id))!);
      return null;
    }
    await renewAppLease(ctx, { app: run.app, epoch: run.leaseEpoch, now });
    await advance(ctx, run);
    return null;
  },
});

/** Start the next queued run of an App. Scheduled when a run of that App ends. */
export const kick = internalMutation({
  args: { app: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await kickApp(ctx, args.app);
    return null;
  },
});

/**
 * The pipeline's clock, run by a cron every 10 seconds: ticks every live run, which renews its
 * lease and applies step timeouts, and every queued run, which starts once its App is free. With
 * nothing in flight it is a few indexed reads.
 */
export const pulse = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    let scheduled = 0;
    for (const stage of ["queued", ...ACTIVE_STAGES] as const) {
      const rows = await ctx.db
        .query("appDeployments")
        .withIndex("by_stage", (q) => q.eq("stage", stage))
        .take(100);
      for (const row of rows) {
        if (row.operation === undefined) continue;
        await ctx.scheduler.runAfter(0, internal.infra.pipeline.tick, { deploymentId: row._id });
        scheduled += 1;
      }
    }
    return scheduled;
  },
});

/** Clean up after a run the stale sweep failed (deployments.sweepStale). */
export const afterSweep = internalMutation({
  args: { deploymentId: v.id("appDeployments") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.deploymentId);
    if (run === null || !isTerminalStage(run.stage)) return null;
    await cleanUp(ctx, run);
    await kickApp(ctx, run.app);
    return null;
  },
});
