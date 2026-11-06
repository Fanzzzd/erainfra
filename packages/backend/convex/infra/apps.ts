// Apps, their public routes, and standalone mesh links: the Hub's `apps`, `routes` and `links`.
import type { Infer } from "convex/values";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query, type MutationCtx, type QueryCtx } from "../_generated/server";
import { requirePermission } from "./access";
import { provenanceFor, type HubOrigin } from "./hubProvenance";
import { appLinkValidator, appServiceValidator } from "./tables";

type AppService = Infer<typeof appServiceValidator>;
type AppLink = Infer<typeof appLinkValidator>;

/** The fleet's App bound: the mesh snapshot (nodeState.ts) refuses more. */
export const MAX_APPS = 500;

/**
 * Write an App row whole. Convex's writers pass no `hub` and claim the row for Convex; only the
 * Hub importer passes the hash of the Hub row it copied (hubProvenance.ts).
 */
export async function upsertApp(
  ctx: MutationCtx,
  input: {
    name: string;
    nodeId: Id<"nodes">;
    services: AppService[];
    links: AppLink[];
    spec?: Doc<"apps">["spec"];
  },
  hub?: HubOrigin,
) {
  const existing = await ctx.db
    .query("apps")
    .withIndex("by_name", (q) => q.eq("name", input.name))
    .unique();
  const now = Date.now();
  const fields = { ...input, provenance: provenanceFor(now, hub), updatedAt: now };
  if (existing === null) return await ctx.db.insert("apps", fields);
  await ctx.db.replace(existing._id, fields);
  return existing._id;
}

/**
 * Who a route label belongs to. A row records its owner since route ownership was introduced. An
 * older row's owner is the one App whose service routes at the label, or, when no App row routes
 * there, the single-container App the Hub deployed under that name. Two App rows routing at one
 * label is `ambiguous`: nobody may take it until an operator removes all but one of them.
 */
export type RouteOwner = { app: string; service?: string } | "ambiguous";

export function ownerOfRoute(
  route: Pick<Doc<"appRoutes">, "name" | "app" | "service">,
  apps: ReadonlyArray<Pick<Doc<"apps">, "name" | "services">>,
): RouteOwner {
  if (route.app !== undefined)
    return route.service === undefined
      ? { app: route.app }
      : { app: route.app, service: route.service };
  const claims = apps.flatMap((a) =>
    a.services.filter((s) => s.route === route.name).map((s) => ({ app: a.name, service: s.name })),
  );
  if (new Set(claims.map((c) => c.app)).size > 1) return "ambiguous";
  return claims[0] ?? { app: route.name };
}

/** `ownerOfRoute`, reading the App rows itself when the route row does not name its owner. */
export async function loadRouteOwner(ctx: QueryCtx, route: Doc<"appRoutes">) {
  if (route.app !== undefined) return ownerOfRoute(route, []);
  return ownerOfRoute(route, await ctx.db.query("apps").take(MAX_APPS));
}

/** Whether a route row is a single-container App the Hub deployed: its container is the label. */
export function isSingleContainerRoute(route: Pick<Doc<"appRoutes">, "name">, owner: RouteOwner) {
  return owner !== "ambiguous" && owner.service === undefined && owner.app === route.name;
}

/** Why `app` may not write the route `label`, or null when it may. */
export async function routeRefusal(ctx: QueryCtx, label: string, app: string) {
  const existing = await ctx.db
    .query("appRoutes")
    .withIndex("by_name", (q) => q.eq("name", label))
    .unique();
  if (existing === null) return null;
  const owner = await loadRouteOwner(ctx, existing);
  if (owner === "ambiguous")
    return `the route ${label} is claimed by more than one App; remove all but one of them first`;
  if (owner.app !== app)
    return `App "${app}" cannot take the route ${label}: it belongs to App "${owner.app}"`;
  return null;
}

/**
 * Write a route row for its owner. Refused when the label belongs to another App. The owning App
 * may move it between its services or Nodes (a redeploy or a failover); nobody else may take it.
 */
export async function upsertRoute(
  ctx: MutationCtx,
  input: {
    name: string;
    nodeId: Id<"nodes">;
    image: string;
    port: number;
    app: string;
    service?: string;
  },
  hub?: HubOrigin,
) {
  const refusal = await routeRefusal(ctx, input.name, input.app);
  if (refusal !== null) throw new ConvexError(refusal);
  const existing = await ctx.db
    .query("appRoutes")
    .withIndex("by_name", (q) => q.eq("name", input.name))
    .unique();
  const now = Date.now();
  const fields = { ...input, provenance: provenanceFor(now, hub), updatedAt: now };
  if (existing === null) return await ctx.db.insert("appRoutes", fields);
  await ctx.db.replace(existing._id, fields);
  return existing._id;
}

export async function upsertMeshLink(
  ctx: MutationCtx,
  input: {
    name: string;
    providerNodeId: Id<"nodes">;
    providerPort: number;
    consumerNodeId: Id<"nodes">;
    localPort: number;
    createdBy?: "user" | "deploy";
  },
  hub?: HubOrigin,
) {
  const existing = await ctx.db
    .query("meshLinks")
    .withIndex("by_name", (q) => q.eq("name", input.name))
    .unique();
  const now = Date.now();
  const fields = { ...input, provenance: provenanceFor(now, hub), updatedAt: now };
  if (existing === null) return await ctx.db.insert("meshLinks", fields);
  await ctx.db.replace(existing._id, fields);
  return existing._id;
}

export const list = query({
  args: {},
  returns: v.array(
    v.object({
      name: v.string(),
      nodeId: v.id("nodes"),
      services: v.array(appServiceValidator),
      links: v.array(appLinkValidator),
      updatedAt: v.number(),
    }),
  ),
  handler: async (ctx) => {
    await requirePermission(ctx, "app.read");
    const apps = await ctx.db.query("apps").collect();
    return apps
      .map(({ name, nodeId, services, links, updatedAt }) => ({
        name,
        nodeId,
        services,
        links,
        updatedAt,
      }))
      .toSorted((a, b) => a.name.localeCompare(b.name));
  },
});

export const routes = query({
  args: {},
  returns: v.array(
    v.object({ name: v.string(), nodeId: v.id("nodes"), image: v.string(), port: v.number() }),
  ),
  handler: async (ctx) => {
    await requirePermission(ctx, "app.read");
    const rows = await ctx.db.query("appRoutes").collect();
    return rows
      .map(({ name, nodeId, image, port }) => ({ name, nodeId, image, port }))
      .toSorted((a, b) => a.name.localeCompare(b.name));
  },
});

export const meshLinks = query({
  args: {},
  returns: v.array(
    v.object({
      name: v.string(),
      providerNodeId: v.id("nodes"),
      providerPort: v.number(),
      consumerNodeId: v.id("nodes"),
      localPort: v.number(),
      createdBy: v.optional(v.union(v.literal("user"), v.literal("deploy"))),
    }),
  ),
  handler: async (ctx) => {
    await requirePermission(ctx, "app.read");
    const rows = await ctx.db.query("meshLinks").collect();
    return rows
      .map(({ name, providerNodeId, providerPort, consumerNodeId, localPort, createdBy }) => ({
        name,
        providerNodeId,
        providerPort,
        consumerNodeId,
        localPort,
        createdBy,
      }))
      .toSorted((a, b) => a.name.localeCompare(b.name));
  },
});
