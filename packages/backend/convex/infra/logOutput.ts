// The Node side of a log tail (infra/logs.ts): storing what a Node uploaded with a `logs`
// command's result. Kept apart from logs.ts so nodeCommands.ts can call it without an import
// cycle (logs.ts queues its command through nodeCommands.ts).
import { ConvexError } from "convex/values";

import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/** The most output kept, from the end. The Node truncates; Convex refuses anything larger. */
export const MAX_LOG_BYTES = 128 * 1024;

/** The longest base64 text MAX_LOG_BYTES encodes to. */
export const MAX_LOG_BASE64 = Math.ceil(MAX_LOG_BYTES / 3) * 4;

function decodeBase64(text: string) {
  if (
    text.length > MAX_LOG_BASE64 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(text) ||
    text.length % 4 !== 0
  ) {
    return null;
  }
  try {
    return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/**
 * Called from nodeCommands.report for a `logs` command, in the same transaction as the result.
 * `output` is base64 so arbitrary bytes survive JSON; it is decoded as UTF-8 with replacement.
 */
export async function recordLogOutput(
  ctx: MutationCtx,
  command: Doc<"nodeCommands">,
  result: { outcome: "success" | "failure" | "unknown"; output?: string; truncated?: boolean },
) {
  const row = await ctx.db
    .query("logTails")
    .withIndex("by_command", (q) => q.eq("commandId", command._id))
    .unique();
  // Expired or already read: nothing to keep, and the output is dropped.
  if (row === null || row.state !== "pending") return;
  if (result.outcome !== "success") {
    await ctx.db.patch(row._id, { state: "failed" });
    return;
  }
  const bytes = decodeBase64(result.output ?? "");
  if (bytes === null || bytes.length > MAX_LOG_BYTES) {
    throw new ConvexError("Log output is not base64 of at most 128 KiB");
  }
  await ctx.db.patch(row._id, {
    state: "ready",
    text: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
    truncated: result.truncated === true,
  });
}
