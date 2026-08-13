import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

export async function deleteAttemptSecret(ctx: MutationCtx, attemptId: Doc<"attempts">["_id"]) {
  const secret = await ctx.db
    .query("attemptSecrets")
    .withIndex("by_attempt", (query) => query.eq("attemptId", attemptId))
    .unique();
  if (secret !== null) await ctx.db.delete(secret._id);
}
