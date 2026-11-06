import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { requireDashboardAuth } from "./dashboardAuth";
import {
  assertValidReport,
  branchFromWorkflowRef,
  findFlaky,
  MAX_CASES,
  MAX_FLAKY_ATTEMPTS,
  MAX_REVISION_PEERS,
  repositoryName,
  revisionKey,
  slowestTests,
  TEST_RETENTION_MS,
  TESTS_LATE_REPORT_MS,
  type FlakyFinding,
  type RevisionPeer,
  type TestReport,
} from "./testReportsModel";

/** Stores, serves and expires per-Attempt JUnit results; see testReportsModel.ts. */

const PURGE_REPORTS = 10;
const PURGE_FLAKY = 200;
/** Read bounds for the views: a page of runs, and the passing cases the slowest list is built from. */
const MAX_RUNS = 100;
const MAX_SLOW_ROWS = 2000;
const MAX_FAILURES_PER_RUN = 20;
const MAX_REPOSITORY_SCAN = 300;

/**
 * Stores one Attempt's report. Returns false when the Attempt is not this Worker's to write or no
 * longer accepts writes, true when the report is stored or was already. The first report for an
 * Attempt wins: the Agent sends exactly one, so a second is a replay.
 *
 * Storing a report is also when flakiness is detected, against at most MAX_REVISION_PEERS earlier
 * reports of the same revision, so reading the flaky list never compares runs.
 */
export async function recordAttemptTests(
  ctx: MutationCtx,
  machineId: Id<"machines">,
  args: { attemptId: Id<"attempts">; report: TestReport },
  now = Date.now(),
): Promise<boolean> {
  const attempt = await ctx.db.get(args.attemptId);
  if (attempt === null || attempt.machineId !== machineId) return false;
  if (attempt.finishedAt !== undefined && now - attempt.finishedAt > TESTS_LATE_REPORT_MS) {
    return false;
  }
  const { report } = args;
  assertValidReport(report);
  const existing = await ctx.db
    .query("testReports")
    .withIndex("by_attempt", (q) => q.eq("attemptId", attempt._id))
    .first();
  if (existing !== null) return true;

  const repository = repositoryName(attempt);
  const branch = branchFromWorkflowRef(attempt.workflowRef);
  const revision =
    repository === undefined ? undefined : revisionKey(report.commitSha, attempt.workflowRunId);
  const cases = report.cases ?? [];
  const reportId = await ctx.db.insert("testReports", {
    attemptId: attempt._id,
    machineId,
    repository,
    branch,
    jobName: attempt.displayName,
    workflowRunId: attempt.workflowRunId,
    commitSha: report.commitSha,
    revision,
    recordedAt: now,
    files: report.files,
    truncated: report.truncated,
    totals: report.totals,
    passed: report.passed,
  });
  for (const testCase of cases) {
    await ctx.db.insert("testCases", {
      reportId,
      attemptId: attempt._id,
      repository,
      branch,
      recordedAt: now,
      testId: testCase.id,
      suite: testCase.suite,
      name: testCase.name,
      file: testCase.file,
      status: testCase.status,
      durationMs: testCase.durationMs,
      message: testCase.message,
      retries: testCase.retries,
    });
  }
  if (repository === undefined) return true;

  const peers: RevisionPeer[] = [];
  if (revision !== undefined) {
    const peerReports = await ctx.db
      .query("testReports")
      .withIndex("by_repository_revision", (q) =>
        q.eq("repository", repository).eq("revision", revision),
      )
      .order("desc")
      .take(MAX_REVISION_PEERS + 1);
    for (const peer of peerReports) {
      if (peer._id === reportId) continue;
      const failing = await ctx.db
        .query("testCases")
        .withIndex("by_report", (q) => q.eq("reportId", peer._id))
        .filter((q) => q.or(q.eq(q.field("status"), "failed"), q.eq(q.field("status"), "errored")))
        .take(MAX_CASES);
      peers.push({
        passed: peer.passed,
        failing: failing.map((row) => ({
          id: row.testId,
          suite: row.suite,
          name: row.name,
          file: row.file,
          message: row.message,
        })),
      });
    }
  }
  const findings = await findFlaky(cases, report.passed, peers);
  for (const finding of findings) {
    await recordFlaky(ctx, repository, attempt, branch, report.commitSha, finding, now);
  }
  return true;
}

async function recordFlaky(
  ctx: MutationCtx,
  repository: string,
  attempt: Doc<"attempts">,
  branch: string | undefined,
  commitSha: string | undefined,
  finding: FlakyFinding,
  now: number,
) {
  const { testCase, evidence } = finding;
  const row = await ctx.db
    .query("flakyTests")
    .withIndex("by_repository_test", (q) =>
      q.eq("repository", repository).eq("testId", testCase.id),
    )
    .unique();
  const latest = {
    lastSeenAt: now,
    lastEvidence: evidence,
    lastBranch: branch,
    lastCommitSha: commitSha,
    lastMessage: testCase.message,
  };
  if (row === null) {
    await ctx.db.insert("flakyTests", {
      repository,
      testId: testCase.id,
      suite: testCase.suite,
      name: testCase.name,
      file: testCase.file,
      firstSeenAt: now,
      occurrences: 1,
      attemptIds: [attempt._id],
      ...latest,
    });
    return;
  }
  if (row.attemptIds.includes(attempt._id)) return;
  await ctx.db.patch(row._id, {
    ...latest,
    occurrences: row.occurrences + 1,
    attemptIds: [attempt._id, ...row.attemptIds].slice(0, MAX_FLAKY_ATTEMPTS),
  });
}

// ---------------------------------------------------------------------------
// Reads. Each is bounded by an index range and a take, and shared by the dashboard (behind
// requireDashboardAuth) and the operator API (behind an API token, in operatorHttp.ts).

export type RunsFilter = {
  repository?: string;
  since?: number;
  failedOnly?: boolean;
  limit: number;
};

async function readRuns(ctx: QueryCtx, filter: RunsFilter) {
  const since = filter.since ?? 0;
  const { repository } = filter;
  const ranged =
    repository === undefined
      ? ctx.db.query("testReports").withIndex("by_recordedAt", (q) => q.gte("recordedAt", since))
      : ctx.db
          .query("testReports")
          .withIndex("by_repository_recordedAt", (q) =>
            q.eq("repository", repository).gte("recordedAt", since),
          );
  const filtered = filter.failedOnly
    ? ranged.filter((q) =>
        q.or(q.gt(q.field("totals.failed"), 0), q.gt(q.field("totals.errored"), 0)),
      )
    : ranged;
  const reports = await filtered.order("desc").take(Math.min(filter.limit, MAX_RUNS));
  return await Promise.all(
    reports.map(async (report) => {
      const [attempt, failures] = await Promise.all([
        ctx.db.get(report.attemptId),
        ctx.db
          .query("testCases")
          .withIndex("by_report", (q) => q.eq("reportId", report._id))
          .filter((q) => q.neq(q.field("status"), "passed"))
          .take(MAX_FAILURES_PER_RUN),
      ]);
      return {
        reportId: report._id,
        attemptId: report.attemptId,
        repository: report.repository,
        branch: report.branch,
        jobName: report.jobName,
        workflowRunId: report.workflowRunId,
        commitSha: report.commitSha,
        recordedAt: report.recordedAt,
        files: report.files,
        truncated: report.truncated,
        totals: report.totals,
        profile: attempt?.profile,
        runnerName: attempt?.runnerName,
        result: attempt?.result,
        failures: failures.map(caseView),
      };
    }),
  );
}

function caseView(row: Doc<"testCases">) {
  return {
    testId: row.testId,
    suite: row.suite,
    name: row.name,
    file: row.file,
    status: row.status,
    durationMs: row.durationMs,
    message: row.message,
    retries: row.retries,
  };
}

export type ListFilter = { repository?: string; since?: number; limit: number };

async function readFlaky(ctx: QueryCtx, filter: ListFilter) {
  const since = filter.since ?? 0;
  const { repository } = filter;
  const rows =
    repository === undefined
      ? ctx.db.query("flakyTests").withIndex("by_lastSeen", (q) => q.gte("lastSeenAt", since))
      : ctx.db
          .query("flakyTests")
          .withIndex("by_repository_lastSeen", (q) =>
            q.eq("repository", repository).gte("lastSeenAt", since),
          );
  const found = await rows.order("desc").take(Math.min(filter.limit, MAX_RUNS));
  return found.map((row) => ({
    repository: row.repository,
    testId: row.testId,
    suite: row.suite,
    name: row.name,
    file: row.file,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    occurrences: row.occurrences,
    lastEvidence: row.lastEvidence,
    lastBranch: row.lastBranch,
    lastCommitSha: row.lastCommitSha,
    lastMessage: row.lastMessage,
    attemptIds: row.attemptIds,
  }));
}

async function readSlowest(ctx: QueryCtx, filter: ListFilter) {
  const since = filter.since ?? 0;
  const { repository } = filter;
  const rows =
    repository === undefined
      ? ctx.db
          .query("testCases")
          .withIndex("by_status_recordedAt", (q) =>
            q.eq("status", "passed").gte("recordedAt", since),
          )
      : ctx.db
          .query("testCases")
          .withIndex("by_repository_status_recordedAt", (q) =>
            q.eq("repository", repository).eq("status", "passed").gte("recordedAt", since),
          );
  const recent = await rows.order("desc").take(MAX_SLOW_ROWS);
  return slowestTests(recent, Math.min(filter.limit, MAX_RUNS));
}

async function readRepositories(ctx: QueryCtx) {
  const recent = await ctx.db
    .query("testReports")
    .withIndex("by_recordedAt")
    .order("desc")
    .take(MAX_REPOSITORY_SCAN);
  return [
    ...new Set(recent.flatMap((row) => (row.repository === undefined ? [] : [row.repository]))),
  ].toSorted();
}

async function readAttempt(ctx: QueryCtx, attemptId: Id<"attempts">) {
  const report = await ctx.db
    .query("testReports")
    .withIndex("by_attempt", (q) => q.eq("attemptId", attemptId))
    .first();
  if (report === null) return null;
  const cases = await ctx.db
    .query("testCases")
    .withIndex("by_report", (q) => q.eq("reportId", report._id))
    .take(MAX_CASES);
  return {
    repository: report.repository,
    branch: report.branch,
    commitSha: report.commitSha,
    recordedAt: report.recordedAt,
    files: report.files,
    truncated: report.truncated,
    totals: report.totals,
    cases: cases.map(caseView),
  };
}

const listArgs = {
  repository: v.optional(v.string()),
  since: v.optional(v.number()),
  limit: v.optional(v.number()),
};

function limitOf(limit: number | undefined) {
  return Math.max(1, Math.min(Math.floor(limit ?? 50), MAX_RUNS));
}

/** The Tests page: recent runs with their failures. */
export const runs = query({
  args: { ...listArgs, failedOnly: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    await requireDashboardAuth(ctx);
    return await readRuns(ctx, { ...args, limit: limitOf(args.limit) });
  },
});

/** The Tests page: tests seen failing and passing. */
export const flaky = query({
  args: listArgs,
  handler: async (ctx, args) => {
    await requireDashboardAuth(ctx);
    return await readFlaky(ctx, { ...args, limit: limitOf(args.limit) });
  },
});

/** The Tests page: the slowest passing tests across recent runs. */
export const slowest = query({
  args: listArgs,
  handler: async (ctx, args) => {
    await requireDashboardAuth(ctx);
    return await readSlowest(ctx, { ...args, limit: limitOf(args.limit) });
  },
});

/** The Tests page's repository picker. */
export const repositories = query({
  args: {},
  handler: async (ctx) => {
    await requireDashboardAuth(ctx);
    return await readRepositories(ctx);
  },
});

/** The Attempt page's test section. */
export const forAttempt = query({
  args: { attemptId: v.id("attempts") },
  handler: async (ctx, args) => {
    await requireDashboardAuth(ctx);
    return await readAttempt(ctx, args.attemptId);
  },
});

/** The operator API's `GET /api/v1/tests`. */
export const operatorRuns = internalQuery({
  args: { ...listArgs, failedOnly: v.optional(v.boolean()) },
  handler: async (ctx, args) => await readRuns(ctx, { ...args, limit: limitOf(args.limit) }),
});

/** The operator API's `GET /api/v1/tests/flaky`. */
export const operatorFlaky = internalQuery({
  args: listArgs,
  handler: async (ctx, args) => await readFlaky(ctx, { ...args, limit: limitOf(args.limit) }),
});

/**
 * Deletes reports recorded before the retention window with their cases, and flaky rows not seen
 * within it, a bounded batch per transaction; schedules itself again while a batch was full.
 */
export const purgeExpired = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const cutoff = Date.now() - TEST_RETENTION_MS;
    const reports = await ctx.db
      .query("testReports")
      .withIndex("by_recordedAt", (q) => q.lt("recordedAt", cutoff))
      .take(PURGE_REPORTS);
    for (const report of reports) {
      const cases = await ctx.db
        .query("testCases")
        .withIndex("by_report", (q) => q.eq("reportId", report._id))
        .take(MAX_CASES);
      for (const row of cases) await ctx.db.delete(row._id);
      await ctx.db.delete(report._id);
    }
    const flakyRows = await ctx.db
      .query("flakyTests")
      .withIndex("by_lastSeen", (q) => q.lt("lastSeenAt", cutoff))
      .take(PURGE_FLAKY);
    for (const row of flakyRows) await ctx.db.delete(row._id);
    if (reports.length === PURGE_REPORTS || flakyRows.length === PURGE_FLAKY) {
      await ctx.scheduler.runAfter(0, internal.testReports.purgeExpired, {});
    }
    return reports.length + flakyRows.length;
  },
});
