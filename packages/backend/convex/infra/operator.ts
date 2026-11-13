// Infrastructure management for operators: Nodes, Apps, env and standalone links, as the operator
// API (/api/v1, infra/operatorRoutes.ts), the `erainfra` CLI and the dashboard see them.
//
// Each change runs the same body the dashboard's mutation runs (nodes.ts, secrets.ts, and the
// link and App bodies below), so the two callers cannot disagree about a rule. The internal
// functions take the API token the HTTP layer authenticated and check it against the permission
// table (access.ts requireTokenPermission); every change is audited in the transaction that makes
// it, and so is every refusal of an admin request.
import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { apiCallerValidator, requirePermission, requireTokenPermission } from "./access";
import { isSingleContainerRoute, loadRouteOwner, ownerOfRoute, upsertMeshLink } from "./apps";
import { appendAudit } from "./auditLog";
import { INGRESS_PORT_END, INGRESS_PORT_START } from "./ingress";
import { insertNodeCommand } from "./nodeCommands";
import {
  enrollNode,
  hasLiveCredential,
  resetNodeEndpoint,
  revokeNodeCredential,
  setNodePlacementRoles,
} from "./nodes";
import { isNodeLive, isTerminalStage } from "./policy";
import { releaseAppPorts } from "./ports";
import { maskedSecrets, setSecrets, unsetSecret } from "./secrets";
import { PLACEMENT_ROLES } from "./tables";

type Node = Doc<"nodes">;

/** The most standalone links a mesh snapshot carries (nodeState.ts refuses more). */
export const MAX_STANDALONE_LINKS = 500;
const LINK_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const APP_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

export async function nodeNamed(ctx: QueryCtx, name: string) {
  return ctx.db
    .query("nodes")
    .withIndex("by_name", (q) => q.eq("name", name))
    .unique();
}

async function requireNodeNamed(ctx: QueryCtx, name: string) {
  const node = await nodeNamed(ctx, name);
  if (node === null) throw new ConvexError(`No Node named "${name}"`);
  return node;
}

/**
 * Whether Convex can carry mesh traffic to this Node: its endpoint key is proven and it still
 * holds a live credential. The same test nodeState.ts applies before naming a Node as a peer.
 */
async function meshReady(ctx: QueryCtx, node: Node) {
  return (
    node.meshAddress !== undefined &&
    node.endpointProvenAt !== undefined &&
    node.endpointId === node.meshAddress.id &&
    (await hasLiveCredential(ctx, node._id))
  );
}

// ---------------------------------------------------------------------------
// Views. Timestamps are milliseconds here; the HTTP layer renders them as RFC 3339.

export type NodeView = Awaited<ReturnType<typeof nodeView>>;

async function nodeView(ctx: QueryCtx, node: Node, now: number) {
  const credentials = await ctx.db
    .query("nodeCredentials")
    .withIndex("by_node", (q) => q.eq("nodeId", node._id))
    .take(50);
  const live = credentials.filter((c) => c.revokedAt === undefined);
  const proven =
    node.endpointProvenAt !== undefined &&
    node.meshAddress !== undefined &&
    node.endpointId === node.meshAddress.id;
  return {
    id: node._id,
    name: node.name,
    source: node.source,
    online: isNodeLive(node.lastSeenAt, now),
    lastSeenAt: node.lastSeenAt ?? null,
    infraAgentVersion: node.infraAgentVersion ?? null,
    // Command health from the last heartbeat. `blocked` is a reason code while the Node is online
    // but cannot run commands (nodeState.COMMANDS_BLOCKED_REASONS); null when it can, or when its
    // agent predates the report.
    commands: {
      blocked: node.commandsBlocked ?? null,
      blockedSince: node.commandsBlocked === undefined ? null : (node.commandsBlockedSince ?? null),
      journalKeys: node.journalKeys ?? null,
      journalKeyLimit: node.journalKeyLimit ?? null,
    },
    createdAt: node.createdAt,
    endpoint: {
      id: node.endpointId ?? null,
      // Only a proven endpoint is ever granted a mesh peer (nodeState.ts).
      proven,
      provenAt: proven ? node.endpointProvenAt! : null,
      relayUrls: node.meshAddress?.relay_urls ?? [],
      directAddresses: node.meshAddress?.direct_addrs.length ?? 0,
    },
    credentials: credentials
      .toSorted((a, b) => b.createdAt - a.createdAt)
      .map((c) => ({
        id: c._id,
        hint: c.hint,
        createdAt: c.createdAt,
        revokedAt: c.revokedAt ?? null,
      })),
    liveCredentials: live.length,
    // Set by an owner or admin, never by the Node; `gateway` makes it serve ingress.
    placementRoles: node.placementRoles ?? [],
  };
}

export async function listNodeViews(ctx: QueryCtx, now: number) {
  const nodes = await ctx.db.query("nodes").take(500);
  const views = await Promise.all(nodes.map((node) => nodeView(ctx, node, now)));
  return views.toSorted((a, b) => a.name.localeCompare(b.name));
}

function appDomain() {
  return process.env.ERAINFRA_APP_DOMAIN || undefined;
}
function routeUrl(label: string) {
  const domain = appDomain();
  return domain === undefined ? null : `https://${label}.${domain}`;
}

async function latestRun(ctx: QueryCtx, app: string) {
  return ctx.db
    .query("appDeployments")
    .withIndex("by_app_startedAt", (q) => q.eq("app", app))
    .order("desc")
    .first();
}

export type AppView = Awaited<ReturnType<typeof appView>>;

/**
 * One App, from its `apps` row, or from a single-container route the Hub deployed without one
 * (`kind: "container"`). `status` is what Convex can tell: `deploying` while a run is in flight,
 * `node-offline` when a Node it runs on is gone, has never connected or stopped heartbeating, and
 * otherwise `running`.
 */
async function appView(
  ctx: QueryCtx,
  input: { app: Doc<"apps"> } | { route: Doc<"appRoutes"> },
  names: Map<Id<"nodes">, Node | null>,
  now: number,
) {
  const nodeOf = async (id: Id<"nodes">) => {
    if (!names.has(id)) names.set(id, await ctx.db.get(id));
    return names.get(id) ?? null;
  };
  const name = "app" in input ? input.app.name : input.route.name;
  const services =
    "app" in input
      ? input.app.services.map((s) => ({
          name: s.name,
          nodeId: s.nodeId ?? input.app.nodeId,
          image: s.image,
          port: s.port ?? null,
          route: s.route ?? null,
          container: `${name}-${s.name}`,
        }))
      : [
          {
            name: input.route.name,
            nodeId: input.route.nodeId,
            image: input.route.image,
            port: input.route.port,
            route: input.route.name,
            container: input.route.name,
          },
        ];
  const hosts = [...new Set(services.map((s) => s.nodeId))];
  const hostNodes = await Promise.all(hosts.map(nodeOf));
  const run = await latestRun(ctx, name);
  let status: "deploying" | "running" | "node-offline" = "running";
  if (run !== null && run.operation !== undefined && !isTerminalStage(run.stage)) {
    status = "deploying";
  } else if (hostNodes.some((n) => n === null || !isNodeLive(n.lastSeenAt, now))) {
    status = "node-offline";
  }
  const primary = "app" in input ? input.app.nodeId : input.route.nodeId;
  return {
    name,
    kind: "app" in input ? ("app" as const) : ("container" as const),
    node: (await nodeOf(primary))?.name ?? null,
    status,
    services: await Promise.all(
      services.map(async ({ nodeId, ...s }) => ({
        ...s,
        node: (await nodeOf(nodeId))?.name ?? null,
        url: s.route === null ? null : routeUrl(s.route),
      })),
    ),
    links:
      "app" in input
        ? await Promise.all(
            input.app.links.map(async (l) => ({
              name: l.name,
              need: l.need,
              provider: (await nodeOf(l.providerNodeId))?.name ?? null,
              providerPort: l.providerPort,
              consumer: (await nodeOf(l.consumerNodeId))?.name ?? null,
              localPort: l.localPort,
            })),
          )
        : [],
    // Failover re-plans from the stored spec; an App copied from the Hub has none until it is
    // deployed through Convex once (docs/infra-management.md, Failover).
    failover: "app" in input && input.app.spec !== undefined,
    updatedAt: "app" in input ? input.app.updatedAt : input.route.updatedAt,
    lastDeployment:
      run === null
        ? null
        : {
            id: run._id,
            operation: run.operation ?? null,
            stage: run.stage,
            detail: run.detail,
            error: run.error ?? null,
            startedAt: run.startedAt,
            finishedAt: run.finishedAt ?? null,
          },
  };
}

export async function listAppViews(ctx: QueryCtx, now: number) {
  const names = new Map<Id<"nodes">, Node | null>();
  const apps = await ctx.db.query("apps").take(500);
  const views = await Promise.all(apps.map((app) => appView(ctx, { app }, names, now)));
  // A route that is its own owner is a single-container App the Hub deployed (its legacy path).
  const routes = await ctx.db.query("appRoutes").take(500);
  for (const route of routes) {
    if (!isSingleContainerRoute(route, ownerOfRoute(route, apps))) continue;
    if (apps.some((a) => a.name === route.name)) continue;
    views.push(await appView(ctx, { route }, names, now));
  }
  return views.toSorted((a, b) => a.name.localeCompare(b.name));
}

export async function appStatus(ctx: QueryCtx, name: string, now: number) {
  const names = new Map<Id<"nodes">, Node | null>();
  const app = await ctx.db
    .query("apps")
    .withIndex("by_name", (q) => q.eq("name", name))
    .unique();
  if (app !== null) return appView(ctx, { app }, names, now);
  const route = await ctx.db
    .query("appRoutes")
    .withIndex("by_name", (q) => q.eq("name", name))
    .unique();
  if (route === null || !isSingleContainerRoute(route, await loadRouteOwner(ctx, route)))
    return null;
  return appView(ctx, { route }, names, now);
}

export type LinkView = Awaited<ReturnType<typeof listLinkViews>>[number];

/**
 * Every link Convex derives mesh state from: standalone links, and each App's dependency links.
 *
 * Convex grants a link over erainfra-mesh only when both Nodes have a proven endpoint and a live
 * credential; until then it is `pending`. `state` is derived, not observed: Convex does not see
 * traffic, only endpoint proofs and heartbeats. `active` means both ends are on the mesh and
 * heartbeating.
 */
const nodeLabel = (n: Node | null) => n?.name ?? "a removed Node";

export async function listLinkViews(ctx: QueryCtx, now: number) {
  const cache = new Map<Id<"nodes">, { node: Node | null; ready: boolean }>();
  const about = async (id: Id<"nodes">) => {
    let entry = cache.get(id);
    if (entry === undefined) {
      const node = await ctx.db.get(id);
      entry = { node, ready: node !== null && (await meshReady(ctx, node)) };
      cache.set(id, entry);
    }
    return entry;
  };
  const standalone = await ctx.db.query("meshLinks").take(MAX_STANDALONE_LINKS + 1);
  const apps = await ctx.db.query("apps").take(500);
  const rows = [
    ...standalone.map((l) => ({
      ...l,
      kind: "standalone" as const,
      app: null,
      createdBy: l.createdBy ?? null,
    })),
    ...apps.flatMap((a) =>
      a.links.map((l) => ({
        ...l,
        kind: "app" as const,
        app: a.name,
        createdBy: "deploy" as const,
      })),
    ),
  ];
  const views = [];
  for (const link of rows) {
    const provider = await about(link.providerNodeId);
    const consumer = await about(link.consumerNodeId);
    let state: "active" | "degraded" | "pending" = "active";
    let reason: string | null = null;
    if (!provider.ready || !consumer.ready) {
      state = "pending";
      const missing = [provider, consumer].filter((e) => !e.ready).map((e) => nodeLabel(e.node));
      reason = `${missing.join(" and ")} ${missing.length > 1 ? "have" : "has"} no proven mesh endpoint (never connected, no sidecar, or credential revoked)`;
    } else {
      const silent = [provider, consumer].filter((e) => !isNodeLive(e.node?.lastSeenAt, now));
      if (silent.length > 0) {
        state = "degraded";
        reason = `${silent.map((e) => nodeLabel(e.node)).join(" and ")} stopped heartbeating`;
      }
    }
    views.push({
      name: link.name,
      kind: link.kind,
      app: link.app,
      createdBy: link.createdBy,
      provider: provider.node?.name ?? null,
      providerPort: link.providerPort,
      consumer: consumer.node?.name ?? null,
      localPort: link.localPort,
      // Where the consumer listens: a standalone link on loopback, an App link on the Docker
      // bridge gateway its containers reach as host.docker.internal (nodeState.ts).
      listen: link.kind === "app" ? `bridge:${link.localPort}` : `127.0.0.1:${link.localPort}`,
      state,
      reason,
    });
  }
  return views.toSorted((a, b) => a.name.localeCompare(b.name));
}

/** Every variable name of an App, by scope, masked. */
export async function appEnv(ctx: QueryCtx, app: string) {
  if (!APP_NAME.test(app)) throw new ConvexError(`Invalid App name: ${app}`);
  const rows = await ctx.db
    .query("appSecrets")
    .withIndex("by_app_service_name", (q) => q.eq("app", app))
    .take(1000);
  const services = [...new Set(rows.flatMap((r) => (r.service === undefined ? [] : [r.service])))];
  return {
    app: await maskedSecrets(ctx, app),
    services: Object.fromEntries(
      await Promise.all(
        services.toSorted().map(async (s) => [s, await maskedSecrets(ctx, app, s)] as const),
      ),
    ),
  };
}

// ---------------------------------------------------------------------------
// Links

export async function declareLink(
  ctx: MutationCtx,
  input: {
    name?: string;
    provider: string;
    providerPort: number;
    consumer: string;
    localPort?: number;
    actor: string;
  },
) {
  const localPort = input.localPort ?? input.providerPort;
  for (const [label, port] of [
    ["providerPort", input.providerPort],
    ["localPort", localPort],
  ] as const) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ConvexError(`${label} must be an integer from 1 to 65535`);
    }
  }
  const provider = await requireNodeNamed(ctx, input.provider);
  const consumer = await requireNodeNamed(ctx, input.consumer);
  if (provider._id === consumer._id) {
    throw new ConvexError("A link joins two different Nodes");
  }
  // The Hub's default name, so a link declared on either side of the migration is named alike.
  const name =
    input.name ??
    `${provider.name}-${input.providerPort}-${consumer.name}`
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/^-+/, "")
      .slice(0, 63);
  if (!LINK_NAME.test(name)) {
    throw new ConvexError("A link name is lowercase letters, digits and dashes, at most 63");
  }
  const existing = await ctx.db
    .query("meshLinks")
    .withIndex("by_name", (q) => q.eq("name", name))
    .unique();
  if (existing?.createdBy === "deploy") {
    throw new ConvexError(`The link ${name} is managed by the deploy pipeline`);
  }
  const apps = await ctx.db.query("apps").take(500);
  if (apps.some((a) => a.links.some((l) => l.name === name))) {
    // Two links of one name would make every affected Node's snapshot refuse to apply.
    throw new ConvexError(`The link name ${name} is used by an App dependency`);
  }
  // A gateway listens on this range for its ingress links (infra/ingress.ts).
  if (localPort >= INGRESS_PORT_START && localPort <= INGRESS_PORT_END) {
    throw new ConvexError(
      `Ports ${INGRESS_PORT_START}-${INGRESS_PORT_END} are reserved for gateway ingress`,
    );
  }
  // A second listener on the same consumer port would fail to bind on the Node.
  const standalone = await ctx.db.query("meshLinks").take(MAX_STANDALONE_LINKS + 1);
  const clash = [...standalone, ...apps.flatMap((a) => a.links)].find(
    (l) => l.name !== name && l.consumerNodeId === consumer._id && l.localPort === localPort,
  );
  if (clash !== undefined) {
    throw new ConvexError(
      `${consumer.name} already listens on port ${localPort} for ${clash.name}`,
    );
  }
  if (existing === null && standalone.length >= MAX_STANDALONE_LINKS) {
    throw new ConvexError(`A fleet carries at most ${MAX_STANDALONE_LINKS} standalone links`);
  }
  await upsertMeshLink(ctx, {
    name,
    providerNodeId: provider._id,
    providerPort: input.providerPort,
    consumerNodeId: consumer._id,
    localPort,
    createdBy: "user",
  });
  await appendAudit(ctx, {
    actor: input.actor,
    action: "mesh.link",
    target: name,
    outcome: "success",
    meta: {
      provider: provider.name,
      providerPort: input.providerPort,
      consumer: consumer.name,
      localPort,
      replaced: existing !== null,
    },
  });
  return { name, address: `127.0.0.1:${localPort}`, replaced: existing !== null };
}

export async function removeLink(ctx: MutationCtx, input: { name: string; actor: string }) {
  const row = await ctx.db
    .query("meshLinks")
    .withIndex("by_name", (q) => q.eq("name", input.name))
    .unique();
  if (row === null) throw new ConvexError(`No standalone link named ${input.name}`);
  await ctx.db.delete(row._id);
  await appendAudit(ctx, {
    actor: input.actor,
    action: "mesh.unlink",
    target: input.name,
    outcome: "success",
    meta: { createdBy: row.createdBy ?? null },
  });
  return { name: input.name };
}

// ---------------------------------------------------------------------------
// Removing an App

/**
 * Tear an App down, as the Hub's removeApp did: queue the removal of its containers and network
 * on every Node it runs on, then forget its routes, its App row and its ports. The App's secrets
 * and git bindings stay, as on the Hub; unset or unbind them separately.
 *
 * Refused while a deploy or failover of the App is queued or holds its lease. The removal commands
 * run whenever each Node next polls; one that is offline removes the containers when it comes back.
 */
export async function removeApp(ctx: MutationCtx, input: { app: string; actor: string }) {
  const name = input.app;
  if (!APP_NAME.test(name)) throw new ConvexError(`Invalid App name: ${name}`);
  const app = await ctx.db
    .query("apps")
    .withIndex("by_name", (q) => q.eq("name", name))
    .unique();
  const labelled = await ctx.db
    .query("appRoutes")
    .withIndex("by_name", (q) => q.eq("name", name))
    .unique();
  // Without an App row, a route of this name is an App only when it is a single-container App the
  // Hub deployed. A label another App's service routes at (App `shop`'s `shop-web`) is that App's,
  // and removing it here would remove that App's container.
  let route: Doc<"appRoutes"> | null = null;
  if (app === null && labelled !== null) {
    const owner = await loadRouteOwner(ctx, labelled);
    if (!isSingleContainerRoute(labelled, owner)) {
      throw new ConvexError(
        owner === "ambiguous"
          ? `No App named ${name}; the route ${name} is claimed by more than one App`
          : `No App named ${name}; the route ${name} belongs to App "${owner.app}"`,
      );
    }
    route = labelled;
  }
  if (app === null && route === null) throw new ConvexError(`No App named ${name}`);

  const now = Date.now();
  const lease = await ctx.db
    .query("appLeases")
    .withIndex("by_app", (q) => q.eq("app", name))
    .unique();
  const queued = await ctx.db
    .query("appDeployments")
    .withIndex("by_stage", (q) => q.eq("stage", "queued"))
    .filter((q) => q.and(q.eq(q.field("app"), name), q.neq(q.field("operation"), undefined)))
    .first();
  if ((lease?.holder !== undefined && lease.expiresAt > now) || queued !== null) {
    throw new ConvexError(`A deploy or failover of ${name} is in progress; remove it when it ends`);
  }

  // Containers to remove, by Node.
  const byNode = new Map<Id<"nodes">, string[]>();
  const add = (nodeId: Id<"nodes">, container: string) =>
    byNode.set(nodeId, [...(byNode.get(nodeId) ?? []), container]);
  if (app !== null) {
    for (const s of app.services) add(s.nodeId ?? app.nodeId, `${name}-${s.name}`);
  } else {
    add(route!.nodeId, name);
  }
  // Every check before the first write: the operator API audits a refusal in this transaction.
  for (const [nodeId, containers] of byNode) {
    const node = await ctx.db.get(nodeId);
    if (node === null) continue;
    const pending = await ctx.db
      .query("nodeCommands")
      .withIndex("by_node_status", (q) => q.eq("nodeId", nodeId).eq("status", "pending"))
      .take(200);
    if (pending.length + containers.length + 1 > 200) {
      throw new ConvexError(`${node.name}'s command queue is full; retry when it drains`);
    }
  }
  // One key per removal: a later removal of a redeployed App queues its own commands.
  const removal = `${name}:remove-${now.toString(36)}`;
  const queuedCommands = [];
  for (const [nodeId, containers] of byNode) {
    const node = await ctx.db.get(nodeId);
    if (node === null) continue;
    for (const container of containers) {
      await insertNodeCommand(ctx, {
        nodeId,
        idempotencyKey: `${removal}:${container}`,
        command: {
          kind: "operate",
          operation: { name: "container.remove", args: { name: container } },
        },
      });
      queuedCommands.push({ node: node.name, container });
    }
    if (app !== null) {
      await insertNodeCommand(ctx, {
        nodeId,
        idempotencyKey: `${removal}:net`,
        command: {
          kind: "operate",
          operation: { name: "container.network.remove", args: { name: `${name}-net` } },
        },
      });
    }
  }

  const labels = new Set<string>(labelled === null ? [] : [labelled.name]);
  for (const s of app?.services ?? []) if (s.route) labels.add(s.route);
  const routes: string[] = [];
  for (const label of labels) {
    const row = await ctx.db
      .query("appRoutes")
      .withIndex("by_name", (q) => q.eq("name", label))
      .unique();
    if (row === null) continue;
    // Only this App's own route rows go.
    const owner = await loadRouteOwner(ctx, row);
    if (owner === "ambiguous" || owner.app !== name) continue;
    await ctx.db.delete(row._id);
    routes.push(label);
  }
  if (app !== null) await ctx.db.delete(app._id);
  const ports = await releaseAppPorts(ctx, name);
  await appendAudit(ctx, {
    actor: input.actor,
    action: "apps.remove",
    target: name,
    outcome: "success",
    meta: { containers: queuedCommands, routes, ports },
  });
  return { app: name, containers: queuedCommands, routes };
}

// ---------------------------------------------------------------------------
// Dashboard: signed-in people, through the permission table.

export const nodes = query({
  args: {},
  handler: async (ctx) => {
    await requirePermission(ctx, "app.read");
    return listNodeViews(ctx, Date.now());
  },
});

export const apps = query({
  args: {},
  handler: async (ctx) => {
    await requirePermission(ctx, "app.read");
    return listAppViews(ctx, Date.now());
  },
});

export const links = query({
  args: {},
  handler: async (ctx) => {
    await requirePermission(ctx, "app.read");
    return listLinkViews(ctx, Date.now());
  },
});

export const link = mutation({
  args: {
    name: v.optional(v.string()),
    provider: v.string(),
    providerPort: v.number(),
    consumer: v.string(),
    localPort: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { actor } = await requirePermission(ctx, "app.deploy");
    return declareLink(ctx, { ...args, actor });
  },
});

export const unlink = mutation({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    const { actor } = await requirePermission(ctx, "app.deploy");
    return removeLink(ctx, { ...args, actor });
  },
});

export const remove = mutation({
  args: { app: v.string() },
  handler: async (ctx, args) => {
    const { actor } = await requirePermission(ctx, "app.deploy");
    return removeApp(ctx, { ...args, actor });
  },
});

// ---------------------------------------------------------------------------
// Operator API (/api/v1): internal, called by infra/operatorRoutes.ts with the token it
// authenticated. A refusal is returned, not thrown, so its audit row commits.

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Run a change and audit a refusal. Convex keeps the writes of a mutation that catches an error,
 * so every body run through here validates everything before its first write.
 */
export async function audited<T>(
  ctx: MutationCtx,
  input: { actor: string; action: string; target?: string },
  body: () => Promise<T>,
): Promise<Result<T>> {
  try {
    return { ok: true, value: await body() };
  } catch (error) {
    if (!(error instanceof ConvexError)) throw error;
    const message = typeof error.data === "string" ? error.data : "refused";
    await appendAudit(ctx, {
      actor: input.actor,
      action: input.action,
      ...(input.target === undefined ? {} : { target: input.target }),
      outcome: "deny",
      meta: { error: message },
    });
    return { ok: false, error: message };
  }
}

export const apiNodes = internalQuery({
  args: { caller: apiCallerValidator },
  handler: async (ctx, args) => {
    requireTokenPermission(args.caller, "app.read");
    return listNodeViews(ctx, Date.now());
  },
});

export const apiApps = internalQuery({
  args: { caller: apiCallerValidator },
  handler: async (ctx, args) => {
    requireTokenPermission(args.caller, "app.read");
    return listAppViews(ctx, Date.now());
  },
});

export const apiApp = internalQuery({
  args: { caller: apiCallerValidator, app: v.string() },
  handler: async (ctx, args) => {
    requireTokenPermission(args.caller, "app.read");
    const view = await appStatus(ctx, args.app, Date.now());
    if (view === null) return null;
    const deployments = await ctx.db
      .query("appDeployments")
      .withIndex("by_app_startedAt", (q) => q.eq("app", args.app))
      .order("desc")
      .take(5);
    return {
      ...view,
      env: await appEnv(ctx, args.app),
      deployments: deployments.map((d) => ({
        id: d._id,
        operation: d.operation ?? null,
        stage: d.stage,
        detail: d.detail,
        error: d.error ?? null,
        startedAt: d.startedAt,
        finishedAt: d.finishedAt ?? null,
      })),
    };
  },
});

export const apiEnv = internalQuery({
  args: { caller: apiCallerValidator, app: v.string() },
  handler: async (ctx, args) => {
    requireTokenPermission(args.caller, "app.read");
    return appEnv(ctx, args.app);
  },
});

export const apiLinks = internalQuery({
  args: { caller: apiCallerValidator },
  handler: async (ctx, args) => {
    requireTokenPermission(args.caller, "app.read");
    return listLinkViews(ctx, Date.now());
  },
});

export const apiEnroll = internalMutation({
  args: { caller: apiCallerValidator, name: v.string() },
  handler: async (ctx, args) => {
    const { actor } = requireTokenPermission(args.caller, "node.admin");
    return audited(ctx, { actor, action: "nodes.enroll", target: args.name }, async () => {
      const enrolled = await enrollNode(ctx, { name: args.name, actor });
      return { ...enrolled, name: args.name.trim() };
    });
  },
});

/**
 * Revoke one credential of a Node (by its id or hint), or every live one. Revoking them all takes
 * the Node out of the mesh: its endpoint is cleared and peers drop it on their next snapshot.
 */
export const apiRevoke = internalMutation({
  args: { caller: apiCallerValidator, node: v.string(), credential: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { actor } = requireTokenPermission(args.caller, "node.admin");
    return audited(
      ctx,
      { actor, action: "nodes.revokeCredential", target: args.node },
      async () => {
        const node = await requireNodeNamed(ctx, args.node);
        const credentials = await ctx.db
          .query("nodeCredentials")
          .withIndex("by_node", (q) => q.eq("nodeId", node._id))
          .take(50);
        const chosen =
          args.credential === undefined
            ? credentials.filter((c) => c.revokedAt === undefined)
            : credentials.filter((c) => c._id === args.credential || c.hint === args.credential);
        if (args.credential !== undefined && chosen.length === 0) {
          throw new ConvexError(`${node.name} has no credential ${args.credential}`);
        }
        const revoked = [];
        for (const c of chosen)
          if (await revokeNodeCredential(ctx, c._id, actor)) revoked.push(c.hint);
        return { node: node.name, revoked };
      },
    );
  },
});

export const apiResetEndpoint = internalMutation({
  args: { caller: apiCallerValidator, node: v.string() },
  handler: async (ctx, args) => {
    const { actor } = requireTokenPermission(args.caller, "node.admin");
    return audited(ctx, { actor, action: "nodes.resetEndpoint", target: args.node }, async () => {
      const node = await requireNodeNamed(ctx, args.node);
      await resetNodeEndpoint(ctx, node._id, actor);
      return { node: node.name };
    });
  },
});

/** Replace a Node's placement roles; an empty list clears them (infra/ingress.ts reads `gateway`). */
export const apiSetRoles = internalMutation({
  args: { caller: apiCallerValidator, node: v.string(), roles: v.array(v.string()) },
  handler: async (ctx, args) => {
    const { actor } = requireTokenPermission(args.caller, "node.admin");
    return audited(
      ctx,
      { actor, action: "nodes.setPlacementRoles", target: args.node },
      async () => {
        const unknown = args.roles.find((r) => !(PLACEMENT_ROLES as readonly string[]).includes(r));
        if (unknown !== undefined) {
          throw new ConvexError(
            `${unknown} is not a placement role (${PLACEMENT_ROLES.join(", ")})`,
          );
        }
        const node = await requireNodeNamed(ctx, args.node);
        const roles = await setNodePlacementRoles(ctx, {
          nodeId: node._id,
          roles: args.roles as (typeof PLACEMENT_ROLES)[number][],
          actor,
        });
        return { node: node.name, placementRoles: roles };
      },
    );
  },
});

export const apiSetEnv = internalMutation({
  args: {
    caller: apiCallerValidator,
    app: v.string(),
    service: v.optional(v.string()),
    vars: v.record(v.string(), v.string()),
  },
  handler: async (ctx, args) => {
    const { actor } = requireTokenPermission(args.caller, "app.deploy");
    return audited(ctx, { actor, action: "env.set", target: args.app }, async () => {
      if (Object.keys(args.vars).length === 0) throw new ConvexError("Set at least one variable");
      await setSecrets(ctx, {
        app: args.app,
        ...(args.service === undefined ? {} : { service: args.service }),
        vars: args.vars,
        actor,
      });
      return { names: Object.keys(args.vars).toSorted() };
    });
  },
});

export const apiUnsetEnv = internalMutation({
  args: {
    caller: apiCallerValidator,
    app: v.string(),
    service: v.optional(v.string()),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const { actor } = requireTokenPermission(args.caller, "app.deploy");
    return audited(ctx, { actor, action: "env.unset", target: args.app }, async () => ({
      removed: await unsetSecret(ctx, {
        app: args.app,
        ...(args.service === undefined ? {} : { service: args.service }),
        name: args.name,
        actor,
      }),
    }));
  },
});

export const apiLink = internalMutation({
  args: {
    caller: apiCallerValidator,
    name: v.optional(v.string()),
    provider: v.string(),
    providerPort: v.number(),
    consumer: v.string(),
    localPort: v.optional(v.number()),
  },
  handler: async (ctx, { caller, ...args }) => {
    const { actor } = requireTokenPermission(caller, "app.deploy");
    return audited(ctx, { actor, action: "mesh.link", target: args.name }, () =>
      declareLink(ctx, { ...args, actor }),
    );
  },
});

export const apiUnlink = internalMutation({
  args: { caller: apiCallerValidator, name: v.string() },
  handler: async (ctx, args) => {
    const { actor } = requireTokenPermission(args.caller, "app.deploy");
    return audited(ctx, { actor, action: "mesh.unlink", target: args.name }, () =>
      removeLink(ctx, { name: args.name, actor }),
    );
  },
});

export const apiRemoveApp = internalMutation({
  args: { caller: apiCallerValidator, app: v.string() },
  handler: async (ctx, args) => {
    const { actor } = requireTokenPermission(args.caller, "app.deploy");
    return audited(ctx, { actor, action: "apps.remove", target: args.app }, () =>
      removeApp(ctx, { app: args.app, actor }),
    );
  },
});
