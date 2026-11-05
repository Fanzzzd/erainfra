// Apps, their public routes, and standalone mesh links: the Hub's `apps`, `routes` and `links`.
import type { Infer } from "convex/values";
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { query, type MutationCtx } from "../_generated/server";
import { requirePermission } from "./access";
import { appLinkValidator, appServiceValidator } from "./tables";

type AppService = Infer<typeof appServiceValidator>;
type AppLink = Infer<typeof appLinkValidator>;

export async function upsertApp(
  ctx: MutationCtx,
  input: { name: string; nodeId: Id<"nodes">; services: AppService[]; links: AppLink[] },
) {
  const existing = await ctx.db
    .query("apps")
    .withIndex("by_name", (q) => q.eq("name", input.name))
    .unique();
  const fields = { ...input, updatedAt: Date.now() };
  if (existing === null) return await ctx.db.insert("apps", fields);
  await ctx.db.replace(existing._id, fields);
  return existing._id;
}

export async function upsertRoute(
  ctx: MutationCtx,
  input: { name: string; nodeId: Id<"nodes">; image: string; port: number },
) {
  const existing = await ctx.db
    .query("appRoutes")
    .withIndex("by_name", (q) => q.eq("name", input.name))
    .unique();
  const fields = { ...input, updatedAt: Date.now() };
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
) {
  const existing = await ctx.db
    .query("meshLinks")
    .withIndex("by_name", (q) => q.eq("name", input.name))
    .unique();
  const fields = { ...input, updatedAt: Date.now() };
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
