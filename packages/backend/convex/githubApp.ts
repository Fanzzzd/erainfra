import { ConvexError, v } from "convex/values";
import {
  evaluateSetupState,
  isSetupStateCollectable,
  resolveCredentialSource,
  canConnectApp,
  toAppSummary,
} from "./githubAppConfig";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";

const sourceValidator = v.union(
  v.literal("manifest"),
  v.literal("envApp"),
  v.literal("pat"),
  v.literal("none"),
);

// Exactly the fields that may cross the wire to a browser. The private key and
// webhook secret are absent by construction, not by filtering.
const appSummaryValidator = v.object({
  appId: v.number(),
  clientId: v.string(),
  name: v.string(),
  htmlUrl: v.string(),
  installUrl: v.string(),
  createdAt: v.number(),
});

async function requireDashboardAuth(ctx: QueryCtx | MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) {
    throw new ConvexError("Authentication required");
  }
  return identity;
}

function randomHex(length: number) {
  const bytes = crypto.getRandomValues(new Uint8Array(Math.ceil(length / 2)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, length);
}

async function readApp(ctx: QueryCtx) {
  return await ctx.db.query("githubApp").first();
}

function credentialEnv() {
  return {
    appId: process.env.GITHUB_APP_ID,
    privateKey: process.env.GITHUB_APP_PRIVATE_KEY,
    pat: process.env.GITHUB_PAT,
  };
}

export const status = query({
  args: {},
  returns: v.object({
    configured: v.boolean(),
    source: sourceValidator,
    canConnect: v.boolean(),
    app: v.union(v.null(), appSummaryValidator),
  }),
  handler: async (ctx) => {
    await requireDashboardAuth(ctx);
    const app = await readApp(ctx);
    const source = resolveCredentialSource(app !== null, credentialEnv());
    return {
      configured: source !== "none",
      source,
      canConnect: canConnectApp(source),
      app: app === null ? null : toAppSummary(app),
    };
  },
});

export const beginSetup = mutation({
  args: {},
  returns: v.object({ state: v.string() }),
  handler: async (ctx) => {
    await requireDashboardAuth(ctx);
    const now = Date.now();

    for (const stale of await ctx.db.query("githubAppSetups").collect()) {
      if (isSetupStateCollectable(stale, now)) {
        await ctx.db.delete(stale._id);
      }
    }

    const state = `rcst_${randomHex(32)}`;
    await ctx.db.insert("githubAppSetups", { state, createdAt: now });
    return { state };
  },
});

export const disconnect = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await requireDashboardAuth(ctx);
    const app = await readApp(ctx);
    if (app !== null) {
      await ctx.db.delete(app._id);
    }
    return null;
  },
});

async function findSetupState(ctx: QueryCtx | MutationCtx, state: string) {
  if (state.length === 0) {
    return null;
  }
  return await ctx.db
    .query("githubAppSetups")
    .withIndex("by_state", (q) => q.eq("state", state))
    .unique();
}

export const setupStateStatus = internalQuery({
  args: { state: v.string() },
  returns: v.union(
    v.literal("valid"),
    v.literal("unknown"),
    v.literal("consumed"),
    v.literal("expired"),
  ),
  handler: async (ctx, args) => {
    return evaluateSetupState(await findSetupState(ctx, args.state), Date.now());
  },
});

// Single-use: the row is marked spent before the credentials are fetched, so a
// replayed redirect cannot exchange a second code.
export const consumeSetupState = internalMutation({
  args: { state: v.string() },
  returns: v.union(
    v.literal("valid"),
    v.literal("unknown"),
    v.literal("consumed"),
    v.literal("expired"),
  ),
  handler: async (ctx, args) => {
    const setup = await findSetupState(ctx, args.state);
    const stateStatus = evaluateSetupState(setup, Date.now());
    if (stateStatus === "valid" && setup !== null) {
      await ctx.db.patch(setup._id, { usedAt: Date.now() });
    }
    return stateStatus;
  },
});

export const store = internalMutation({
  args: {
    appId: v.number(),
    clientId: v.string(),
    slug: v.string(),
    name: v.string(),
    privateKey: v.string(),
    webhookSecret: v.string(),
    htmlUrl: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // At most one App is ever configured; replacing it is how reconnecting works.
    for (const existing of await ctx.db.query("githubApp").collect()) {
      await ctx.db.delete(existing._id);
    }
    await ctx.db.insert("githubApp", { ...args, createdAt: Date.now() });
    return null;
  },
});

// Kept separate from `credentials` so verifying a webhook never pulls the
// private key into memory.
export const webhookSecret = internalQuery({
  args: {},
  returns: v.union(v.null(), v.string()),
  handler: async (ctx) => {
    const app = await readApp(ctx);
    return app === null ? null : app.webhookSecret;
  },
});

// Internal only: returns the private key, and must never become reachable from
// a client. `status` is the client-facing view.
export const credentials = internalQuery({
  args: {},
  returns: v.union(v.null(), v.object({ appId: v.number(), privateKey: v.string() })),
  handler: async (ctx) => {
    const app = await readApp(ctx);
    return app === null ? null : { appId: app.appId, privateKey: app.privateKey };
  },
});
