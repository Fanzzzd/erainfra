// Host-port allocation per Node. Every routed service and every link consumer needs a port on its
// Node; two Apps must never share one, and an App must get the same ports back on every redeploy
// because its containers' environment bakes them in.
//
// The Hub's table keyed (node, key) but had no constraint on (node, port), so only its single
// process kept ports apart. Here every allocation reads both indexes and writes in one
// serializable transaction, so neither invariant depends on who calls.
import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation, query, type MutationCtx, type QueryCtx } from "../_generated/server";
import { requirePermission } from "./access";
import { convexWrite, provenanceFor, type HubOrigin, type Provenance } from "./hubProvenance";
import { appOfPortKey, firstFreePort, PORT_RANGE_END, PORT_RANGE_START } from "./policy";

async function byNodeKey(ctx: QueryCtx, nodeId: Id<"nodes">, key: string) {
  return await ctx.db
    .query("portAllocations")
    .withIndex("by_node_key", (q) => q.eq("nodeId", nodeId).eq("key", key))
    .unique();
}

/** Stable per (Node, key): a repeat call returns the port the first one got. */
export async function allocatePort(ctx: MutationCtx, nodeId: Id<"nodes">, key: string) {
  if (key.length === 0) throw new ConvexError("A port key must not be empty");
  const existing = await byNodeKey(ctx, nodeId, key);
  if (existing !== null) return existing.port;
  // Ascending by port, so the first gap is the lowest free port.
  const used = await ctx.db
    .query("portAllocations")
    .withIndex("by_node_port", (q) =>
      q.eq("nodeId", nodeId).gte("port", PORT_RANGE_START).lte("port", PORT_RANGE_END),
    )
    .collect();
  const port = firstFreePort(used.map((row) => row.port));
  if (port === null) {
    throw new ConvexError(
      `No free ports on this Node (${PORT_RANGE_START}-${PORT_RANGE_END} all allocated)`,
    );
  }
  const now = Date.now();
  await insertAllocation(ctx, {
    nodeId,
    key,
    port,
    allocatedAt: now,
    provenance: convexWrite(now),
  });
  return port;
}

/**
 * Record a specific port for (Node, key), as the importer does to keep the Hub's numbers. Refuses
 * a port another key holds, and a key that already holds a different port.
 */
export async function claimPort(
  ctx: MutationCtx,
  input: { nodeId: Id<"nodes">; key: string; port: number; allocatedAt: number },
  hub: HubOrigin,
) {
  const refusal = await claimPortRefusal(ctx, input);
  if (refusal !== null) throw new ConvexError(refusal);
  const existing = await byNodeKey(ctx, input.nodeId, input.key);
  if (existing !== null) return existing.port;
  await insertAllocation(ctx, { ...input, provenance: provenanceFor(input.allocatedAt, hub) });
  return input.port;
}

/**
 * Why `claimPort` would refuse, or null. `nodeId` is null for a Node that does not exist yet, which
 * holds no ports. The importer asks before it creates the Node, so a refused row writes nothing.
 * `nodeName` only names the Node in the reason.
 */
export async function claimPortRefusal(
  ctx: QueryCtx,
  input: { nodeId: Id<"nodes"> | null; key: string; port: number; nodeName?: string },
) {
  if (input.nodeId !== null) {
    const existing = await byNodeKey(ctx, input.nodeId, input.key);
    if (existing !== null)
      return existing.port === input.port
        ? null
        : `Port key ${input.key} already holds ${existing.port}, not ${input.port}`;
  }
  return await portRefusal(ctx, input.nodeId, input.port, input.nodeName);
}

/** Why `port` cannot be recorded on the Node, or null. */
async function portRefusal(
  ctx: QueryCtx,
  nodeId: Id<"nodes"> | null,
  port: number,
  nodeName = "this Node",
) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return `Not a port: ${port}`;
  if (nodeId === null) return null;
  const holder = await ctx.db
    .query("portAllocations")
    .withIndex("by_node_port", (q) => q.eq("nodeId", nodeId).eq("port", port))
    .first();
  return holder === null ? null : `Port ${port} on ${nodeName} is already held by ${holder.key}`;
}

async function insertAllocation(
  ctx: MutationCtx,
  input: {
    nodeId: Id<"nodes">;
    key: string;
    port: number;
    allocatedAt: number;
    provenance: Provenance;
  },
) {
  const refusal = await portRefusal(ctx, input.nodeId, input.port);
  if (refusal !== null) throw new ConvexError(refusal);
  const app = appOfPortKey(input.key);
  await ctx.db.insert("portAllocations", { ...input, ...(app === undefined ? {} : { app }) });
}

/** Free every port an App holds, on every Node. Called when the App is removed. */
export async function releaseAppPorts(ctx: MutationCtx, app: string) {
  const rows = await ctx.db
    .query("portAllocations")
    .withIndex("by_app", (q) => q.eq("app", app))
    .collect();
  for (const row of rows) await ctx.db.delete(row._id);
  return rows.length;
}

export const allocate = internalMutation({
  args: { nodeId: v.id("nodes"), key: v.string() },
  returns: v.number(),
  handler: async (ctx, args) => await allocatePort(ctx, args.nodeId, args.key),
});

export const releaseApp = internalMutation({
  args: { app: v.string() },
  returns: v.number(),
  handler: async (ctx, args) => await releaseAppPorts(ctx, args.app),
});

export const listForNode = query({
  args: { nodeId: v.id("nodes") },
  returns: v.array(v.object({ key: v.string(), port: v.number() })),
  handler: async (ctx, args) => {
    await requirePermission(ctx, "app.read");
    const rows = await ctx.db
      .query("portAllocations")
      .withIndex("by_node_port", (q) => q.eq("nodeId", args.nodeId))
      .collect();
    return rows.map((row) => ({ key: row.key, port: row.port }));
  },
});
