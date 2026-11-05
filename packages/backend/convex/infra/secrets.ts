// App secrets (the Hub's `secrets` table), encrypted with envelope encryption (secretCrypto.ts).
//
// Plaintext leaves Convex by one path only: `forNodeDeploy`, an internal query the Node-facing
// endpoint of phase 2b will call with the Node its credential authenticated. It answers only for a
// deployment that targets that Node, is still running, and still holds its App's lease. Every
// public query returns names and a mask, never a value.
import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import {
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { requirePermission } from "./access";
import { appendAudit } from "./auditLog";
import { isTerminalStage, isValidSecretName, leaseAdmits } from "./policy";
import {
  decryptValue,
  encryptValue,
  newDataKey,
  requireMasterKey,
  unwrapDataKey,
  type MasterKey,
} from "./secretCrypto";

export const MASK = "••••••";

async function dataKeyRow(ctx: QueryCtx, scope: string) {
  return await ctx.db
    .query("appDataKeys")
    .withIndex("by_app", (q) => q.eq("app", scope))
    .unique();
}

async function writableDataKey(ctx: MutationCtx, master: MasterKey, scope: string) {
  const row = await dataKeyRow(ctx, scope);
  if (row !== null) return await unwrapDataKey(master, scope, row);
  const created = await newDataKey(master, scope);
  await ctx.db.insert("appDataKeys", {
    app: scope,
    ...created.wrapped,
    masterKeyId: master.id,
    createdAt: Date.now(),
  });
  return created.key;
}

/** Encrypt and store values for one scope. Every name is checked before anything is written. */
export async function putSecrets(
  ctx: MutationCtx,
  master: MasterKey,
  scope: string,
  values: Record<string, string>,
) {
  for (const name of Object.keys(values)) {
    if (!isValidSecretName(name))
      throw new ConvexError(`Invalid environment variable name: ${name}`);
  }
  const dataKey = await writableDataKey(ctx, master, scope);
  const now = Date.now();
  for (const [name, value] of Object.entries(values)) {
    const sealed = await encryptValue(dataKey, scope, name, value);
    const existing = await ctx.db
      .query("appSecrets")
      .withIndex("by_app_name", (q) => q.eq("app", scope).eq("name", name))
      .unique();
    if (existing === null) {
      await ctx.db.insert("appSecrets", { app: scope, name, ...sealed, updatedAt: now });
    } else {
      await ctx.db.patch(existing._id, { ...sealed, updatedAt: now });
    }
  }
}

/** Decrypted values for one scope. Not exported through any public function. */
async function readSecrets(ctx: QueryCtx, master: MasterKey, scope: string) {
  const rows = await ctx.db
    .query("appSecrets")
    .withIndex("by_app_name", (q) => q.eq("app", scope))
    .collect();
  if (rows.length === 0) return {};
  const keyRow = await dataKeyRow(ctx, scope);
  if (keyRow === null) throw new Error(`Secrets for "${scope}" have no data key`);
  const dataKey = await unwrapDataKey(master, scope, keyRow);
  const values: Record<string, string> = {};
  for (const row of rows) values[row.name] = await decryptValue(dataKey, scope, row.name, row);
  return values;
}

export const set = mutation({
  args: { app: v.string(), vars: v.record(v.string(), v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { actor } = await requirePermission(ctx, "app.deploy");
    await putSecrets(ctx, await requireMasterKey(process.env), args.app, args.vars);
    await appendAudit(ctx, {
      actor,
      action: "env.set",
      target: args.app,
      outcome: "success",
      meta: { names: Object.keys(args.vars).toSorted() },
    });
    return null;
  },
});

export const unset = mutation({
  args: { app: v.string(), name: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const { actor } = await requirePermission(ctx, "app.deploy");
    const row = await ctx.db
      .query("appSecrets")
      .withIndex("by_app_name", (q) => q.eq("app", args.app).eq("name", args.name))
      .unique();
    if (row === null) return false;
    await ctx.db.delete(row._id);
    await appendAudit(ctx, {
      actor,
      action: "env.unset",
      target: `${args.app}:${args.name}`,
      outcome: "success",
    });
    return true;
  },
});

/** Names and a mask. `secrets.read` could be broad, so no value is ever returned here. */
export const list = query({
  args: { app: v.string() },
  returns: v.array(v.object({ name: v.string(), preview: v.string(), updatedAt: v.number() })),
  handler: async (ctx, args) => {
    await requirePermission(ctx, "app.read");
    const rows = await ctx.db
      .query("appSecrets")
      .withIndex("by_app_name", (q) => q.eq("app", args.app))
      .collect();
    return rows.map((row) => ({ name: row.name, preview: MASK, updatedAt: row.updatedAt }));
  },
});

/**
 * The plaintext a Node needs to start one deployment's containers. Each targeted Node that hosts
 * a service receives the App-wide scope (common environment injected into every service), plus
 * only the `<app>-<service>` scopes placed on that Node. An absent service.nodeId inherits
 * app.nodeId. A target hosting no services gets nothing. For a single-container deployment with
 * no apps row, targetNodeIds is the placement record and grants the App-wide scope only.
 * Refused unless the deployment targets `nodeId`, is not finished, and holds a live App lease.
 */
export async function secretsForNodeDeploy(
  ctx: QueryCtx,
  input: { nodeId: Id<"nodes">; deploymentId: Id<"appDeployments">; now: number },
) {
  const deployment = await ctx.db.get(input.deploymentId);
  if (deployment === null) throw new ConvexError("No such deployment");
  if (!deployment.targetNodeIds.includes(input.nodeId)) {
    throw new ConvexError("This deployment does not target this Node");
  }
  if (isTerminalStage(deployment.stage)) throw new ConvexError("This deployment has finished");
  const lease = await ctx.db
    .query("appLeases")
    .withIndex("by_app", (q) => q.eq("app", deployment.app))
    .unique();
  if (
    deployment.leaseEpoch === undefined ||
    !leaseAdmits(lease, deployment.leaseEpoch, input.now)
  ) {
    throw new ConvexError("This deployment no longer holds its App's lease");
  }
  const app = await ctx.db
    .query("apps")
    .withIndex("by_name", (q) => q.eq("name", deployment.app))
    .unique();
  const services =
    app?.services.filter((service) => (service.nodeId ?? app.nodeId) === input.nodeId) ?? [];
  if (app !== null && services.length === 0) {
    throw new ConvexError("No services of this App are placed on this Node");
  }
  const master = await requireMasterKey(process.env);
  const scopes: Record<string, Record<string, string>> = {
    [deployment.app]: await readSecrets(ctx, master, deployment.app),
  };
  for (const service of services) {
    const scope = `${deployment.app}-${service.name}`;
    scopes[scope] = await readSecrets(ctx, master, scope);
  }
  return scopes;
}

export const forNodeDeploy = internalQuery({
  args: { nodeId: v.id("nodes"), deploymentId: v.id("appDeployments") },
  returns: v.record(v.string(), v.record(v.string(), v.string())),
  handler: async (ctx, args) => await secretsForNodeDeploy(ctx, { ...args, now: Date.now() }),
});
