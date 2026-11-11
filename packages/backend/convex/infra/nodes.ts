// Nodes and their enrollment credentials.
//
// On the Hub a Node's id was whatever it claimed in its `hello`, and its credential was an
// ordinary `operator` API token any CLI user could also hold. Here an operator enrolls a Node by
// name and gets a credential bound to that one Node; the Node later registers the iroh EndpointId
// that phase 1 gives it, which ADR 0016 makes its identity.
import { ConvexError, v, type Infer } from "convex/values";

import type { Id } from "../_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { hashApiToken } from "../apiTokenPolicy";
import { requirePermission } from "./access";
import { appendAudit } from "./auditLog";
import {
  isEndpointId,
  isValidName,
  isWellFormedNodeCredential,
  newNodeCredential,
  NODE_CREDENTIAL_PREFIX,
} from "./policy";
import { endpointAddrValidator, placementRoleValidator } from "./tables";

const HINT_LENGTH = NODE_CREDENTIAL_PREFIX.length + 8;

export async function nodeByName(ctx: MutationCtx, name: string) {
  return await ctx.db
    .query("nodes")
    .withIndex("by_name", (q) => q.eq("name", name))
    .unique();
}

/** The Node named `name`, created if absent. Used by enrollment and by the Hub importer. */
export async function ensureNode(
  ctx: MutationCtx,
  name: string,
  source: "enrolled" | "hub-import",
  createdAt = Date.now(),
) {
  const existing = await nodeByName(ctx, name);
  if (existing !== null) return existing._id;
  return await ctx.db.insert("nodes", { name, source, createdAt });
}

async function issueCredential(
  ctx: MutationCtx,
  nodeId: Id<"nodes">,
  createdBy: Id<"users"> | undefined,
) {
  const token = newNodeCredential();
  await ctx.db.insert("nodeCredentials", {
    nodeId,
    tokenHash: await hashApiToken(token),
    hint: token.slice(0, HINT_LENGTH),
    createdAt: Date.now(),
    ...(createdBy === undefined ? {} : { createdBy }),
  });
  return token;
}

/**
 * Enroll a Node, or issue another credential for one already enrolled. The credential is returned
 * once. An older credential stays live until revoked, so a Node can be moved to a new one without
 * a gap. The dashboard (`enroll`) and the operator API (infra/operator.ts) both run this.
 */
export async function enrollNode(
  ctx: MutationCtx,
  input: { name: string; actor: string; createdBy?: Id<"users"> },
) {
  const name = input.name.trim();
  if (!isValidName(name)) {
    throw new ConvexError("Name the Node with letters, digits, dots, dashes or underscores");
  }
  const nodeId = await ensureNode(ctx, name, "enrolled");
  const credential = await issueCredential(ctx, nodeId, input.createdBy);
  await appendAudit(ctx, {
    actor: input.actor,
    action: "nodes.enroll",
    target: name,
    outcome: "success",
  });
  return { nodeId, credential };
}

export const enroll = mutation({
  args: { name: v.string() },
  returns: v.object({ nodeId: v.id("nodes"), credential: v.string() }),
  handler: async (ctx, args) => {
    const { user, actor } = await requirePermission(ctx, "node.admin");
    return await enrollNode(ctx, { name: args.name, actor, createdBy: user._id });
  },
});

/**
 * Revoke one credential and return whether it was live. Revoking a Node's last live credential
 * also clears its endpoint, so the Node leaves every peer's mesh snapshot at once.
 */
export async function revokeNodeCredential(
  ctx: MutationCtx,
  credentialId: Id<"nodeCredentials">,
  actor: string,
) {
  const credential = await ctx.db.get(credentialId);
  if (credential === null) throw new ConvexError("No such credential");
  if (credential.revokedAt !== undefined) return false;
  await ctx.db.patch(credential._id, { revokedAt: Date.now() });
  await appendAudit(ctx, {
    actor,
    action: "nodes.revokeCredential",
    target: credential.hint,
    outcome: "success",
  });
  // Revoking the last live credential revokes the Node's mesh identity with it. Re-enrolling
  // the Node issues a new credential, and the Node must then prove its endpoint key again
  // before any peer is granted to it. Rotation (issue the new credential, then revoke the old
  // one) never reaches this branch, so it keeps the endpoint.
  const node = await ctx.db.get(credential.nodeId);
  if (node !== null && !(await hasLiveCredential(ctx, node._id))) {
    await clearEndpoint(ctx, node._id);
    if (node.endpointId !== undefined) {
      await appendAudit(ctx, {
        actor,
        action: "nodes.resetEndpoint",
        target: node.name,
        outcome: "success",
        meta: { endpointId: node.endpointId, reason: "last credential revoked" },
      });
    }
  }
  return true;
}

export const revokeCredential = mutation({
  args: { credentialId: v.id("nodeCredentials") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { actor } = await requirePermission(ctx, "node.admin");
    await revokeNodeCredential(ctx, args.credentialId, actor);
    return null;
  },
});

/** Whether any unrevoked credential is bound to this Node. */
export async function hasLiveCredential(ctx: QueryCtx, nodeId: Id<"nodes">) {
  const live = await ctx.db
    .query("nodeCredentials")
    .withIndex("by_node", (q) => q.eq("nodeId", nodeId))
    .filter((q) => q.eq(q.field("revokedAt"), undefined))
    .first();
  return live !== null;
}

/**
 * Forget a Node's endpoint registration and every challenge issued for it, so a challenge signed
 * before the reset cannot restore the old key afterwards.
 */
async function clearEndpoint(ctx: MutationCtx, nodeId: Id<"nodes">) {
  await ctx.db.patch(nodeId, {
    endpointId: undefined,
    endpointAddr: undefined,
    endpointUpdatedAt: undefined,
    meshAddress: undefined,
    endpointProvenAt: undefined,
  });
  const pending = await ctx.db
    .query("nodeEndpointChallenges")
    .withIndex("by_node", (q) => q.eq("nodeId", nodeId))
    .take(16);
  for (const row of pending) await ctx.db.delete(row._id);
}

/**
 * Clear a Node's registered EndpointId, so it can register a new key. Needed when a Node lost its
 * key file: a Node cannot replace its own identity, or a stolen credential could take over another
 * Node's place in the mesh.
 */
export async function resetNodeEndpoint(ctx: MutationCtx, nodeId: Id<"nodes">, actor: string) {
  const node = await ctx.db.get(nodeId);
  if (node === null) throw new ConvexError("No such Node");
  await clearEndpoint(ctx, node._id);
  await appendAudit(ctx, {
    actor,
    action: "nodes.resetEndpoint",
    target: node.name,
    outcome: "success",
    ...(node.endpointId === undefined ? {} : { meta: { endpointId: node.endpointId } }),
  });
}

export const resetEndpoint = mutation({
  args: { nodeId: v.id("nodes") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { actor } = await requirePermission(ctx, "node.admin");
    await resetNodeEndpoint(ctx, args.nodeId, actor);
    return null;
  },
});

/**
 * Set a Node's placement roles. Marking a Node `gateway` gives it, on its next snapshot, the
 * route table and a mesh link to every routed App, and adds it to the `allowed_peers` of each
 * App's ingress exposure (infra/ingress.ts). Removing the role revokes both on the next snapshot.
 * Only an owner or admin may do this; a Node cannot declare its own roles.
 */
export async function setNodePlacementRoles(
  ctx: MutationCtx,
  input: { nodeId: Id<"nodes">; roles: Infer<typeof placementRoleValidator>[]; actor: string },
) {
  const node = await ctx.db.get(input.nodeId);
  if (node === null) throw new ConvexError("No such Node");
  const roles = [...new Set(input.roles)].toSorted();
  await ctx.db.patch(node._id, { placementRoles: roles });
  await appendAudit(ctx, {
    actor: input.actor,
    action: "nodes.setPlacementRoles",
    target: node.name,
    outcome: "success",
    meta: { from: node.placementRoles ?? [], to: roles },
  });
  return roles;
}

export const setPlacementRoles = mutation({
  args: { nodeId: v.id("nodes"), roles: v.array(placementRoleValidator) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { actor } = await requirePermission(ctx, "node.admin");
    await setNodePlacementRoles(ctx, { ...args, actor });
    return null;
  },
});

/** Shared by every Node API transaction; revocation is checked again at commit, not cached. */
export async function authenticateNode(ctx: QueryCtx, credential: string) {
  if (!isWellFormedNodeCredential(credential)) return null;
  const tokenHash = await hashApiToken(credential);
  const row = await ctx.db
    .query("nodeCredentials")
    .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
    .unique();
  if (row === null || row.revokedAt !== undefined) return null;
  return { nodeId: row.nodeId, credentialId: row._id };
}

export async function requireNode(ctx: QueryCtx, credential: string) {
  const principal = await authenticateNode(ctx, credential);
  if (principal === null) throw new ConvexError("Unauthorized Node credential");
  return principal;
}

/** The Node a presented credential belongs to, or null for an unknown or revoked one. */
export const authenticate = internalQuery({
  args: { credential: v.string() },
  returns: v.union(
    v.null(),
    v.object({ nodeId: v.id("nodes"), credentialId: v.id("nodeCredentials") }),
  ),
  handler: async (ctx, args) => {
    return await authenticateNode(ctx, args.credential);
  },
});

/**
 * A Node publishes its iroh EndpointId and EndpointAddr. The id is set once and is unique across
 * Nodes; the address (relay URL, direct addresses) changes as the Node moves between networks and
 * is replaced on every call. Called by the Node-facing endpoint in phase 2b with the Node the
 * credential authenticated, never with a Node id the caller chose.
 */
export const registerEndpoint = internalMutation({
  args: { nodeId: v.id("nodes"), endpointId: v.string(), endpointAddr: endpointAddrValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!isEndpointId(args.endpointId)) throw new ConvexError("Not an iroh EndpointId");
    const node = await ctx.db.get(args.nodeId);
    if (node === null) throw new ConvexError("No such Node");
    if (node.endpointId !== undefined && node.endpointId !== args.endpointId) {
      throw new ConvexError(
        `${node.name} is registered as ${node.endpointId}; an operator must reset it before it can register another key`,
      );
    }
    const other = await ctx.db
      .query("nodes")
      .withIndex("by_endpointId", (q) => q.eq("endpointId", args.endpointId))
      .first();
    if (other !== null && other._id !== node._id) {
      throw new ConvexError(`EndpointId ${args.endpointId} already belongs to ${other.name}`);
    }
    const first = node.endpointId === undefined;
    await ctx.db.patch(node._id, {
      endpointId: args.endpointId,
      endpointAddr: args.endpointAddr,
      endpointUpdatedAt: Date.now(),
    });
    if (first) {
      await appendAudit(ctx, {
        actor: `node:${node._id}`,
        action: "nodes.registerEndpoint",
        target: node.name,
        outcome: "success",
        meta: { endpointId: args.endpointId },
      });
    }
    return null;
  },
});

export const list = query({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("nodes"),
      name: v.string(),
      source: v.union(v.literal("enrolled"), v.literal("hub-import")),
      createdAt: v.number(),
      endpointId: v.optional(v.string()),
      endpointAddr: v.optional(endpointAddrValidator),
      endpointUpdatedAt: v.optional(v.number()),
      placementRoles: v.array(placementRoleValidator),
      credentials: v.array(
        v.object({
          _id: v.id("nodeCredentials"),
          hint: v.string(),
          createdAt: v.number(),
          lastUsedAt: v.optional(v.number()),
          revokedAt: v.optional(v.number()),
        }),
      ),
    }),
  ),
  handler: async (ctx) => {
    await requirePermission(ctx, "app.read");
    const nodes = await ctx.db.query("nodes").collect();
    return await Promise.all(
      nodes.map(async (node) => {
        const credentials = await ctx.db
          .query("nodeCredentials")
          .withIndex("by_node", (q) => q.eq("nodeId", node._id))
          .collect();
        return {
          _id: node._id,
          name: node.name,
          source: node.source,
          createdAt: node.createdAt,
          endpointId: node.endpointId,
          endpointAddr: node.endpointAddr,
          endpointUpdatedAt: node.endpointUpdatedAt,
          placementRoles: node.placementRoles ?? [],
          credentials: credentials.map((credential) => ({
            _id: credential._id,
            hint: credential.hint,
            createdAt: credential.createdAt,
            lastUsedAt: credential.lastUsedAt,
            revokedAt: credential.revokedAt,
          })),
        };
      }),
    );
  },
});
