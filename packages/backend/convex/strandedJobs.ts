// Stranded job recovery.
//
// The `/runs-on` router picks a Profile when a workflow starts. If every Worker that serves the
// Profile drops after that, the job waits in GitHub's queue until GitHub cancels it 24 hours later.
// A waiting Attempt already moves to another ready Worker (reconcile.ts), so only a Profile with no
// ready Worker at all strands a job.
//
// ERAINFRA_STRANDED_JOB_ACTION chooses what happens then:
// - `wait` (the default): nothing; the job waits as before.
// - `cancel`: cancel the workflow run, so it fails within minutes instead of a day.
// - `rerun`: cancel the run, wait for it to finish cancelling, and ask GitHub to rerun it. The
//   router job runs again and, with no ready Worker, answers its GitHub-hosted fallback.
// A run is rerun at most once; a second stranding of the same run only cancels it.
// ERAINFRA_STRANDED_JOB_AFTER_MINUTES (default 5, 1 to 1440) is how long a job may wait first.
//
// Both actions need the controller's GitHub App to hold Actions: Read and write
// (docs/workflows.md, "When a Worker drops after routing").

import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { cancelUnclaimedAttempt } from "./attemptRetirement";
import { loadSchedulerSnapshot, type SchedulerSnapshot } from "./attemptScheduler";
import {
  controllerApp,
  githubApiBase,
  githubJson,
  mintInstallationToken,
} from "./controllerGithubToken";
import { schedulableWorkers } from "./routing";
import { strandedOutcomeValidator } from "./strandedJobsModel";

export type StrandedJobAction = "wait" | "cancel" | "rerun";

export const DEFAULT_STRANDED_AFTER_MINUTES = 5;
const MAX_STRANDED_AFTER_MINUTES = 1_440;
/** Waiting jobs one scan looks at. The scan runs every minute. */
const SCAN_BATCH = 50;
/** How often, and how many times, to check whether a cancelled run has finished: 5 minutes. */
export const RERUN_CHECK_INTERVAL_MS = 20_000;
export const RERUN_CHECKS = 15;
/** A row nobody marked is dropped once GitHub's own 24-hour limit has passed. */
const UNMARKED_RETENTION_MS = 25 * 60 * 60 * 1_000;
/** A stranded row stays this long, so a later stranding of the same run sees the earlier rerun. */
const STRANDED_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const PURGE_BATCH = 100;

export const PERMISSION_DETAIL =
  "GitHub refused the request: the controller's GitHub App needs the Actions: Read and write permission";

export function strandedSettings(env: Record<string, string | undefined> = process.env): {
  action: StrandedJobAction;
  afterMinutes: number;
} {
  const raw = env.ERAINFRA_STRANDED_JOB_ACTION?.trim().toLowerCase();
  const action: StrandedJobAction = raw === "cancel" || raw === "rerun" ? raw : "wait";
  const text = env.ERAINFRA_STRANDED_JOB_AFTER_MINUTES?.trim() ?? "";
  const minutes = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  const afterMinutes = Number.isSafeInteger(minutes)
    ? Math.min(MAX_STRANDED_AFTER_MINUTES, Math.max(1, minutes))
    : DEFAULT_STRANDED_AFTER_MINUTES;
  return { action, afterMinutes };
}

/** The Attempt's cancelReason. runnerCauses.ts classifies it by this wording. */
export function strandedReason(profile: string, afterMinutes: number, action: "cancel" | "rerun") {
  const base = `No ready Worker for ${profile} within ${afterMinutes} minutes; cancelled the run`;
  return action === "rerun" ? `${base} and asked GitHub to rerun it` : base;
}

/**
 * Settles the acquired job a JobStarted or JobCompleted names. An unmarked row has done its job
 * and goes; a stranded row stays as the record of what was done to its run.
 */
export async function settleScaleSetJob(
  ctx: MutationCtx,
  runnerRequestId: string | undefined,
  state: "started" | "completed",
) {
  if (runnerRequestId === undefined) return;
  const row = await ctx.db
    .query("scaleSetJobs")
    .withIndex("by_runnerRequestId", (query) => query.eq("runnerRequestId", runnerRequestId))
    .first();
  if (row === null) return;
  if (row.stranded === undefined) {
    await ctx.db.delete(row._id);
  } else if (row.state !== "completed") {
    await ctx.db.patch(row._id, { state });
  }
}

/** Records the jobs a controller acquired. A redelivered report changes nothing. */
export async function recordAcquiredJobs(
  ctx: MutationCtx,
  profile: string,
  jobs: {
    runnerRequestId: string;
    repository?: string;
    owner?: string;
    jobId?: string;
    displayName?: string;
    workflowRunId?: number;
    queueTime?: number;
  }[],
  now: number,
) {
  for (const job of jobs) {
    const known = await ctx.db
      .query("scaleSetJobs")
      .withIndex("by_runnerRequestId", (query) => query.eq("runnerRequestId", job.runnerRequestId))
      .first();
    if (known !== null) continue;
    await ctx.db.insert("scaleSetJobs", { ...job, profile, acquiredAt: now, state: "waiting" });
  }
}

/**
 * Whether this run's jobs were already handled. A job acquired before an earlier marker belongs
 * to the run attempt that marker cancelled. A job acquired after it belongs to a rerun.
 */
function earlierMarkers(row: Doc<"scaleSetJobs">, sameRun: Doc<"scaleSetJobs">[]) {
  const others = sameRun.filter((other) => other._id !== row._id && other.stranded !== undefined);
  return {
    handled: others.some((other) => row.acquiredAt <= (other.stranded?.at ?? 0)),
    rerunBefore: others.some((other) => other.stranded?.action === "rerun"),
  };
}

async function cancelOldestUnassignedAttempt(ctx: MutationCtx, profile: string, reason: string) {
  const pending = await ctx.db
    .query("attempts")
    .withIndex("by_profile_state", (query) => query.eq("profile", profile).eq("state", "pending"))
    .take(200);
  const oldest = pending
    .filter((attempt) => attempt.machineId === undefined)
    .toSorted((a, b) => a.createdAt - b.createdAt)[0];
  if (oldest !== undefined) await cancelUnclaimedAttempt(ctx, oldest, reason);
}

async function markStranded(
  ctx: MutationCtx,
  row: Doc<"scaleSetJobs">,
  settings: { action: "cancel" | "rerun"; afterMinutes: number },
  now: number,
) {
  if (row.workflowRunId === undefined || row.owner === undefined || row.repository === undefined) {
    console.warn(
      `Stranded job ${row.runnerRequestId} of ${row.profile} has no workflow run; left queued`,
    );
    await ctx.db.patch(row._id, {
      state: "completed",
      stranded: {
        action: "cancel",
        at: now,
        outcome: "failed",
        detail: "The controller did not report the job's workflow run, so the run was left queued",
      },
    });
    return;
  }
  const workflowRunId = row.workflowRunId;
  const sameRun = await ctx.db
    .query("scaleSetJobs")
    .withIndex("by_workflowRunId", (query) => query.eq("workflowRunId", workflowRunId))
    .take(500);
  const earlier = earlierMarkers(row, sameRun);
  const action = settings.action === "rerun" && !earlier.rerunBefore ? "rerun" : "cancel";
  if (earlier.handled) {
    // Another job of the same run attempt was stranded first; that one cancels the run.
    await ctx.db.patch(row._id, {
      state: "completed",
      stranded: {
        action,
        at: now,
        outcome: "cancelled",
        detail: "Handled with another job of this run",
      },
    });
    return;
  }
  await ctx.db.patch(row._id, { stranded: { action, at: now } });
  await cancelOldestUnassignedAttempt(
    ctx,
    row.profile,
    strandedReason(row.profile, settings.afterMinutes, action),
  );
  await ctx.scheduler.runAfter(0, internal.strandedJobs.cancelRun, { jobId: row._id });
}

async function purge(ctx: MutationCtx, now: number) {
  const unmarked = await ctx.db
    .query("scaleSetJobs")
    .withIndex("by_state_acquiredAt", (query) =>
      query.eq("state", "waiting").lt("acquiredAt", now - UNMARKED_RETENTION_MS),
    )
    .take(PURGE_BATCH);
  for (const row of unmarked) {
    if (row.stranded === undefined) await ctx.db.delete(row._id);
    else await ctx.db.patch(row._id, { state: "completed" });
  }
  for (const state of ["started", "completed"] as const) {
    const old = await ctx.db
      .query("scaleSetJobs")
      .withIndex("by_state_acquiredAt", (query) =>
        query.eq("state", state).lt("acquiredAt", now - STRANDED_RETENTION_MS),
      )
      .take(PURGE_BATCH);
    for (const row of old) await ctx.db.delete(row._id);
  }
}

/** The minute cron: find jobs stranded on a Profile with no ready Worker and act on them. */
/**
 * Whether a Worker that reports this Profile ready was heard from since `cutoff`. Stranded means
 * no ready Worker for the whole threshold, not just at this instant: a Worker that went quiet
 * after the cutoff dropped only recently (an agent restart, a short network blip), so its jobs
 * wait for it a little longer. The scheduler snapshot holds only Workers heard from in the last
 * few seconds, so this reads the rows itself.
 */
async function readyWorkerHeardSince(ctx: QueryCtx, profile: string, cutoff: number) {
  const rows = await ctx.db
    .query("workerReadiness")
    .withIndex("by_profile_state", (query) => query.eq("profile", profile).eq("state", "ready"))
    .take(100);
  for (const row of rows) {
    const machine = await ctx.db.get(row.machineId);
    if (machine !== null && machine.lastSeen >= cutoff) return true;
  }
  return false;
}

export const scan = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    await purge(ctx, now);
    const settings = strandedSettings();
    if (settings.action === "wait") return null;
    const action = settings.action;
    const cutoff = now - settings.afterMinutes * 60_000;
    // A marked row leaves `waiting` once its outcome is recorded, within about five minutes, so
    // the few marked rows still here cannot crowd out the unmarked ones.
    const waiting = (
      await ctx.db
        .query("scaleSetJobs")
        .withIndex("by_state_acquiredAt", (query) =>
          query.eq("state", "waiting").lte("acquiredAt", cutoff),
        )
        .take(SCAN_BATCH)
    ).filter((row) => row.stranded === undefined);
    const ready = new Map<string, boolean>();
    let snapshot: SchedulerSnapshot | undefined;
    for (const row of waiting) {
      let hasReadyWorker = ready.get(row.profile);
      if (hasReadyWorker === undefined) {
        const profile = await ctx.db
          .query("profiles")
          .withIndex("by_name", (query) => query.eq("name", row.profile))
          .unique();
        if (profile === null) {
          // A Profile removed under its jobs: nothing to judge readiness by, so leave them.
          hasReadyWorker = true;
        } else {
          snapshot ??= await loadSchedulerSnapshot(ctx, now);
          hasReadyWorker =
            schedulableWorkers(snapshot, profile, now).length > 0 ||
            (await readyWorkerHeardSince(ctx, profile.name, cutoff));
        }
        ready.set(row.profile, hasReadyWorker);
      }
      if (!hasReadyWorker)
        await markStranded(ctx, row, { action, afterMinutes: settings.afterMinutes }, now);
    }
    return null;
  },
});

export const actionTarget = internalQuery({
  args: { jobId: v.id("scaleSetJobs") },
  returns: v.union(
    v.null(),
    v.object({
      action: v.union(v.literal("cancel"), v.literal("rerun")),
      owner: v.string(),
      repository: v.string(),
      workflowRunId: v.number(),
      githubConfigUrl: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.jobId);
    if (
      row === null ||
      row.stranded === undefined ||
      row.stranded.outcome !== undefined ||
      row.owner === undefined ||
      row.repository === undefined ||
      row.workflowRunId === undefined
    ) {
      return null;
    }
    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_name", (query) => query.eq("name", row.profile))
      .unique();
    return {
      action: row.stranded.action,
      owner: row.owner,
      repository: row.repository,
      workflowRunId: row.workflowRunId,
      githubConfigUrl: profile?.githubConfigUrl,
    };
  },
});

export const recordOutcome = internalMutation({
  args: {
    jobId: v.id("scaleSetJobs"),
    outcome: strandedOutcomeValidator,
    detail: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.jobId);
    if (row?.stranded === undefined) return null;
    const message =
      `Stranded job ${row.jobId ?? row.runnerRequestId} of ${row.profile}, run ` +
      `${row.workflowRunId ?? "?"}: ${row.stranded.action} ${args.outcome}` +
      (args.detail === undefined ? "" : `. ${args.detail}`);
    if (args.outcome === "failed") console.warn(message);
    else console.log(message);
    await ctx.db.patch(row._id, {
      state: "completed",
      stranded: {
        ...row.stranded,
        outcome: args.outcome,
        ...(args.detail === undefined ? {} : { detail: args.detail.slice(0, 500) }),
      },
    });
    return null;
  },
});

type Target = {
  owner: string;
  repository: string;
  workflowRunId: number;
  githubConfigUrl?: string;
};

// Read the global at call time, so a test's stubbed fetch is the one used.
const fetchGitHub: typeof fetch = (input, init) => fetch(input, init);

type GitHubCall = { status: number; payload: unknown } | { detail: string };

/** Mints a token with Actions write for the run's repository and makes one call with it. */
async function callGitHub(
  target: Target,
  method: "GET" | "POST",
  suffix: "" | "/cancel" | "/rerun",
): Promise<GitHubCall> {
  if (target.githubConfigUrl === undefined) {
    return { detail: "The Profile has no GitHub config URL registered" };
  }
  const app = controllerApp(process.env);
  if (app === null) {
    return { detail: "This deployment holds no controller GitHub App" };
  }
  const minted = await mintInstallationToken({
    ...app,
    githubConfigUrl: target.githubConfigUrl,
    cacheFacts: false,
    now: Date.now(),
    fetch: fetchGitHub,
    permissions: { actions: "write" },
    repository: target.repository,
  });
  if (!minted.ok) {
    // GitHub answers 422 when a token asks for a permission the installation lacks.
    return { detail: minted.error.includes("answered 422") ? PERMISSION_DETAIL : minted.error };
  }
  const path =
    `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repository)}` +
    `/actions/runs/${target.workflowRunId}${suffix}`;
  return githubJson(
    { fetch: fetchGitHub },
    method,
    githubApiBase(target.githubConfigUrl) + path,
    minted.token,
  );
}

function failure(call: { status: number }, what: string) {
  if (call.status === 403) return PERMISSION_DETAIL;
  if (call.status === 0) return `GitHub did not answer the ${what} request in time`;
  return `GitHub answered ${call.status} to the ${what} request`;
}

async function record(
  ctx: ActionCtx,
  jobId: Id<"scaleSetJobs">,
  outcome: "cancelled" | "rerun-requested" | "failed",
  detail?: string,
) {
  await ctx.runMutation(internal.strandedJobs.recordOutcome, { jobId, outcome, detail });
}

export const cancelRun = internalAction({
  args: { jobId: v.id("scaleSetJobs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const target = await ctx.runQuery(internal.strandedJobs.actionTarget, args);
    if (target === null) return null;
    const call = await callGitHub(target, "POST", "/cancel");
    if ("detail" in call) {
      await record(ctx, args.jobId, "failed", call.detail);
      return null;
    }
    // 409: the run can no longer be cancelled because it already finished.
    if (call.status !== 202 && call.status !== 409) {
      await record(ctx, args.jobId, "failed", failure(call, "cancel"));
      return null;
    }
    if (target.action === "cancel") {
      await record(ctx, args.jobId, "cancelled");
      return null;
    }
    await ctx.scheduler.runAfter(RERUN_CHECK_INTERVAL_MS, internal.strandedJobs.rerunWhenDone, {
      jobId: args.jobId,
      check: 1,
    });
    return null;
  },
});

/** GitHub reruns only a completed run, so wait for the cancel to finish, then ask once. */
export const rerunWhenDone = internalAction({
  args: { jobId: v.id("scaleSetJobs"), check: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const target = await ctx.runQuery(internal.strandedJobs.actionTarget, { jobId: args.jobId });
    if (target === null) return null;
    const run = await callGitHub(target, "GET", "");
    if ("detail" in run) {
      await record(ctx, args.jobId, "failed", run.detail);
      return null;
    }
    const status = (run.payload as { status?: unknown } | null)?.status;
    if (run.status === 200 && status === "completed") {
      const rerun = await callGitHub(target, "POST", "/rerun");
      if ("detail" in rerun) await record(ctx, args.jobId, "failed", rerun.detail);
      else if (rerun.status === 201) await record(ctx, args.jobId, "rerun-requested");
      else await record(ctx, args.jobId, "failed", failure(rerun, "rerun"));
      return null;
    }
    if (run.status === 403) {
      await record(ctx, args.jobId, "failed", PERMISSION_DETAIL);
      return null;
    }
    if (args.check >= RERUN_CHECKS) {
      await record(
        ctx,
        args.jobId,
        "cancelled",
        "The run did not finish cancelling within 5 minutes, so it was not rerun",
      );
      return null;
    }
    await ctx.scheduler.runAfter(RERUN_CHECK_INTERVAL_MS, internal.strandedJobs.rerunWhenDone, {
      jobId: args.jobId,
      check: args.check + 1,
    });
    return null;
  },
});
