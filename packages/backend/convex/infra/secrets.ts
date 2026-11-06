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
import { provenanceFor, recordTombstone, secretKey, type HubOrigin } from "./hubProvenance";
import { isTerminalStage, isValidName, isValidSecretName, leaseAdmits } from "./policy";
import {
  decryptValue,
  describeScope,
  encryptValue,
  newDataKey,
  requireMasterKey,
  unwrapDataKey,
  type MasterKey,
  type SecretScope,
} from "./secretCrypto";

export const MASK = "••••••";

/** A scope from caller input, with both names held to the App naming rule. */
export function secretScope(app: string, service?: string): SecretScope {
  if (!isValidName(app)) throw new ConvexError(`Invalid App name: ${app}`);
  if (service === undefined) return { app };
  if (!isValidName(service)) throw new ConvexError(`Invalid service name: ${service}`);
  return { app, service };
}

const scopeArgs = { app: v.string(), service: v.optional(v.string()) };

async function dataKeyRow(ctx: QueryCtx, scope: SecretScope) {
  return await ctx.db
    .query("appDataKeys")
    .withIndex("by_app_service", (q) => q.eq("app", scope.app).eq("service", scope.service))
    .unique();
}

function secretRows(ctx: QueryCtx, scope: SecretScope) {
  return ctx.db
    .query("appSecrets")
    .withIndex("by_app_service_name", (q) => q.eq("app", scope.app).eq("service", scope.service));
}

async function writableDataKey(ctx: MutationCtx, master: MasterKey, scope: SecretScope) {
  const row = await dataKeyRow(ctx, scope);
  if (row !== null) return await unwrapDataKey(master, scope, row);
  const created = await newDataKey(master, scope);
  await ctx.db.insert("appDataKeys", {
    ...scope,
    ...created.wrapped,
    masterKeyId: master.id,
    createdAt: Date.now(),
  });
  return created.key;
}

/**
 * Encrypt and store values for one scope. Every name is checked before anything is written. Each
 * row written is Convex's unless the Hub importer passes the origin of the Hub's values.
 */
export async function putSecrets(
  ctx: MutationCtx,
  master: MasterKey,
  target: SecretScope,
  values: Record<string, string>,
  hub?: HubOrigin,
) {
  const scope = secretScope(target.app, target.service);
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
      .withIndex("by_app_service_name", (q) =>
        q.eq("app", scope.app).eq("service", scope.service).eq("name", name),
      )
      .unique();
    const provenance = provenanceFor(now, hub);
    if (existing === null) {
      await ctx.db.insert("appSecrets", { ...scope, name, ...sealed, provenance, updatedAt: now });
    } else {
      await ctx.db.patch(existing._id, { ...sealed, provenance, updatedAt: now });
    }
  }
}

/** One stored variable with its plaintext, for the Hub importer to compare with the Hub's value. */
export async function storedSecret(
  ctx: QueryCtx,
  master: MasterKey,
  scope: SecretScope,
  name: string,
) {
  const row = await ctx.db
    .query("appSecrets")
    .withIndex("by_app_service_name", (q) =>
      q.eq("app", scope.app).eq("service", scope.service).eq("name", name),
    )
    .unique();
  if (row === null) return null;
  const keyRow = await dataKeyRow(ctx, scope);
  if (keyRow === null) throw new Error(`Secrets for ${describeScope(scope)} have no data key`);
  const value = await decryptValue(await unwrapDataKey(master, scope, keyRow), scope, name, row);
  return { row, value };
}

/** Decrypted values for one scope. Not exported through any public function. */
async function readSecrets(ctx: QueryCtx, master: MasterKey, scope: SecretScope) {
  const rows = await secretRows(ctx, scope).collect();
  if (rows.length === 0) return {};
  const keyRow = await dataKeyRow(ctx, scope);
  if (keyRow === null) throw new Error(`Secrets for ${describeScope(scope)} have no data key`);
  const dataKey = await unwrapDataKey(master, scope, keyRow);
  const values: Record<string, string> = {};
  for (const row of rows) values[row.name] = await decryptValue(dataKey, scope, row.name, row);
  return values;
}

/**
 * Set variables for an App. Without `service` they go to the App-wide scope every service of the
 * App receives; with it, only to that service.
 */
/** The body of `set`, shared with the operator API (infra/operator.ts). */
export async function setSecrets(
  ctx: MutationCtx,
  input: { app: string; service?: string; vars: Record<string, string>; actor: string },
) {
  const scope = secretScope(input.app, input.service);
  await putSecrets(ctx, await requireMasterKey(process.env), scope, input.vars);
  await appendAudit(ctx, {
    actor: input.actor,
    action: "env.set",
    target: input.app,
    outcome: "success",
    meta: {
      ...(scope.service === undefined ? {} : { service: scope.service }),
      names: Object.keys(input.vars).toSorted(),
    },
  });
}

export const set = mutation({
  args: { ...scopeArgs, vars: v.record(v.string(), v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { actor } = await requirePermission(ctx, "app.deploy");
    await setSecrets(ctx, { ...args, actor });
    return null;
  },
});

/** The body of `unset`: whether the variable existed. Shared with the operator API. */
export async function unsetSecret(
  ctx: MutationCtx,
  input: { app: string; service?: string; name: string; actor: string },
) {
  const scope = secretScope(input.app, input.service);
  const row = await ctx.db
    .query("appSecrets")
    .withIndex("by_app_service_name", (q) =>
      q.eq("app", scope.app).eq("service", scope.service).eq("name", input.name),
    )
    .unique();
  if (row === null) return false;
  await ctx.db.delete(row._id);
  await recordTombstone(ctx, "secret", secretKey(scope, input.name));
  await appendAudit(ctx, {
    actor: input.actor,
    action: "env.unset",
    target: input.app,
    outcome: "success",
    meta: {
      ...(scope.service === undefined ? {} : { service: scope.service }),
      name: input.name,
    },
  });
  return true;
}

export const unset = mutation({
  args: { ...scopeArgs, name: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const { actor } = await requirePermission(ctx, "app.deploy");
    return await unsetSecret(ctx, { ...args, actor });
  },
});

/** Names and a mask for one scope. No value ever leaves through here. */
export async function maskedSecrets(ctx: QueryCtx, app: string, service?: string) {
  const rows = await secretRows(ctx, secretScope(app, service)).collect();
  return rows.map((row) => ({ name: row.name, preview: MASK, updatedAt: row.updatedAt }));
}

/** Names and a mask. `secrets.read` could be broad, so no value is ever returned here. */
export const list = query({
  args: scopeArgs,
  returns: v.array(v.object({ name: v.string(), preview: v.string(), updatedAt: v.number() })),
  handler: async (ctx, args) => {
    await requirePermission(ctx, "app.read");
    return await maskedSecrets(ctx, args.app, args.service);
  },
});

/**
 * The plaintext a Node needs to start one deployment's containers. Each targeted Node that hosts
 * a service receives the App-wide scope (common environment injected into every service), plus
 * only the (app, service) scopes of the services placed on that Node. An absent service.nodeId
 * inherits app.nodeId. A target hosting no services gets nothing. For a single-container deployment with
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
  // A pipeline run's plan is the placement it is deploying, ahead of the stored App, which is only
  // rewritten once every Node of the run is up.
  const app = deployment.plan
    ? { nodeId: deployment.plan.nodeId, services: deployment.plan.services }
    : await ctx.db
        .query("apps")
        .withIndex("by_name", (q) => q.eq("name", deployment.app))
        .unique();
  const services =
    app?.services.filter((service) => (service.nodeId ?? app.nodeId) === input.nodeId) ?? [];
  if (app !== null && services.length === 0) {
    throw new ConvexError("No services of this App are placed on this Node");
  }
  const master = await requireMasterKey(process.env);
  const appWide = await readSecrets(ctx, master, { app: deployment.app });
  const perService: Record<string, Record<string, string>> = {};
  for (const service of services) {
    perService[service.name] = await readSecrets(ctx, master, {
      app: deployment.app,
      service: service.name,
    });
  }
  return { appWide, services: perService };
}

const values = v.record(v.string(), v.string());

export const forNodeDeploy = internalQuery({
  args: { nodeId: v.id("nodes"), deploymentId: v.id("appDeployments") },
  returns: v.object({ appWide: values, services: v.record(v.string(), values) }),
  handler: async (ctx, args) => await secretsForNodeDeploy(ctx, { ...args, now: Date.now() }),
});
