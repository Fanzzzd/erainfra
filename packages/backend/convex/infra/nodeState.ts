import { ed25519 } from "@noble/curves/ed25519.js";
import { ConvexError, v } from "convex/values";
import type { Id, Doc } from "../_generated/dataModel";
import { internalMutation, internalQuery, type QueryCtx } from "../_generated/server";
import { hasLiveCredential, requireNode } from "./nodes";
import { meshAddress } from "./nodeCommandModel";
import { hashApiToken } from "../apiTokenPolicy";

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
    const peer = await ctx.db.get(peerId);
    // A peer is granted only while its endpoint key is proven and it still holds a live
    // credential. Revoking the last credential also clears the endpoint (nodes.revokeCredential);
    // this check keeps a revoked Node out even if a row predates that rule.
    if (
      !peer?.meshAddress ||
      peer.endpointProvenAt === undefined ||
      peer.endpointId !== peer.meshAddress.id ||
      !(await hasLiveCredential(ctx, peer._id))
    )
      continue;
    peers.set(peer.meshAddress.id, peer.meshAddress);
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
      if (!exposure.allowed_peers.includes(peer.meshAddress.id))
        exposure.allowed_peers.push(peer.meshAddress.id);
      expose.set(link.name, exposure);
    } else {
      const next = {
        name: link.name,
        peer: peer.meshAddress.id,
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
  const listeners = [...outgoing.values()].toSorted((a, b) => a.name.localeCompare(b.name));
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
    exposures: [...expose.values()]
      .map((e) => ({ ...e, allowed_peers: e.allowed_peers.toSorted() }))
      .toSorted((a, b) => a.name.localeCompare(b.name)),
    links: listeners,
  };
}
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
