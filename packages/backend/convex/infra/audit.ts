import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation, query, type ActionCtx } from "../_generated/server";
import { requirePermission } from "./access";
import { appendAudit, type AuditInput } from "./auditLog";
import { auditOutcomeValidator } from "./tables";

const auditEntryArgs = {
  actor: v.string(),
  action: v.string(),
  target: v.optional(v.string()),
  outcome: auditOutcomeValidator,
  dryRun: v.optional(v.boolean()),
  meta: v.optional(v.record(v.string(), v.any())),
};

/** For actions, which cannot write the database themselves. Returns the row's sequence number. */
export const append = internalMutation({
  args: auditEntryArgs,
  returns: v.number(),
  handler: async (ctx, args) => await appendAudit(ctx, args),
});

/**
 * Run an external side effect only after its audit row is durable.
 *
 * The Hub's `requireDurableAudit` wrote an `attempt` row and refused when the write failed. In an
 * action the same rule takes this shape: the `attempt` row is committed by its own mutation before
 * `effect` starts, and if that mutation throws, `effect` never runs. The outcome is recorded after.
 * A side effect expressed as a database write needs none of this: appendAudit in the same mutation
 * commits with it or not at all.
 */
export async function withDurableAudit<T>(
  ctx: Pick<ActionCtx, "runMutation">,
  entry: Omit<AuditInput, "outcome" | "at" | "hubSeq">,
  effect: () => Promise<T>,
): Promise<T> {
  await ctx.runMutation(internal.infra.audit.append, { ...entry, outcome: "attempt" });
  let result: T;
  try {
    result = await effect();
  } catch (error) {
    await ctx.runMutation(internal.infra.audit.append, {
      ...entry,
      outcome: "failure",
      meta: { ...entry.meta, error: error instanceof Error ? error.message : String(error) },
    });
    throw error;
  }
  await ctx.runMutation(internal.infra.audit.append, { ...entry, outcome: "success" });
  return result;
}

const auditRowValidator = v.object({
  seq: v.number(),
  at: v.number(),
  actor: v.string(),
  action: v.string(),
  target: v.optional(v.string()),
  outcome: auditOutcomeValidator,
  dryRun: v.optional(v.boolean()),
  meta: v.optional(v.any()),
});

/** Newest first, like the Hub's `audit.list`. `before` pages back from a sequence number. */
export const list = query({
  args: { limit: v.optional(v.number()), before: v.optional(v.number()) },
  returns: v.array(auditRowValidator),
  handler: async (ctx, args) => {
    await requirePermission(ctx, "audit.read");
    const limit = Math.min(Math.max(Math.floor(args.limit ?? 100), 1), 500);
    const rows = await ctx.db
      .query("auditEvents")
      .withIndex("by_seq", (q) => (args.before === undefined ? q : q.lt("seq", args.before!)))
      .order("desc")
      .take(limit);
    return rows.map((row) => ({
      seq: row.seq,
      at: row.at,
      actor: row.actor,
      action: row.action,
      target: row.target,
      outcome: row.outcome,
      dryRun: row.dryRun,
      meta: row.metaJson === undefined ? undefined : JSON.parse(row.metaJson),
    }));
  },
});
