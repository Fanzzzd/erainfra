// Copies a Hub's state into Convex (ADR 0016 phase 2a). Driven by
// scripts/import-hub-state.ts, which reads portless.db and secret.key on the Hub's host and calls
// `run` (or `preview` for a dry run) with an admin key. The import runs repeatedly while the Hub
// keeps serving, and Convex starts writing the same tables before the last run
// (docs/runbooks/retire-the-hub.md). So the Hub is the truth only for rows Convex has not written:
//
// - every row the importer writes records that it came from the Hub, with a hash of the Hub row
//   (hubProvenance.ts), so an unchanged Hub row is left untouched;
// - once Convex writes a row (a deploy, failover, env set, link add, bind, a run's result on its
//   binding) the row is Convex's and every later import skips it, reporting `owned by Convex`;
// - once Convex deletes one (App removal, env unset, link removal, unbind, account removal) a
//   tombstone keeps the import from bringing it back;
// - an App's routes and ports follow the App: once Convex owns the App, they are skipped too.
//
// Each row gets its own result. A refused row writes nothing, is reported, and never stops the rows
// and batches after it; the script exits non-zero when any row was refused.
//
// Kept: port numbers, audit order, Hub ids (`legacyId`, `legacyHubId`, `hubSeq`), creation times,
// password hashes, and secret plaintext (re-encrypted under this deployment's master key).
// Not copied: sessions and API tokens (credentials for the Hub only; see docs/infra-management.md)
// and the AI transcript archive, which is not control state.
import { ConvexError, v, type Infer } from "convex/values";
import { internal } from "../_generated/api";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { emailRefusal, insertUser, normalizeEmail } from "./access";
import { appendAudit, auditRefusal } from "./auditLog";
import { readCounter, writeCounter } from "./counters";
import { createDeployment } from "./deployments";
import { routeRefusal, upsertApp, upsertMeshLink, upsertRoute } from "./apps";
import { bindingKey, bindingRefusal, findBinding, insertBinding } from "./git";
import {
  appOwnedByConvex,
  contentHash,
  hasTombstone,
  hubHash,
  provenanceFor,
  secretKey,
  writtenByConvex,
} from "./hubProvenance";
import { ensureNode } from "./nodes";
import {
  appOfPortKey,
  DEPLOYMENTS_KEPT,
  effectiveRole,
  isValidSecretName,
  repoKey,
  roleFromHubRoles,
} from "./policy";
import { claimPort, claimPortRefusal } from "./ports";
import { putSecrets, secretScope, storedSecret } from "./secrets";
import { requireMasterKey, type MasterKey } from "./secretCrypto";
import { auditOutcomeValidator, deployStageValidator } from "./tables";

const hubService = v.object({
  name: v.string(),
  image: v.string(),
  args: v.array(v.string()),
  port: v.optional(v.number()),
  route: v.optional(v.string()),
  node: v.optional(v.string()),
  env: v.optional(v.record(v.string(), v.string())),
});

const hubAppLink = v.object({
  name: v.string(),
  need: v.string(),
  provider: v.string(),
  providerPort: v.number(),
  consumer: v.string(),
  localPort: v.number(),
});

export const importBatchValidator = v.union(
  v.object({
    kind: v.literal("users"),
    rows: v.array(
      v.object({
        legacyId: v.string(),
        email: v.string(),
        name: v.string(),
        roles: v.array(v.string()),
        passwordHash: v.string(),
        createdAt: v.number(),
      }),
    ),
  }),
  v.object({
    kind: v.literal("routes"),
    rows: v.array(
      v.object({
        name: v.string(),
        node: v.string(),
        image: v.string(),
        port: v.number(),
        // The owner the importer resolved from the Hub's Apps (resolveHubRouteOwners).
        app: v.string(),
        service: v.optional(v.string()),
      }),
    ),
  }),
  v.object({
    kind: v.literal("apps"),
    rows: v.array(
      v.object({
        name: v.string(),
        node: v.string(),
        services: v.array(hubService),
        links: v.array(hubAppLink),
      }),
    ),
  }),
  v.object({
    kind: v.literal("links"),
    rows: v.array(
      v.object({
        name: v.string(),
        provider: v.string(),
        providerPort: v.number(),
        consumer: v.string(),
        localPort: v.number(),
        createdBy: v.optional(v.union(v.literal("user"), v.literal("deploy"))),
      }),
    ),
  }),
  v.object({
    kind: v.literal("ports"),
    rows: v.array(v.object({ node: v.string(), key: v.string(), port: v.number() })),
  }),
  v.object({
    kind: v.literal("secrets"),
    // One row per secret scope, already resolved from the Hub's `<app>-<service>` string by the
    // importer script against the Hub's own apps (resolveHubSecretScopes).
    rows: v.array(
      v.object({
        app: v.string(),
        service: v.optional(v.string()),
        values: v.record(v.string(), v.string()),
      }),
    ),
  }),
  v.object({
    kind: v.literal("gitBindings"),
    rows: v.array(
      v.object({
        legacyId: v.string(),
        repo: v.string(),
        branch: v.string(),
        app: v.string(),
        buildNode: v.optional(v.string()),
        deployNode: v.optional(v.string()),
        port: v.optional(v.number()),
        lastStatus: v.optional(
          v.object({
            at: v.number(),
            sha: v.string(),
            ok: v.boolean(),
            stage: v.string(),
            error: v.optional(v.string()),
          }),
        ),
      }),
    ),
  }),
  v.object({
    kind: v.literal("deployments"),
    rows: v.array(
      v.object({
        legacyId: v.string(),
        app: v.string(),
        stage: deployStageValidator,
        detail: v.string(),
        urls: v.array(v.string()),
        error: v.optional(v.string()),
        startedAt: v.number(),
        finishedAt: v.optional(v.number()),
      }),
    ),
  }),
  v.object({
    kind: v.literal("audit"),
    rows: v.array(
      v.object({
        hubSeq: v.number(),
        at: v.number(),
        actor: v.string(),
        action: v.string(),
        target: v.optional(v.string()),
        outcome: auditOutcomeValidator,
        dryRun: v.optional(v.boolean()),
        meta: v.optional(v.record(v.string(), v.any())),
      }),
    ),
  }),
);

export type ImportBatch = Infer<typeof importBatchValidator>;

// ---------------------------------------------------------------------------
// Per-row results. Every row of every batch gets one (an env variable is a row), so a run says
// exactly what it created, changed, left alone and refused. A refused row never stops the rows and
// batches after it.

export const importOutcomeValidator = v.union(
  v.literal("created"),
  v.literal("updated"),
  v.literal("unchanged"),
  v.literal("skipped"),
  v.literal("refused"),
);
export const importItemValidator = v.object({
  kind: v.string(),
  key: v.string(),
  outcome: importOutcomeValidator,
  reason: v.optional(v.string()),
});
export type ImportItem = Infer<typeof importItemValidator>;
type Outcome = ImportItem["outcome"];

/** Every row skipped because Convex wrote it says so with these words. */
export const OWNED_BY_CONVEX = "owned by Convex";
const owned = (why: string) => `${OWNED_BY_CONVEX}: ${why}`;

/** What one row does, and the write that does it. */
type Decision = {
  key: string;
  outcome: Outcome;
  reason?: string;
  write?: (ctx: MutationCtx) => Promise<unknown>;
};
const skip = (key: string, reason: string): Decision => ({ key, outcome: "skipped", reason });
const refuse = (key: string, reason: string): Decision => ({ key, outcome: "refused", reason });
const same = (key: string): Decision => ({ key, outcome: "unchanged" });
const put = (
  key: string,
  exists: boolean,
  write: Decision["write"],
  reason?: string,
): Decision => ({
  key,
  outcome: exists ? "updated" : "created",
  write,
  ...(reason === undefined ? {} : { reason }),
});

type Rows<K extends ImportBatch["kind"]> = Extract<ImportBatch, { kind: K }>["rows"];

/** How results name a row: the Hub's own key for it, readable. */
export function rowKey(batch: ImportBatch, index: number): string {
  switch (batch.kind) {
    case "users":
      return batch.rows[index].email;
    case "routes":
    case "apps":
    case "links":
      return batch.rows[index].name;
    case "ports":
      return `${batch.rows[index].node} ${batch.rows[index].key}`;
    case "secrets": {
      const { app, service } = batch.rows[index];
      return service === undefined ? app : `${app}/${service}`;
    }
    case "gitBindings":
      return `${batch.rows[index].repo}@${batch.rows[index].branch}`;
    case "deployments":
      return batch.rows[index].legacyId;
    case "audit":
      return `#${batch.rows[index].hubSeq}`;
  }
}

const node = (ctx: MutationCtx, name: string) => ensureNode(ctx, name, "hub-import");
const optionalNode = async (ctx: MutationCtx, name: string | undefined) =>
  name === undefined ? undefined : await node(ctx, name);
async function nodeIdByName(ctx: QueryCtx, name: string) {
  const row = await ctx.db
    .query("nodes")
    .withIndex("by_name", (q) => q.eq("name", name))
    .unique();
  return row?._id ?? null;
}

/**
 * Why the importer leaves App `app`, its routes and its ports alone, or null while the Hub owns
 * it. An App becomes Convex's when Convex deploys, fails over or removes it.
 */
async function appOwnership(ctx: QueryCtx, app: string) {
  if (await hasTombstone(ctx, "app", app)) return owned(`App ${app} was removed in Convex`);
  const row = await ctx.db
    .query("apps")
    .withIndex("by_name", (q) => q.eq("name", app))
    .unique();
  if (row === null || !appOwnedByConvex(row)) return null;
  return owned(
    row.spec !== undefined
      ? `App ${app} was deployed through Convex`
      : `App ${app} was changed in Convex`,
  );
}

// ---------------------------------------------------------------------------
// One decision per row, per table. Each reads only; the write it returns runs in `apply`.

function decideUsers(ctx: QueryCtx, rows: Rows<"users">) {
  // Owners first, so the first account this creates is a Hub owner and insertUser's
  // first-account-is-owner rule changes nobody's role.
  const ordered = rows.toSorted((a, b) => {
    const ownerA = roleFromHubRoles(a.roles) === "owner" ? 0 : 1;
    const ownerB = roleFromHubRoles(b.roles) === "owner" ? 0 : 1;
    return ownerA - ownerB || a.createdAt - b.createdAt;
  });
  const decisions: Array<() => Promise<Decision>> = [];
  for (const row of ordered) decisions.push(() => decideUser(ctx, row));
  return decisions;
}

async function decideUser(ctx: QueryCtx, row: Rows<"users">[number]): Promise<Decision> {
  const key = row.email;
  // Removed from the dashboard: the Hub copy would come back with its Hub password.
  if (await hasTombstone(ctx, "user", row.legacyId))
    return skip(key, owned("the account was removed in Convex"));
  const role = roleFromHubRoles(row.roles);
  const email = normalizeEmail(row.email);
  const imported = await ctx.db
    .query("users")
    .withIndex("by_legacyHubId", (q) => q.eq("legacyHubId", row.legacyId))
    .unique();
  // An account is copied once. Its role and password are Convex's from then on.
  if (imported !== null) {
    const current = effectiveRole(imported.role);
    return current === role
      ? same(key)
      : skip(key, owned(`Convex keeps role ${current}; the Hub has ${role}`));
  }
  const sameEmail = await ctx.db
    .query("users")
    .withIndex("email", (q) => q.eq("email", email))
    .first();
  if (sameEmail !== null) {
    // Someone already signed in to the dashboard with this email: one person, one account.
    // Their dashboard password stays; their role is the higher of the two.
    return put(key, true, async (m) => {
      const current = effectiveRole(sameEmail.role);
      const rank = ["viewer", "operator", "admin", "owner"];
      await m.db.patch(sameEmail._id, {
        legacyHubId: row.legacyId,
        role: rank.indexOf(role) > rank.indexOf(current) ? role : current,
      });
    });
  }
  const refusal = emailRefusal(email);
  if (refusal !== null) return refuse(key, refusal);
  return put(key, false, async (m) => {
    const userId = await insertUser(m, {
      email,
      role,
      name: row.name,
      createdAt: row.createdAt,
      legacyHubId: row.legacyId,
    });
    const account = await m.db
      .query("authAccounts")
      .withIndex("providerAndAccountId", (q) =>
        q.eq("provider", "password").eq("providerAccountId", email),
      )
      .unique();
    if (account === null) {
      // The Hub's scrypt hash, verified by auth.ts until the password is next reset.
      await m.db.insert("authAccounts", {
        userId,
        provider: "password",
        providerAccountId: email,
        secret: row.passwordHash,
      });
    }
  });
}

async function decideRoute(ctx: QueryCtx, row: Rows<"routes">[number]): Promise<Decision> {
  const key = row.name;
  // A route moves with its App: a Convex deploy wrote this App's routes with its placement.
  const app = await appOwnership(ctx, row.app);
  if (app !== null) return skip(key, app);
  const existing = await ctx.db
    .query("appRoutes")
    .withIndex("by_name", (q) => q.eq("name", row.name))
    .unique();
  if (existing !== null && writtenByConvex(existing))
    return skip(key, owned("the route was written by a Convex deploy or failover"));
  const refusal = await routeRefusal(ctx, row.name, row.app);
  if (refusal !== null) return refuse(key, refusal);
  const hash = await contentHash(row);
  if (existing !== null && hubHash(existing) === hash) return same(key);
  return put(key, existing !== null, async (m) =>
    upsertRoute(
      m,
      {
        name: row.name,
        nodeId: await node(m, row.node),
        image: row.image,
        port: row.port,
        app: row.app,
        ...(row.service === undefined ? {} : { service: row.service }),
      },
      { hash },
    ),
  );
}

/**
 * The Hub's App row with each service on the Node it runs on, and what the operator should know
 * about that. The Hub fails an App over by its primary Node: it redeploys every service on the
 * survivor and moves the App's node and each of its routes there, but stores services[].node as
 * it was (apps/hub/src/runtime/failover.ts). Copied as is, a routed service would sit on the Node
 * it left, where the gateway refuses to serve it and a redeploy that names no Node starts it with
 * empty volumes. So a routed service takes its route's Node, and once a route shows such a move
 * every unrouted service takes the App's Node too, where that failover redeployed it. Route rows
 * are read from Convex: the script sends routes before Apps, so `run` has written them by now.
 */
async function placeServices(ctx: QueryCtx, row: Rows<"apps">[number]) {
  const routeNode = new Map<string, string>();
  for (const s of row.services) {
    if (s.route === undefined) continue;
    const route = await ctx.db
      .query("appRoutes")
      .withIndex("by_name", (q) => q.eq("name", s.route!))
      .unique();
    if (route === null) continue;
    if ((route.app ?? row.name) !== row.name || (route.service ?? s.name) !== s.name) continue;
    const routed = await ctx.db.get(route.nodeId);
    if (routed !== null) routeNode.set(s.name, routed.name);
  }
  const failedOver = row.services.some(
    (s) => routeNode.get(s.name) === row.node && (s.node ?? row.node) !== row.node,
  );
  const notes: string[] = [];
  const services = row.services.map((s) => {
    const stored = s.node ?? row.node;
    const runs = routeNode.get(s.name) ?? (failedOver ? row.node : stored);
    if (runs !== stored)
      notes.push(
        `service ${s.name} placed on ${runs}, where ` +
          (routeNode.has(s.name)
            ? `its route ${s.route} points`
            : "the Hub's failover redeployed the App") +
          `; the Hub's App row still says ${stored}`,
      );
    if (runs !== row.node)
      notes.push(
        `service ${s.name} runs on ${runs}, not on the App's Node ${row.node}; ` +
          `check it runs there before a redeploy keeps it there`,
      );
    return runs === stored ? s : { ...s, node: runs };
  });
  return { row: { ...row, services }, notes };
}

async function decideApp(ctx: QueryCtx, row: Rows<"apps">[number]): Promise<Decision> {
  const key = row.name;
  const app = await appOwnership(ctx, row.name);
  if (app !== null) return skip(key, app);
  const existing = await ctx.db
    .query("apps")
    .withIndex("by_name", (q) => q.eq("name", row.name))
    .unique();
  const { row: placed, notes } = await placeServices(ctx, row);
  // Hashed as placed, so an App imported before its placement was corrected is written again.
  const hash = await contentHash(placed);
  if (existing !== null && hubHash(existing) === hash) return same(key);
  const reason = notes.length === 0 ? undefined : notes.join("; ");
  return put(
    key,
    existing !== null,
    async (m) => {
      const services = [];
      for (const { node: serviceNode, ...service } of placed.services) {
        const nodeId = await optionalNode(m, serviceNode);
        services.push({ ...service, ...(nodeId === undefined ? {} : { nodeId }) });
      }
      const links = [];
      for (const { provider, consumer, ...link } of row.links) {
        links.push({
          ...link,
          providerNodeId: await node(m, provider),
          consumerNodeId: await node(m, consumer),
        });
      }
      await upsertApp(
        m,
        { name: row.name, nodeId: await node(m, row.node), services, links },
        { hash },
      );
    },
    reason,
  );
}

async function decideLink(ctx: QueryCtx, row: Rows<"links">[number]): Promise<Decision> {
  const key = row.name;
  if (await hasTombstone(ctx, "link", row.name))
    return skip(key, owned("the link was removed in Convex"));
  const existing = await ctx.db
    .query("meshLinks")
    .withIndex("by_name", (q) => q.eq("name", row.name))
    .unique();
  if (existing !== null && writtenByConvex(existing))
    return skip(key, owned("the link was written in Convex"));
  const hash = await contentHash(row);
  if (existing !== null && hubHash(existing) === hash) return same(key);
  const { provider, consumer, ...link } = row;
  return put(key, existing !== null, async (m) =>
    upsertMeshLink(
      m,
      {
        ...link,
        providerNodeId: await node(m, provider),
        consumerNodeId: await node(m, consumer),
      },
      { hash },
    ),
  );
}

/**
 * A Hub port belongs to the App its key names (`<app>/...`). Once Convex owns that App, Convex
 * allocated the ports its placement uses, and re-claiming the Hub's would hand a removed App's
 * ports back or pin a moved App to the Node it left.
 */
async function decidePort(ctx: QueryCtx, row: Rows<"ports">[number]): Promise<Decision> {
  const key = `${row.node} ${row.key}`;
  const app = appOfPortKey(row.key);
  if (app !== undefined) {
    const why = await appOwnership(ctx, app);
    if (why !== null) return skip(key, why);
  }
  const nodeId = await nodeIdByName(ctx, row.node);
  if (nodeId !== null) {
    const existing = await ctx.db
      .query("portAllocations")
      .withIndex("by_node_key", (q) => q.eq("nodeId", nodeId).eq("key", row.key))
      .unique();
    if (existing !== null && existing.port === row.port) return same(key);
    if (existing !== null && writtenByConvex(existing))
      return skip(key, owned(`Convex allocated port ${existing.port}`));
  }
  const refusal = await claimPortRefusal(ctx, {
    nodeId,
    key: row.key,
    port: row.port,
    nodeName: row.node,
  });
  if (refusal !== null) return refuse(key, refusal);
  const hash = await contentHash(row);
  return put(key, false, async (m) =>
    claimPort(
      m,
      { nodeId: await node(m, row.node), key: row.key, port: row.port, allocatedAt: Date.now() },
      { hash },
    ),
  );
}

/** One decision per variable: Convex may have set or unset any one of them. */
async function decideSecrets(
  ctx: QueryCtx,
  master: MasterKey,
  row: Rows<"secrets">[number],
): Promise<Decision[]> {
  let scope: { app: string; service?: string };
  try {
    scope = secretScope(row.app, row.service);
  } catch (e) {
    const label = row.service === undefined ? row.app : `${row.app}/${row.service}`;
    return [refuse(label, e instanceof ConvexError ? String(e.data) : String(e))];
  }
  const decisions: Decision[] = [];
  for (const [name, value] of Object.entries(row.values)) {
    const key = secretKey(scope, name);
    if (!isValidSecretName(name)) {
      decisions.push(refuse(key, `Invalid environment variable name: ${name}`));
      continue;
    }
    if (await hasTombstone(ctx, "secret", key)) {
      decisions.push(skip(key, owned("the variable was unset in Convex")));
      continue;
    }
    const stored = await storedSecret(ctx, master, scope, name);
    if (stored !== null && writtenByConvex(stored.row)) {
      decisions.push(skip(key, owned("the variable was set in Convex")));
    } else if (stored !== null && stored.value === value) {
      decisions.push(same(key));
    } else {
      decisions.push(
        put(key, stored !== null, async (m) => putSecrets(m, master, scope, { [name]: value }, {})),
      );
    }
  }
  return decisions;
}

async function decideBinding(ctx: QueryCtx, row: Rows<"gitBindings">[number]): Promise<Decision> {
  const key = `${row.repo}@${row.branch}`;
  const { buildNode, deployNode, legacyId, ...fields } = row;
  const hash = await contentHash(row);
  const write = async (m: MutationCtx) => ({
    ...fields,
    buildNodeId: await optionalNode(m, buildNode),
    deployNodeId: await optionalNode(m, deployNode),
  });
  const existing = await ctx.db
    .query("gitBindings")
    .withIndex("by_legacyId", (q) => q.eq("legacyId", legacyId))
    .unique();
  const slot = await findBinding(ctx, row.repo, row.branch);
  if (existing !== null) {
    if (writtenByConvex(existing))
      return skip(
        key,
        owned(
          existing.provenance?.by === "convex"
            ? "a Convex run recorded its result on the binding"
            : "the binding was changed in Convex",
        ),
      );
    if (hubHash(existing) === hash) return same(key);
    if (slot !== null && slot._id !== existing._id)
      return slot.legacyId === undefined || writtenByConvex(slot)
        ? skip(key, owned(`the branch is bound in Convex to App ${slot.app}`))
        : refuse(key, `Already bound: ${row.repo}@${row.branch}`);
    return put(key, true, async (m) => {
      const now = Date.now();
      await m.db.patch(existing._id, {
        ...(await write(m)),
        repoKey: repoKey(row.repo),
        provenance: provenanceFor(now, { hash }),
        updatedAt: now,
      });
    });
  }
  if (await hasTombstone(ctx, "gitBinding", bindingKey(row.repo, row.branch)))
    return skip(key, owned("the branch was unbound in Convex"));
  if (slot !== null)
    return slot.legacyId === undefined || writtenByConvex(slot)
      ? skip(key, owned(`the branch is bound in Convex to App ${slot.app}`))
      : refuse(key, `Already bound by Hub binding ${slot.legacyId}: ${row.repo}@${row.branch}`);
  const refusal = await bindingRefusal(ctx, row.repo, row.branch);
  if (refusal !== null) return refuse(key, refusal);
  return put(key, false, async (m) =>
    insertBinding(m, { ...(await write(m)), legacyId }, { hash }),
  );
}

async function decideDeployment(
  ctx: QueryCtx,
  row: Rows<"deployments">[number],
): Promise<Decision> {
  const key = row.legacyId;
  const existing = await ctx.db
    .query("appDeployments")
    .withIndex("by_legacyId", (q) => q.eq("legacyId", row.legacyId))
    .unique();
  if (existing !== null) {
    // A run still in flight on the Hub when last imported may have finished since. Convex never
    // writes a Hub run (deployments.ts sweeps skip them), so the Hub's progress is the truth.
    const { legacyId: _legacyId, app: _app, startedAt: _startedAt, ...progress } = row;
    const current = {
      stage: existing.stage,
      detail: existing.detail,
      urls: existing.urls,
      error: existing.error,
      finishedAt: existing.finishedAt,
    };
    if ((await contentHash(current)) === (await contentHash(progress))) return same(key);
    return put(key, true, async (m) => m.db.patch(existing._id, progress));
  }
  // History is trimmed to the newest DEPLOYMENTS_KEPT. A Hub run older than all of them would be
  // trimmed again the moment it was inserted.
  if ((await readCounter(ctx, "deployments")) >= DEPLOYMENTS_KEPT) {
    const oldest = await ctx.db.query("appDeployments").withIndex("by_startedAt").first();
    if (oldest !== null && oldest.startedAt >= row.startedAt)
      return skip(key, `older than the ${DEPLOYMENTS_KEPT} newest deployments Convex keeps`);
  }
  return put(key, false, async (m) =>
    createDeployment(m, { ...row, targetNodeIds: [], trigger: { kind: "hub-import" } }),
  );
}

async function decideAudit(
  ctx: QueryCtx,
  row: Rows<"audit">[number],
  through: number,
): Promise<Decision> {
  const key = `#${row.hubSeq}`;
  const existing = await ctx.db
    .query("auditEvents")
    .withIndex("by_hubSeq", (q) => q.eq("hubSeq", row.hubSeq))
    .first();
  if (existing !== null) return same(key);
  const refusal = auditRefusal(row);
  if (refusal !== null) return refuse(key, refusal);
  // Appending a Hub row older than one already imported would put it after a later one.
  if (row.hubSeq <= through)
    return refuse(
      key,
      `Hub audit row ${row.hubSeq} arrived after row ${through}; import the trail in order`,
    );
  return put(key, false, async (m) => appendAudit(m, { ...row }));
}

/**
 * Decide every row of a batch and, given a mutation context, write each one the Hub still owns.
 *
 * Every refusal is decided before the row writes anything, from the same checks the write helpers
 * enforce (claimPortRefusal, bindingRefusal, emailRefusal, auditRefusal, routeRefusal and the
 * secret name and scope rules). A refused row is reported and the next row goes on, and the dry
 * run reports the same refusals. A write is never caught: Convex rolls back writes only when the
 * mutation fails, so a row refused halfway through its write, after creating a Node say, would
 * leave that Node behind under a `refused` result. A write that throws therefore fails the whole
 * batch, which Convex rolls back and `run` reports row by row.
 */
async function processBatch(
  ctx: QueryCtx,
  batch: ImportBatch,
  writer: MutationCtx | null,
): Promise<ImportItem[]> {
  const items: ImportItem[] = [];
  const settle = async (decision: Decision) => {
    const { outcome, reason } = decision;
    if (writer !== null && decision.write !== undefined) await decision.write(writer);
    items.push({
      kind: batch.kind,
      key: decision.key,
      outcome,
      ...(reason === undefined ? {} : { reason }),
    });
    return outcome;
  };
  switch (batch.kind) {
    case "users":
      for (const decide of decideUsers(ctx, batch.rows)) await settle(await decide());
      break;
    case "routes":
      for (const row of batch.rows) await settle(await decideRoute(ctx, row));
      break;
    case "apps":
      for (const row of batch.rows) await settle(await decideApp(ctx, row));
      break;
    case "links":
      for (const row of batch.rows) await settle(await decideLink(ctx, row));
      break;
    case "ports":
      for (const row of batch.rows) await settle(await decidePort(ctx, row));
      break;
    case "secrets": {
      const master = await requireMasterKey(process.env);
      for (const row of batch.rows)
        for (const decision of await decideSecrets(ctx, master, row)) await settle(decision);
      break;
    }
    case "gitBindings":
      for (const row of batch.rows) await settle(await decideBinding(ctx, row));
      break;
    case "deployments":
      for (const row of batch.rows.toSorted((a, b) => a.startedAt - b.startedAt))
        await settle(await decideDeployment(ctx, row));
      break;
    case "audit": {
      let through = await readCounter(ctx, "hubAuditImportedThrough");
      for (const row of batch.rows.toSorted((a, b) => a.hubSeq - b.hubSeq)) {
        if ((await settle(await decideAudit(ctx, row, through))) === "created")
          through = row.hubSeq;
      }
      if (writer !== null) await writeCounter(writer, "hubAuditImportedThrough", through);
      break;
    }
  }
  return items;
}

/** Apply one batch in one transaction. Rows Convex owns are skipped, never overwritten. */
export const apply = internalMutation({
  args: { batch: importBatchValidator },
  returns: v.array(importItemValidator),
  handler: async (ctx, { batch }) => await processBatch(ctx, batch, ctx),
});

/** What `apply` would do with one batch, writing nothing. */
export const previewBatch = internalQuery({
  args: { batch: importBatchValidator },
  returns: v.array(importItemValidator),
  handler: async (ctx, { batch }) => await processBatch(ctx, batch, null),
});

// ---------------------------------------------------------------------------
// Whole runs

export const importReportValidator = v.object({
  // Rows per batch kind and outcome.
  counts: v.record(v.string(), v.record(v.string(), v.number())),
  // Every row whose outcome is not `unchanged`.
  items: v.array(importItemValidator),
});
export type ImportReport = Infer<typeof importReportValidator>;

function emptyReport(): ImportReport {
  return { counts: {}, items: [] };
}

function addItems(report: ImportReport, items: ImportItem[]) {
  for (const item of items) {
    const counts = (report.counts[item.kind] ??= {});
    counts[item.outcome] = (counts[item.outcome] ?? 0) + 1;
    if (item.outcome !== "unchanged") report.items.push(item);
  }
}

/** A batch whose transaction failed as a whole: each of its rows is refused with the reason. */
function batchFailure(batch: ImportBatch, error: unknown): ImportItem[] {
  const reason =
    error instanceof ConvexError
      ? String(error.data)
      : error instanceof Error
        ? error.message
        : String(error);
  return batch.rows.map((_, index) => ({
    kind: batch.kind,
    key: rowKey(batch, index),
    outcome: "refused" as const,
    reason,
  }));
}

/**
 * The importer's entry point. Each batch is applied in its own transaction, in the order given;
 * the script orders them so every Node, user and binding a later row names already exists. A batch
 * that fails as a whole is reported row by row and the next batch still runs.
 */
export const run = internalAction({
  args: { batches: v.array(importBatchValidator) },
  returns: importReportValidator,
  handler: async (ctx, args) => {
    const report = emptyReport();
    for (const batch of args.batches) {
      try {
        addItems(report, await ctx.runMutation(internal.infra.hubImport.apply, { batch }));
      } catch (error) {
        addItems(report, batchFailure(batch, error));
      }
    }
    return report;
  },
});

/**
 * `--dry-run`: what `run` would do, writing nothing. Each batch is judged against the deployment as
 * it is now, not as the batches before it in the same run would leave it, so a first import
 * reports a route or port of an App that does not exist yet as created, as `run` would.
 */
export const preview = internalAction({
  args: { batches: v.array(importBatchValidator) },
  returns: importReportValidator,
  handler: async (ctx, args) => {
    const report = emptyReport();
    for (const batch of args.batches) {
      try {
        addItems(report, await ctx.runQuery(internal.infra.hubImport.previewBatch, { batch }));
      } catch (error) {
        addItems(report, batchFailure(batch, error));
      }
    }
    return report;
  },
});
