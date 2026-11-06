import { ConvexError } from "convex/values";
import type { MutationCtx } from "../_generated/server";
import { bumpCounter } from "./counters";

export type AuditOutcome = "allow" | "deny" | "success" | "failure" | "attempt";

export type AuditInput = {
  actor: string;
  action: string;
  target?: string;
  outcome: AuditOutcome;
  dryRun?: boolean;
  meta?: Record<string, unknown>;
  /** Only the Hub importer passes these: the Hub's own timestamp and sequence number. */
  at?: number;
  hubSeq?: number;
};

const MAX_ACTION_LENGTH = 128;
const MAX_TARGET_LENGTH = 1024;

/** Why `appendAudit` would refuse `entry`, or null. */
export function auditRefusal(entry: Pick<AuditInput, "action" | "actor">) {
  const action = entry.action.trim();
  if (action.length === 0 || action.length > MAX_ACTION_LENGTH)
    return `An audit action must be 1 to ${MAX_ACTION_LENGTH} characters`;
  if (entry.actor.length === 0) return "An audit row needs an actor";
  return null;
}

/**
 * Append one audit row and return its sequence number.
 *
 * The sequence comes from the `auditSeq` counter, read and advanced in the caller's transaction.
 * Convex serializes conflicting transactions, so sequence numbers are issued in commit order with
 * no gaps or repeats, which is the total order the Hub's AUTOINCREMENT gave.
 *
 * Inside a mutation this row is as durable as the change it describes: both commit or neither
 * does. That is the Hub's `requireDurableAudit` rule by construction, and why mutations need no
 * separate check. Actions with an external side effect use `withDurableAudit` (audit.ts).
 */
export async function appendAudit(ctx: MutationCtx, entry: AuditInput) {
  const refusal = auditRefusal(entry);
  if (refusal !== null) throw new ConvexError(refusal);
  const action = entry.action.trim();
  const seq = await bumpCounter(ctx, "auditSeq", 1);
  await ctx.db.insert("auditEvents", {
    seq,
    at: entry.at ?? Date.now(),
    actor: entry.actor,
    action,
    outcome: entry.outcome,
    ...(entry.target === undefined ? {} : { target: entry.target.slice(0, MAX_TARGET_LENGTH) }),
    ...(entry.dryRun ? { dryRun: true } : {}),
    ...(entry.meta === undefined ? {} : { metaJson: JSON.stringify(entry.meta) }),
    ...(entry.hubSeq === undefined ? {} : { hubSeq: entry.hubSeq }),
  });
  return seq;
}
