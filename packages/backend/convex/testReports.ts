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
  failingHashes,
  findFlaky,
  isFailing,
  MAX_CASES,
  MAX_FLAKY_ATTEMPTS,
  MAX_REVISION_PEERS,
  passedHash,
  repositoryName,
  revisionKey,
  slowestTests,
  TEST_RETENTION_MS,
  TESTS_LATE_REPORT_MS,
  type FlakyFinding,
  type RevisionPeer,
  type TestReport,
} from "./testReportsModel";

/**
 * Stores, serves and expires per-Attempt JUnit results; see testReportsModel.ts.
 *
 * Every function here stays inside one Convex transaction's limits (16 MiB read, 16 MiB written,
 * 32,000 documents read, 4,096 queries) at the bounds a report may reach: 500 cases of about
 * 2.6 kB each, 20,000 passed hashes (240 kB), and 30 days of reports. That is why the hashes live
 * in their own table, why every read is an index range with a take, and why the purge deletes a
 * budget of cases per transaction. testReportLimits.test.ts runs them at those sizes.
 */

/** Cases one purge transaction deletes, at most 2.6 MB, with at most PURGE_REPORTS reports. */
const PURGE_CASES = 1000;
const PURGE_REPORTS = 10;
const PURGE_FLAKY = 200;
/**
 * Read bounds for the views: a page of runs (each with its first failures), the passing cases
 * the slowest list is built from (2,000 cases is at most 5.2 MB), and the repository picker.
 */
const MAX_RUNS = 100;
const MAX_SLOW_ROWS = 2000;
const MAX_FAILURES_PER_RUN = 20;
const MAX_REPOSITORIES = 200;

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
  const revision = repository === undefined ? undefined : revisionKey(attempt, report.commitSha);
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
    passed: "",
    failing: report.totals.failed + report.totals.errored > 0,
  });
  await ctx.db.insert("testReportHashes", {
    reportId,
    passed: report.passed,
    failing: await failingHashes(cases),
  });
  const caseHashes = await Promise.all(cases.map((testCase) => passedHash(testCase.id)));
  for (const [index, testCase] of cases.entries()) {
    await ctx.db.insert("testCases", {
      reportId,
      attemptId: attempt._id,
      repository,
      branch,
      recordedAt: now,
      testId: testCase.id,
      testHash: caseHashes[index],
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

  // At most MAX_REVISION_PEERS hash rows (about 5 MB), then at most MAX_FLAKY_FINDINGS single
  // cases: no peer's case list is ever read whole.
  const peers: RevisionPeer<Id<"testReports">>[] = [];
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
      const hashes = await ctx.db
        .query("testReportHashes")
        .withIndex("by_report", (q) => q.eq("reportId", peer._id))
        .first();
      // A report stored before the hashes had their own table kept its passes inline and no
      // failing hashes; it can still show this upload's failures to be flaky.
      peers.push({
        ref: peer._id,
        passed: hashes?.passed ?? peer.passed,
        failing: hashes?.failing ?? "",
      });
    }
  }
  const { findings, peerFailures } = await findFlaky(cases, report.passed, peers);
  const flaky = new Map(findings.map((finding) => [finding.testCase.id, finding]));
  for (const { ref, hash } of peerFailures) {
    const row = await ctx.db
      .query("testCases")
      .withIndex("by_report_testHash", (q) => q.eq("reportId", ref).eq("testHash", hash))
      .first();
    if (row === null || !isFailing(row.status) || flaky.has(row.testId)) continue;
    flaky.set(row.testId, {
      testCase: {
        id: row.testId,
        suite: row.suite,
        name: row.name,
        file: row.file,
        message: row.message,
      },
      evidence: "rerun",
    });
  }
  for (const finding of flaky.values()) {
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

function reportsSince(ctx: QueryCtx, filter: RunsFilter) {
  const since = filter.since ?? 0;
  const { repository } = filter;
  if (filter.failedOnly) {
    return repository === undefined
      ? ctx.db
          .query("testReports")
          .withIndex("by_failing_recordedAt", (q) => q.eq("failing", true).gte("recordedAt", since))
      : ctx.db
          .query("testReports")
          .withIndex("by_repository_failing_recordedAt", (q) =>
            q.eq("repository", repository).eq("failing", true).gte("recordedAt", since),
          );
  }
  return repository === undefined
    ? ctx.db.query("testReports").withIndex("by_recordedAt", (q) => q.gte("recordedAt", since))
    : ctx.db
        .query("testReports")
        .withIndex("by_repository_recordedAt", (q) =>
          q.eq("repository", repository).gte("recordedAt", since),
        );
}

/**
 * A report's first listed cases other than passes. Statuses sort errored, failed, flaky, passed,
 * skipped, so the cases below "passed" come first and the skipped ones fill what is left.
 */
async function reportFailures(ctx: QueryCtx, reportId: Id<"testReports">) {
  const failing = await ctx.db
    .query("testCases")
    .withIndex("by_report_status", (q) => q.eq("reportId", reportId).lt("status", "passed"))
    .take(MAX_FAILURES_PER_RUN);
  if (failing.length >= MAX_FAILURES_PER_RUN) return failing;
  const skipped = await ctx.db
    .query("testCases")
    .withIndex("by_report_status", (q) => q.eq("reportId", reportId).gt("status", "passed"))
    .take(MAX_FAILURES_PER_RUN - failing.length);
  return [...failing, ...skipped];
}

async function readRuns(ctx: QueryCtx, filter: RunsFilter) {
  const reports = await reportsSince(ctx, filter)
    .order("desc")
    .take(Math.min(filter.limit, MAX_RUNS));
  return await Promise.all(
    reports.map(async (report) => {
      const [attempt, failures] = await Promise.all([
        ctx.db.get(report.attemptId),
        reportFailures(ctx, report._id),
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

/**
 * Every repository with a report in the retention window, in name order: one indexed read per
 * repository, each starting past the last name found, so the cost is the number of repositories
 * and not the number of reports. A report with no repository sorts before every name.
 */
async function readRepositories(ctx: QueryCtx) {
  const names: string[] = [];
  let after = "";
  while (names.length < MAX_REPOSITORIES) {
    const next = await ctx.db
      .query("testReports")
      .withIndex("by_repository_recordedAt", (q) => q.gt("repository", after))
      .first();
    if (next?.repository === undefined) break;
    names.push(next.repository);
    after = next.repository;
  }
  return names;
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
 * Deletes reports recorded before the retention window with their hashes and cases, and flaky
 * rows not seen within it. One transaction deletes at most PURGE_CASES cases across at most
 * PURGE_REPORTS reports: a report whose cases do not fit is left for the next transaction, which
 * finishes its cases before deleting it, so no report is ever too big to purge and one large
 * repository cannot stall retention for the rest. The purge schedules itself again while it left
 * work behind. Returns how many rows it deleted.
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
    let deleted = 0;
    let budget = PURGE_CASES;
    let more = reports.length === PURGE_REPORTS;
    for (const report of reports) {
      if (budget === 0) {
        more = true;
        break;
      }
      const cases = await ctx.db
        .query("testCases")
        .withIndex("by_report", (q) => q.eq("reportId", report._id))
        .take(budget);
      for (const row of cases) await ctx.db.delete(row._id);
      deleted += cases.length;
      if (cases.length === budget) {
        // Possibly more cases left; the report goes once they are gone.
        more = true;
        break;
      }
      budget -= cases.length;
      const hashes = await ctx.db
        .query("testReportHashes")
        .withIndex("by_report", (q) => q.eq("reportId", report._id))
        .first();
      if (hashes !== null) {
        await ctx.db.delete(hashes._id);
        deleted++;
      }
      await ctx.db.delete(report._id);
      deleted++;
    }
    const flakyRows = await ctx.db
      .query("flakyTests")
      .withIndex("by_lastSeen", (q) => q.lt("lastSeenAt", cutoff))
      .take(PURGE_FLAKY);
    for (const row of flakyRows) await ctx.db.delete(row._id);
    deleted += flakyRows.length;
    if (more || flakyRows.length === PURGE_FLAKY) {
      await ctx.scheduler.runAfter(0, internal.testReports.purgeExpired, {});
    }
    return deleted;
  },
});
