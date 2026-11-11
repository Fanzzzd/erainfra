import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import { issueRegistrationToken, listMachines } from "./machines";
import { listProfiles } from "./profiles";

// Reads behind the operator API (/api/v1/*, operatorHttp.ts). Each one reuses
// the function the dashboard's query runs, so the CLI and the dashboard cannot
// disagree about what "ready" or "online" means. Authorization happens in the
// HTTP layer before any of these run; they are internal and unreachable from a
// client.

const attemptStateValidator = v.union(
  v.literal("pending"),
  v.literal("preparing"),
  v.literal("ready"),
  v.literal("running"),
  v.literal("completed"),
  v.literal("cancelled"),
  v.literal("failed"),
);

/** An Attempt as the API may show it: never the single-use JIT config. */
export type OperatorAttempt = Omit<Doc<"attempts">, "jitConfig"> & { workerName?: string };

async function withWorkerNames(ctx: QueryCtx, attempts: Doc<"attempts">[]) {
  const machineIds = [
    ...new Set(attempts.flatMap((attempt) => (attempt.machineId ? [attempt.machineId] : []))),
  ];
  const names = new Map<Id<"machines">, string>();
  for (const machineId of machineIds) {
    const machine = await ctx.db.get(machineId);
    if (machine !== null) names.set(machineId, machine.name);
  }
  return attempts.map(({ jitConfig: _jitConfig, ...attempt }): OperatorAttempt => ({
    ...attempt,
    workerName: attempt.machineId === undefined ? undefined : names.get(attempt.machineId),
  }));
}

export const profiles = internalQuery({
  args: {},
  handler: async (ctx) => await listProfiles(ctx),
});

export const workers = internalQuery({
  args: {},
  handler: async (ctx) => await listMachines(ctx),
});

/**
 * One page of Attempts, newest first. Profile, state and `since` are answered
 * from an index, so a page reads only what it returns; `repo` is a filter over
 * that range, and a page filtered by it can come back shorter than asked for
 * while `isDone` is still false. That is Convex's pagination contract and the
 * reason the API returns a cursor rather than a page number.
 *
 * `since` bounds `_creationTime`, which the controller's createAttempt sets in
 * the same mutation that writes `createdAt`.
 */
export const attempts = internalQuery({
  args: {
    profile: v.optional(v.string()),
    state: v.optional(attemptStateValidator),
    repo: v.optional(v.string()),
    since: v.optional(v.number()),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const since = args.since ?? 0;
    const { profile, state } = args;
    const ranged =
      profile !== undefined && state !== undefined
        ? ctx.db
            .query("attempts")
            .withIndex("by_profile_state", (q) =>
              q.eq("profile", profile).eq("state", state).gte("_creationTime", since),
            )
        : profile !== undefined
          ? ctx.db
              .query("attempts")
              .withIndex("by_profile", (q) => q.eq("profile", profile).gte("_creationTime", since))
          : state !== undefined
            ? ctx.db
                .query("attempts")
                .withIndex("by_state", (q) => q.eq("state", state).gte("_creationTime", since))
            : ctx.db
                .query("attempts")
                .withIndex("by_creation_time", (q) => q.gte("_creationTime", since));

    const repo = args.repo;
    const filtered =
      repo === undefined
        ? ranged
        : ranged.filter((q) => {
            // JobStarted carries the repository's name and its owner separately,
            // so `owner/name` matches either a stored full name or the pair.
            const [owner, name] = repo.split("/");
            return name === undefined
              ? q.eq(q.field("repo"), repo)
              : q.or(
                  q.eq(q.field("repo"), repo),
                  q.and(q.eq(q.field("repo"), name), q.eq(q.field("owner"), owner)),
                );
          });

    const result = await filtered.order("desc").paginate(args.paginationOpts);
    return {
      page: await withWorkerNames(ctx, result.page),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

export const attempt = internalQuery({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("attempts", args.id);
    if (id === null) return null;
    const found = await ctx.db.get(id);
    if (found === null) return null;
    const [named] = await withWorkerNames(ctx, [found]);
    return named;
  },
});

/** The dashboard's Add Worker action. */
export const createRegistrationToken = internalMutation({
  args: {},
  returns: v.object({ token: v.string(), expiresAt: v.number() }),
  handler: async (ctx) => await issueRegistrationToken(ctx),
});
