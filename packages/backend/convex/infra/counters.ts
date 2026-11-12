import type { MutationCtx, QueryCtx } from "../_generated/server";

export type CounterName = "auditSeq" | "deployments";

async function counterRow(ctx: QueryCtx, name: CounterName) {
  return await ctx.db
    .query("infraCounters")
    .withIndex("by_name", (q) => q.eq("name", name))
    .unique();
}

export async function readCounter(ctx: QueryCtx, name: CounterName) {
  return (await counterRow(ctx, name))?.value ?? 0;
}

/**
 * Set a counter. Callers read and write it in one mutation, which Convex runs as a serializable
 * transaction: two concurrent callers cannot both read the same value and both commit.
 */
export async function writeCounter(ctx: MutationCtx, name: CounterName, value: number) {
  const row = await counterRow(ctx, name);
  if (row === null) {
    await ctx.db.insert("infraCounters", { name, value });
  } else if (row.value !== value) {
    await ctx.db.patch(row._id, { value });
  }
}

export async function bumpCounter(ctx: MutationCtx, name: CounterName, delta: number) {
  const next = (await readCounter(ctx, name)) + delta;
  await writeCounter(ctx, name, next);
  return next;
}
