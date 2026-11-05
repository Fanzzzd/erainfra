import { ed25519 } from "@noble/curves/ed25519.js";
import { ConvexError, v } from "convex/values";
import type { Id, Doc } from "../_generated/dataModel";
import { internalMutation, internalQuery, type QueryCtx } from "../_generated/server";
import { hasLiveCredential, requireNode } from "./nodes";
import { meshAddress } from "./nodeCommandModel";
import { hashApiToken } from "../apiTokenPolicy";
import {
  INGRESS_MAX_CONNECTIONS,
  INGRESS_ROUTE_READ_LIMIT,
  MESH_EXPOSURE_LIMIT,
  MESH_LINK_LIMIT,
  ingressPorts,
  ingressServiceName,
  isRouteLabel,
} from "./ingress";

export const heartbeat = internalMutation({
  args: { credential: v.string(), version: v.string() },
  handler: async (ctx, args) => {
    const { nodeId } = await requireNode(ctx, args.credential);
    if (args.version.length > 100) throw new ConvexError("Version too long");
    await ctx.db.patch(nodeId, { lastSeenAt: Date.now(), infraAgentVersion: args.version });
    const node = await ctx.db.get(nodeId);
    // The Node's own registered key (public), so the Infra Agent can tell a key it may publish
    // from one Convex will refuse, and notice an operator reset, without retrying a refusal.
    return { nodeId, heartbeatAfterMs: 15000, endpointId: node?.endpointId ?? null };
  },
});

/**
 * Refusals the Infra Agent must surface and stop retrying, because only an operator can clear
 * them. nodeHttp returns the code as the 409 body; every other refusal stays an opaque
 * `request_refused`.
 */
export const ENDPOINT_REFUSALS = ["endpoint_key_changed", "endpoint_in_use"] as const;
type EndpointRefusal = (typeof ENDPOINT_REFUSALS)[number];
function refuse(code: EndpointRefusal, message: string): never {
  throw new ConvexError({ code, message });
}
async function assertEndpointAvailable(ctx: QueryCtx, nodeId: Id<"nodes">, endpointId: string) {
  const node = await ctx.db.get(nodeId);
  if (!node) throw new ConvexError("No such Node");
  if (node.endpointId !== undefined && node.endpointId !== endpointId)
    refuse("endpoint_key_changed", "Operator must reset the endpoint before changing its key");
  const other = await ctx.db
    .query("nodes")
    .withIndex("by_endpointId", (q) => q.eq("endpointId", endpointId))
    .first();
  if (other && other._id !== nodeId)
    refuse("endpoint_in_use", "Endpoint already registered to another Node");
}

// The Infra Agent has its erainfra-mesh sidecar sign `message` with `sign_challenge`; status
// alone is never treated as proof of possession.
export const challenge = internalMutation({
  args: { credential: v.string(), address: meshAddress },
  handler: async (ctx, args) => {
    const { nodeId, credentialId } = await requireNode(ctx, args.credential);
    const a = args.address;
    if (
      !/^[0-9a-f]{64}$/.test(a.id) ||
      a.relay_urls.length > 8 ||
      a.direct_addrs.length > 16 ||
      a.direct_addrs.some((x) => x.length > 128)
    )
      throw new ConvexError("Invalid endpoint address");
    for (const relay of a.relay_urls) {
      if (relay.length > 512) throw new ConvexError("Invalid relay URL");
      const u = new URL(relay);
      if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash)
        throw new ConvexError("Invalid relay URL");
    }
    // Refuse a key change before issuing a challenge, so the Node learns it without signing.
    await assertEndpointAvailable(ctx, nodeId, a.id);
    const old = await ctx.db
      .query("nodeEndpointChallenges")
      .withIndex("by_node", (q) => q.eq("nodeId", nodeId))
      .take(2);
    for (const row of old) await ctx.db.delete(row._id);
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    const message = `erainfra/node-endpoint/v1\n${JSON.stringify({ nodeId, credentialId, nonce, address: a })}`;
    if (new TextEncoder().encode(message).length > 4096)
      throw new ConvexError("Endpoint challenge exceeds sidecar limit");
    const expiresAt = Date.now() + 60000;
    const challengeId = await ctx.db.insert("nodeEndpointChallenges", {
      nodeId,
      credentialId,
      address: a,
      message,
      expiresAt,
    });
    return {
      challengeId,
      message,
      expiresAt,
      algorithm: "Ed25519",
      encoding: "UTF-8",
      signatureEncoding: "base64",
    };
  },
});
export const publish = internalMutation({
  args: {
    credential: v.string(),
    challengeId: v.id("nodeEndpointChallenges"),
    signature: v.string(),
  },
  handler: async (ctx, args) => {
    const { nodeId, credentialId } = await requireNode(ctx, args.credential);
    const proof = await ctx.db.get(args.challengeId);
    if (
      !proof ||
      proof.nodeId !== nodeId ||
      proof.credentialId !== credentialId ||
      proof.expiresAt <= Date.now()
    )
      throw new ConvexError("Invalid endpoint challenge");
    let valid = false;
    try {
      const raw = Uint8Array.from(proof.address.id.match(/../g)!, (h) => Number.parseInt(h, 16));
      const signature = Uint8Array.from(atob(args.signature), (c) => c.charCodeAt(0));
      if (signature.length === 64) {
        // Pure verifier: Convex's runtime docs do not promise WebCrypto Ed25519 support.
        valid = ed25519.verify(signature, new TextEncoder().encode(proof.message), raw, {
          zip215: false,
        });
      }
    } catch {
      valid = false;
    }
    if (!valid) throw new ConvexError("Invalid endpoint signature");
    await assertEndpointAvailable(ctx, nodeId, proof.address.id);
    await ctx.db.patch(nodeId, {
      endpointId: proof.address.id,
      meshAddress: proof.address,
      endpointProvenAt: Date.now(),
      endpointUpdatedAt: Date.now(),
      // Explicit conversion to the old phase-2a schema for readers that still use it. Canonical
      // meshAddress retains *all* relay URLs; the old singular field can only represent the first.
      endpointAddr: {
        relayUrl: proof.address.relay_urls[0],
        directAddresses: proof.address.direct_addrs,
      },
    });
    await ctx.db.delete(proof._id);
    return { published: true };
  },
});

/** Explicit legacy conversion, never used to grant mesh access without a possession proof. */
export function legacyEndpointAddress(node: Pick<Doc<"nodes">, "endpointId" | "endpointAddr">) {
  return node.endpointId === undefined
    ? null
    : {
        id: node.endpointId,
        relay_urls: node.endpointAddr?.relayUrl === undefined ? [] : [node.endpointAddr.relayUrl],
        direct_addrs: node.endpointAddr?.directAddresses ?? [],
      };
}
async function desired(ctx: QueryCtx, nodeId: Id<"nodes">) {
  // Bounded administrative dimensions. Refuse an oversized snapshot rather than silently omit
  // grants or return an unbounded response. No all-fleet list is ever sent to a Node.
  const standalone = await ctx.db.query("meshLinks").take(501);
  const apps = await ctx.db.query("apps").take(501);
  if (standalone.length > 500 || apps.length > 500)
    throw new ConvexError("Mesh configuration exceeds the 500-App/link snapshot limit");
  // App dependency links (from the deploy pipeline's plan) are marked so their consumer listens
  // where a container can reach it; standalone links stay on loopback.
  const links = [
    ...standalone.map((l) => ({ ...l, forApp: false })),
    ...apps.flatMap((a) => a.links.map((l) => ({ ...l, forApp: true }))),
  ];
  if (links.length > 2000) throw new ConvexError("Mesh link limit exceeded");
  const relevant = links.filter(
    (l) =>
      (l.providerNodeId === nodeId || l.consumerNodeId === nodeId) &&
      l.providerNodeId !== l.consumerNodeId,
  );
  const peers = new Map<string, NonNullable<Doc<"nodes">["meshAddress"]>>();
  const expose = new Map<string, { name: string; target: string; allowed_peers: string[] }>();
  const outgoing = new Map<
    string,
    {
      name: string;
      peer: string;
      service: string;
      listen: string;
    }
  >();
  for (const link of relevant) {
    if (
      !/^[A-Za-z0-9._-]{1,64}$/.test(link.name) ||
      ![link.providerPort, link.localPort].every((p) => Number.isInteger(p) && p > 0 && p <= 65535)
    )
      throw new ConvexError("Invalid stored mesh link");
    const peerId = link.providerNodeId === nodeId ? link.consumerNodeId : link.providerNodeId;
    const peer = await grantable(ctx, await ctx.db.get(peerId));
    if (peer === null) continue;
    peers.set(peer.id, peer);
    if (link.providerNodeId === nodeId) {
      const target = `127.0.0.1:${link.providerPort}`;
      const previous = expose.get(link.name);
      if (previous && previous.target !== target)
        throw new ConvexError("Conflicting mesh exposure name");
      const exposure = previous ?? {
        name: link.name,
        target,
        allowed_peers: [],
      };
      if (!exposure.allowed_peers.includes(peer.id)) exposure.allowed_peers.push(peer.id);
      expose.set(link.name, exposure);
    } else {
      const next = {
        name: link.name,
        peer: peer.id,
        service: link.name,
        // A service reaches its dependency at host.docker.internal:<localPort>, which
        // `--add-host host.docker.internal:host-gateway` resolves to the Docker bridge gateway.
        // Convex cannot know that address, so an App link names the scope, `bridge:<port>`, and
        // the Infra Agent binds the Node's own gateway address: reachable from the host and its
        // containers, never from the Node's other networks. The Hub bound these on 0.0.0.0.
        listen: link.forApp ? `bridge:${link.localPort}` : `127.0.0.1:${link.localPort}`,
      };
      const previous = outgoing.get(link.name);
      if (previous && JSON.stringify(previous) !== JSON.stringify(next)) {
        throw new ConvexError("Conflicting mesh link name");
      }
      outgoing.set(link.name, next);
    }
  }
  const self = await ctx.db.get(nodeId);
  const ingress = await ingressFor(ctx, {
    nodeId,
    isGateway: self?.placementRoles?.includes("gateway") ?? false,
    apps,
    exposureBudget: MESH_EXPOSURE_LIMIT - expose.size,
    linkBudget: MESH_LINK_LIMIT - outgoing.size,
  });
  for (const peer of ingress.peers) peers.set(peer.id, peer);
  for (const name of [...ingress.exposures.map((e) => e.name), ...ingress.links.map((l) => l.name)])
    if (expose.has(name) || outgoing.has(name))
      throw new ConvexError("Mesh link name collides with an ingress name");
  const listeners = [...outgoing.values(), ...ingress.links].toSorted((a, b) =>
    a.name.localeCompare(b.name),
  );
  return {
    // Version 2 adds a scoped listener, `bridge:<port>`, which a version-1 Infra Agent cannot
    // bind. It refuses a version it does not know and keeps its last snapshot, so it fails closed;
    // a snapshot without a scoped listener stays version 1 for those agents.
    v: listeners.some((l) => l.listen.startsWith("bridge:")) ? 2 : 1,
    // Full replacement snapshot. The future sidecar reconciler must unexpose/unlink absent names.
    fleet: [...peers.values()].toSorted((a, b) => a.id.localeCompare(b.id)),
    relays: {
      relays: self?.meshAddress?.relay_urls ?? [],
      n0_fallback: false,
    },
    exposures: [
      ...[...expose.values()].map((e) => ({ ...e, allowed_peers: e.allowed_peers.toSorted() })),
      ...ingress.exposures,
    ].toSorted((a, b) => a.name.localeCompare(b.name)),
    links: listeners,
    // Present only on a gateway Node: the routes its proxy serves, under the same revision as the
    // links that carry them. An absent `ingress` means "serve no routes".
    ...(ingress.routes === null
      ? {}
      : {
          ingress: {
            routes: ingress.routes,
            ...(ingress.overflow > 0 ? { overflow: ingress.overflow } : {}),
          },
        }),
  };
}

type MeshAddress = NonNullable<Doc<"nodes">["meshAddress"]>;

/**
 * A Node's mesh address, if it may be granted anything: its endpoint key is proven and it still
 * holds a live credential. Revoking the last credential also clears the endpoint
 * (nodes.revokeCredential); the credential check keeps a revoked Node out even if a row predates
 * that rule.
 */
async function grantable(ctx: QueryCtx, node: Doc<"nodes"> | null): Promise<MeshAddress | null> {
  if (
    !node?.meshAddress ||
    node.endpointProvenAt === undefined ||
    node.endpointId !== node.meshAddress.id ||
    !(await hasLiveCredential(ctx, node._id))
  )
    return null;
  return node.meshAddress;
}

/**
 * The ingress part of a Node's snapshot (infra/ingress.ts).
 *
 * A route is served only while its row names the placement the App actually runs: the port must be
 * allocated on the route's Node to the service whose `route` it is (key `<app>/<service>`), and
 * the App row must place that service on that Node at that port. Otherwise the route is refused:
 * no exposure on the App's Node and no upstream at the gateways (503). A stale row would otherwise
 * point the exposure at a port that another App may now hold on that Node.
 *
 * An App Node reads only the routes on itself (index `by_node`) and exposes each accepted one to
 * exactly the grantable gateways. A gateway reads the whole table and links to each accepted
 * route; a route whose Node cannot be granted stays in its table with no upstream. Route count
 * never refuses a snapshot: what does not fit a Node's mesh budget is left out and counted in
 * `ingress.overflow` on gateways (docs/infra-management.md).
 */
async function ingressFor(
  ctx: QueryCtx,
  input: {
    nodeId: Id<"nodes">;
    isGateway: boolean;
    apps: Doc<"apps">[];
    exposureBudget: number;
    linkBudget: number;
  },
) {
  const { nodeId, isGateway } = input;
  const peers = new Map<string, MeshAddress>();
  const exposures: IngressExposure[] = [];
  const links: IngressLink[] = [];
  const nodes = await ctx.db.query("nodes").take(1001);
  if (nodes.length > 1000) throw new ConvexError("Ingress exceeds the 1000-Node snapshot limit");
  const gatewayNodes = nodes.filter((n) => n.placementRoles?.includes("gateway"));
  if (gatewayNodes.length === 0)
    return { peers: [], exposures, links, routes: isGateway ? [] : null, overflow: 0 };
  const owners = routeOwners(input.apps);
  const accepted = (route: Doc<"appRoutes">) => servesPlacement(ctx, route, owners);

  // Provider side: this Node runs routed Apps, and the gateways (other than itself) reach them.
  const hosted = (
    await ctx.db
      .query("appRoutes")
      .withIndex("by_node", (q) => q.eq("nodeId", nodeId))
      .take(INGRESS_ROUTE_READ_LIMIT)
  ).toSorted((a, b) => a._creationTime - b._creationTime);
  if (hosted.length > 0) {
    const allowed: MeshAddress[] = [];
    for (const gateway of gatewayNodes) {
      if (gateway._id === nodeId) continue;
      const address = await grantable(ctx, gateway);
      if (address !== null) allowed.push(address);
    }
    if (allowed.length > 0) {
      const ids = allowed.map((p) => p.id).toSorted();
      for (const route of hosted) {
        if (exposures.length >= input.exposureBudget) break;
        if (!isRouteLabel(route.name) || !(await accepted(route))) continue;
        exposures.push({
          name: ingressServiceName(route.name),
          target: `127.0.0.1:${route.port}`,
          allowed_peers: ids,
          max_connections: INGRESS_MAX_CONNECTIONS,
        });
      }
      if (exposures.length > 0) for (const peer of allowed) peers.set(peer.id, peer);
    }
  }
  if (!isGateway)
    return { peers: [...peers.values()], exposures, links, routes: null, overflow: 0 };

  // Consumer side: this Node is a gateway and links to every accepted route's Node.
  const rows = await ctx.db.query("appRoutes").take(INGRESS_ROUTE_READ_LIMIT + 1);
  let overflow = Math.max(0, rows.length - INGRESS_ROUTE_READ_LIMIT);
  const routes = rows
    .slice(0, INGRESS_ROUTE_READ_LIMIT)
    .filter((r) => isRouteLabel(r.name))
    .toSorted((a, b) => a._creationTime - b._creationTime || a.name.localeCompare(b.name));
  const ports = ingressPorts(routes.map((r) => ({ name: r.name, createdAt: r._creationTime })));
  const table: { host: string; upstream: string | null }[] = [];
  const appNodes = new Map<Id<"nodes">, MeshAddress | null>();
  for (const route of routes) {
    if (!(await accepted(route))) {
      table.push({ host: route.name, upstream: null });
      continue;
    }
    if (route.nodeId === nodeId) {
      table.push({ host: route.name, upstream: `127.0.0.1:${route.port}` });
      continue;
    }
    if (!appNodes.has(route.nodeId))
      appNodes.set(route.nodeId, await grantable(ctx, await ctx.db.get(route.nodeId)));
    const target = appNodes.get(route.nodeId) ?? null;
    const port = ports.get(route.name);
    if (target === null) {
      table.push({ host: route.name, upstream: null });
      continue;
    }
    if (port === undefined || links.length >= input.linkBudget) {
      overflow += 1;
      table.push({ host: route.name, upstream: null });
      continue;
    }
    peers.set(target.id, target);
    const listen = `127.0.0.1:${port}`;
    const name = ingressServiceName(route.name);
    links.push({
      name,
      peer: target.id,
      service: name,
      listen,
      max_connections: INGRESS_MAX_CONNECTIONS,
    });
    table.push({ host: route.name, upstream: listen });
  }
  return {
    peers: [...peers.values()],
    exposures,
    links,
    routes: table.toSorted((a, b) => a.host.localeCompare(b.host)),
    overflow,
  };
}

/** Which App service each route label belongs to, and where the App row places it. */
function routeOwners(apps: Doc<"apps">[]) {
  const owners = new Map<
    string,
    { app: string; service: string; nodeId: Id<"nodes">; port?: number }
  >();
  for (const app of apps)
    for (const s of app.services)
      if (s.route !== undefined)
        owners.set(s.route, {
          app: app.name,
          service: s.name,
          nodeId: s.nodeId ?? app.nodeId,
          ...(s.port === undefined ? {} : { port: s.port }),
        });
  return owners;
}

/**
 * Whether a route row names the placement its App runs: the App row places the route's service on
 * the route's Node at the route's port, and that port is allocated on that Node to that service.
 */
async function servesPlacement(
  ctx: QueryCtx,
  route: Doc<"appRoutes">,
  owners: ReturnType<typeof routeOwners>,
) {
  if (!Number.isInteger(route.port) || route.port < 1 || route.port > 65535) return false;
  const owner = owners.get(route.name);
  if (owner === undefined || owner.nodeId !== route.nodeId || owner.port !== route.port)
    return false;
  const allocation = await ctx.db
    .query("portAllocations")
    .withIndex("by_node_port", (q) => q.eq("nodeId", route.nodeId).eq("port", route.port))
    .first();
  return allocation !== null && allocation.key === `${owner.app}/${owner.service}`;
}

type IngressExposure = {
  name: string;
  target: string;
  allowed_peers: string[];
  max_connections: number;
};
type IngressLink = {
  name: string;
  peer: string;
  service: string;
  listen: string;
  max_connections: number;
};
export const state = internalQuery({
  args: { credential: v.string(), revision: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { nodeId } = await requireNode(ctx, args.credential);
    const snapshot = await desired(ctx, nodeId);
    const text = JSON.stringify(snapshot);
    if (new TextEncoder().encode(text).length > 200 * 1024)
      throw new ConvexError("Mesh snapshot too large");
    const revision = await hashApiToken(text);
    return args.revision === revision
      ? { revision, unchanged: true as const }
      : { revision, unchanged: false as const, desired: snapshot };
  },
});
export const pending = internalQuery({
  args: { credential: v.string(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const { nodeId } = await requireNode(ctx, args.credential);
    const page = await ctx.db
      .query("nodeCommands")
      .withIndex("by_node_unsettled", (q) => q.eq("nodeId", nodeId).eq("unsettled", true))
      .paginate({ numItems: 25, cursor: args.cursor });
    return {
      cursor: page.isDone ? null : page.continueCursor,
      commands: page.page
        .filter(
          (c) =>
            c.status === "pending" || (c.status === "running" && (c.leaseUntil ?? 0) <= Date.now()),
        )
        .map((c) => ({ id: c._id, idempotencyKey: c.idempotencyKey, kind: c.command.kind })),
    };
  },
});
