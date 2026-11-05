// Copies a Hub's state into Convex (ADR 0016 phase 2a). Driven by
// scripts/import-hub-state.ts, which reads portless.db and secret.key on the Hub's host and calls
// `run` with an admin key. Every apply is idempotent and keyed on what the Hub keyed on, so the
// import can run repeatedly while the Hub keeps serving; each run makes Convex match the Hub.
//
// Kept: port numbers, audit order, Hub ids (`legacyId`, `legacyHubId`, `hubSeq`), creation times,
// password hashes, and secret plaintext (re-encrypted under this deployment's master key).
// Not copied: sessions and API tokens (credentials for the Hub only; see docs/infra-management.md)
// and the AI transcript archive, which is not control state.
import { ConvexError, v, type Infer } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction, internalMutation, type MutationCtx } from "../_generated/server";
import { insertUser, normalizeEmail } from "./access";
import { appendAudit } from "./auditLog";
import { readCounter, writeCounter } from "./counters";
import { createDeployment } from "./deployments";
import { upsertApp, upsertMeshLink, upsertRoute } from "./apps";
import { findBinding, insertBinding } from "./git";
import { ensureNode } from "./nodes";
import { effectiveRole, repoKey, roleFromHubRoles } from "./policy";
import { claimPort } from "./ports";
import { putSecrets } from "./secrets";
import { requireMasterKey } from "./secretCrypto";
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

const node = (ctx: MutationCtx, name: string) => ensureNode(ctx, name, "hub-import");
const optionalNode = async (ctx: MutationCtx, name: string | undefined) =>
  name === undefined ? undefined : await node(ctx, name);

async function applyUsers(ctx: MutationCtx, rows: Extract<ImportBatch, { kind: "users" }>["rows"]) {
  // Owners first, so the first account this creates is a Hub owner and insertUser's
  // first-account-is-owner rule changes nobody's role.
  const ordered = rows.toSorted((a, b) => {
    const ownerA = roleFromHubRoles(a.roles) === "owner" ? 0 : 1;
    const ownerB = roleFromHubRoles(b.roles) === "owner" ? 0 : 1;
    return ownerA - ownerB || a.createdAt - b.createdAt;
  });
  for (const row of ordered) {
    const role = roleFromHubRoles(row.roles);
    const email = normalizeEmail(row.email);
    const imported = await ctx.db
      .query("users")
      .withIndex("by_legacyHubId", (q) => q.eq("legacyHubId", row.legacyId))
      .unique();
    if (imported !== null) continue;
    const sameEmail = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", email))
      .first();
    if (sameEmail !== null) {
      // Someone already signed in to the dashboard with this email: one person, one account.
      // Their dashboard password stays; their role is the higher of the two.
      const current = effectiveRole(sameEmail.role);
      const rank = ["viewer", "operator", "admin", "owner"];
      await ctx.db.patch(sameEmail._id, {
        legacyHubId: row.legacyId,
        role: rank.indexOf(role) > rank.indexOf(current) ? role : current,
      });
      continue;
    }
    const userId = await insertUser(ctx, {
      email,
      role,
      name: row.name,
      createdAt: row.createdAt,
      legacyHubId: row.legacyId,
    });
    const account = await ctx.db
      .query("authAccounts")
      .withIndex("providerAndAccountId", (q) =>
        q.eq("provider", "password").eq("providerAccountId", email),
      )
      .unique();
    if (account === null) {
      // The Hub's scrypt hash, verified by auth.ts until the password is next reset.
      await ctx.db.insert("authAccounts", {
        userId,
        provider: "password",
        providerAccountId: email,
        secret: row.passwordHash,
      });
    }
  }
}

async function applyAudit(ctx: MutationCtx, rows: Extract<ImportBatch, { kind: "audit" }>["rows"]) {
  let through = await readCounter(ctx, "hubAuditImportedThrough");
  for (const row of rows.toSorted((a, b) => a.hubSeq - b.hubSeq)) {
    const existing = await ctx.db
      .query("auditEvents")
      .withIndex("by_hubSeq", (q) => q.eq("hubSeq", row.hubSeq))
      .first();
    if (existing !== null) continue;
    // Appending a Hub row older than one already imported would put it after a later one.
    if (row.hubSeq <= through) {
      throw new ConvexError(
        `Hub audit row ${row.hubSeq} arrived after row ${through}; import the trail in order`,
      );
    }
    await appendAudit(ctx, { ...row });
    through = row.hubSeq;
  }
  await writeCounter(ctx, "hubAuditImportedThrough", through);
}

export const apply = internalMutation({
  args: { batch: importBatchValidator },
  returns: v.number(),
  handler: async (ctx, { batch }) => {
    switch (batch.kind) {
      case "users":
        await applyUsers(ctx, batch.rows);
        break;
      case "routes":
        for (const row of batch.rows) {
          await upsertRoute(ctx, {
            name: row.name,
            nodeId: await node(ctx, row.node),
            image: row.image,
            port: row.port,
            app: row.app,
            ...(row.service === undefined ? {} : { service: row.service }),
          });
        }
        break;
      case "apps":
        for (const row of batch.rows) {
          const services = [];
          for (const { node: serviceNode, ...service } of row.services) {
            const nodeId = await optionalNode(ctx, serviceNode);
            services.push({ ...service, ...(nodeId === undefined ? {} : { nodeId }) });
          }
          const links = [];
          for (const { provider, consumer, ...link } of row.links) {
            links.push({
              ...link,
              providerNodeId: await node(ctx, provider),
              consumerNodeId: await node(ctx, consumer),
            });
          }
          await upsertApp(ctx, {
            name: row.name,
            nodeId: await node(ctx, row.node),
            services,
            links,
          });
        }
        break;
      case "links":
        for (const { provider, consumer, ...link } of batch.rows) {
          await upsertMeshLink(ctx, {
            ...link,
            providerNodeId: await node(ctx, provider),
            consumerNodeId: await node(ctx, consumer),
          });
        }
        break;
      case "ports":
        for (const row of batch.rows) {
          await claimPort(ctx, {
            nodeId: await node(ctx, row.node),
            key: row.key,
            port: row.port,
            allocatedAt: Date.now(),
          });
        }
        break;
      case "secrets": {
        const master = await requireMasterKey(process.env);
        for (const { values, ...scope } of batch.rows) await putSecrets(ctx, master, scope, values);
        break;
      }
      case "gitBindings":
        for (const { buildNode, deployNode, legacyId, ...row } of batch.rows) {
          const fields = {
            ...row,
            buildNodeId: await optionalNode(ctx, buildNode),
            deployNodeId: await optionalNode(ctx, deployNode),
          };
          const existing = await ctx.db
            .query("gitBindings")
            .withIndex("by_legacyId", (q) => q.eq("legacyId", legacyId))
            .unique();
          if (existing === null) {
            await insertBinding(ctx, { ...fields, legacyId });
            continue;
          }
          const clash = await findBinding(ctx, row.repo, row.branch);
          if (clash !== null && clash._id !== existing._id) {
            throw new ConvexError(`Already bound: ${row.repo}@${row.branch}`);
          }
          await ctx.db.patch(existing._id, { ...fields, repoKey: repoKey(row.repo) });
        }
        break;
      case "deployments":
        for (const row of batch.rows.toSorted((a, b) => a.startedAt - b.startedAt)) {
          const existing = await ctx.db
            .query("appDeployments")
            .withIndex("by_legacyId", (q) => q.eq("legacyId", row.legacyId))
            .unique();
          if (existing === null) {
            await createDeployment(ctx, {
              ...row,
              targetNodeIds: [],
              trigger: { kind: "hub-import" },
            });
          } else {
            // A run still in flight on the Hub when last imported may have finished since.
            const { legacyId: _legacyId, app: _app, startedAt: _startedAt, ...progress } = row;
            await ctx.db.patch(existing._id, progress);
          }
        }
        break;
      case "audit":
        await applyAudit(ctx, batch.rows);
        break;
    }
    return batch.rows.length;
  },
});

/**
 * The importer's entry point. Each batch is applied in its own transaction, in the order given;
 * the script orders them so every Node, user and binding a later row names already exists.
 */
export const run = internalAction({
  args: { batches: v.array(importBatchValidator) },
  returns: v.record(v.string(), v.number()),
  handler: async (ctx, args) => {
    const counts: Record<string, number> = {};
    for (const batch of args.batches) {
      const applied = await ctx.runMutation(internal.infra.hubImport.apply, { batch });
      counts[batch.kind] = (counts[batch.kind] ?? 0) + applied;
    }
    return counts;
  },
});
