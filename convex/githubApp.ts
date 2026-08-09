import { ConvexError, v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";

const SETUP_STATE_TTL_MS = 15 * 60 * 1_000;

// `administration: write` is what POST /repos/{owner}/{repo}/actions/runners/
// generate-jitconfig requires; `actions: read` is what delivers workflow_job
// webhooks. Narrower than the "Actions: Read and write" the manual setup asks
// for, and unlike it, sufficient for the JIT endpoint.
const APP_PERMISSIONS = {
  actions: "read",
  administration: "write",
} as const;

const APP_EVENTS = ["workflow_job"] as const;

async function requireDashboardAuth(ctx: QueryCtx | MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) {
    throw new ConvexError("Authentication required");
  }
  return identity;
}

async function readApp(ctx: QueryCtx) {
  return await ctx.db.query("githubApp").first();
}

export function buildManifest(siteUrl: string) {
  return {
    name: "Runner Center",
    url: siteUrl,
    hook_attributes: { url: `${siteUrl}/github/webhook`, active: true },
    redirect_url: `${siteUrl}/github/app/callback`,
    public: false,
    default_permissions: APP_PERMISSIONS,
    default_events: APP_EVENTS,
  };
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// GitHub only accepts the manifest as a form POST, so the browser is handed a
// self-submitting form rather than a redirect.
export function renderManifestForm(
  siteUrl: string,
  state: string,
  org: string | undefined,
) {
  const action =
    org === undefined
      ? "https://github.com/settings/apps/new"
      : `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new`;
  const manifest = escapeHtml(JSON.stringify(buildManifest(siteUrl)));

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Creating your GitHub App…</title>
<style>
body{background:#0a0a0b;color:#a1a1aa;font:14px/1.5 ui-sans-serif,system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0}
button{background:#18181b;color:#e4e4e7;border:1px solid rgba(255,255,255,.14);border-radius:6px;padding:8px 14px;font:inherit;cursor:pointer}
</style>
</head>
<body>
<form id="manifest-form" method="post" action="${escapeHtml(action)}?state=${encodeURIComponent(state)}">
<input type="hidden" name="manifest" value="${manifest}" />
<noscript><p>Continue to GitHub to create the app.</p></noscript>
<button type="submit">Continue to GitHub</button>
</form>
<script>document.getElementById('manifest-form').submit();</script>
</body>
</html>`;
}

export const status = query({
  args: {},
  returns: v.object({
    configured: v.boolean(),
    source: v.union(
      v.literal("manifest"),
      v.literal("env"),
      v.literal("pat"),
      v.literal("none"),
    ),
    appId: v.optional(v.number()),
    name: v.optional(v.string()),
    htmlUrl: v.optional(v.string()),
    installUrl: v.optional(v.string()),
    createdAt: v.optional(v.number()),
  }),
  handler: async (ctx) => {
    await requireDashboardAuth(ctx);
    const app = await readApp(ctx);
    if (app !== null) {
      return {
        configured: true,
        source: "manifest" as const,
        appId: app.appId,
        name: app.name,
        htmlUrl: app.htmlUrl,
        installUrl: `https://github.com/apps/${app.slug}/installations/new`,
        createdAt: app.createdAt,
      };
    }
    if (
      process.env.GITHUB_APP_ID !== undefined &&
      process.env.GITHUB_APP_PRIVATE_KEY !== undefined
    ) {
      return { configured: true, source: "env" as const };
    }
    if (process.env.GITHUB_PAT !== undefined) {
      return { configured: true, source: "pat" as const };
    }
    return { configured: false, source: "none" as const };
  },
});

export const beginSetup = mutation({
  args: {},
  returns: v.object({ state: v.string() }),
  handler: async (ctx) => {
    await requireDashboardAuth(ctx);
    const now = Date.now();

    for (const stale of await ctx.db.query("githubAppSetups").collect()) {
      if (
        stale.usedAt !== undefined ||
        now - stale.createdAt > SETUP_STATE_TTL_MS
      ) {
        await ctx.db.delete(stale._id);
      }
    }

    const state = `rcst_${crypto.randomUUID().replace(/-/g, "")}`;
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

export const isSetupStatePending = internalQuery({
  args: { state: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const setup = await ctx.db
      .query("githubAppSetups")
      .withIndex("by_state", (q) => q.eq("state", args.state))
      .unique();
    return (
      setup !== null &&
      setup.usedAt === undefined &&
      Date.now() - setup.createdAt <= SETUP_STATE_TTL_MS
    );
  },
});

export const consumeSetupState = internalMutation({
  args: { state: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const setup = await ctx.db
      .query("githubAppSetups")
      .withIndex("by_state", (q) => q.eq("state", args.state))
      .unique();
    if (
      setup === null ||
      setup.usedAt !== undefined ||
      Date.now() - setup.createdAt > SETUP_STATE_TTL_MS
    ) {
      return false;
    }
    await ctx.db.patch(setup._id, { usedAt: Date.now() });
    return true;
  },
});

export const store = internalMutation({
  args: {
    appId: v.number(),
    slug: v.string(),
    name: v.string(),
    privateKey: v.string(),
    webhookSecret: v.string(),
    htmlUrl: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
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

// Internal only: this returns the private key and webhook secret and must
// never be reachable from a client.
export const credentials = internalQuery({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      appId: v.number(),
      privateKey: v.string(),
      webhookSecret: v.string(),
    }),
  ),
  handler: async (ctx) => {
    const app = await readApp(ctx);
    if (app === null) {
      return null;
    }
    return {
      appId: app.appId,
      privateKey: app.privateKey,
      webhookSecret: app.webhookSecret,
    };
  },
});
