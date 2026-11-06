import type { HttpRouter } from "convex/server";
import { internal } from "./_generated/api";
import {
  API_PREFIX,
  apiError,
  apiJson,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  operatorRoute,
  parseSince,
} from "./operatorHttp";

// The operator API's view of JUnit results: what `erainfra tests list` and `erainfra tests flaky`
// read. The same conventions as operatorHttp.ts: absent values are null, times are RFC 3339 in
// UTC, durations are integer milliseconds. Test names and messages are the job's own text and are
// returned as JSON strings, never as markup.

// A repository as the control plane stores it for test results: `owner/name`.
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

export type TestsQuery = {
  repository?: string;
  since?: number;
  limit: number;
  failedOnly?: boolean;
};

export function parseTestsQuery(
  params: URLSearchParams,
  now: number,
  options: { failedFlag: boolean },
): { ok: true; query: TestsQuery } | { ok: false; error: string } {
  const known = new Set(["repo", "since", "limit", ...(options.failedFlag ? ["failed"] : [])]);
  for (const key of params.keys()) {
    if (!known.has(key)) return { ok: false, error: `unknown parameter ${key}` };
  }
  const query: TestsQuery = { limit: DEFAULT_PAGE_SIZE };
  const repo = params.get("repo");
  if (repo !== null) {
    if (!REPOSITORY.test(repo)) return { ok: false, error: "repo must be owner/name" };
    query.repository = repo;
  }
  const since = params.get("since");
  if (since !== null) {
    const parsed = parseSince(since, now);
    if (parsed === null) {
      return { ok: false, error: "since must be a span such as 24h or 7d, or an RFC 3339 time" };
    }
    query.since = parsed;
  }
  const limit = params.get("limit");
  if (limit !== null) {
    const parsed = /^[0-9]{1,3}$/.test(limit) ? Number(limit) : NaN;
    if (!(parsed >= 1 && parsed <= MAX_PAGE_SIZE)) {
      return { ok: false, error: `limit must be an integer from 1 to ${MAX_PAGE_SIZE}` };
    }
    query.limit = parsed;
  }
  const failed = params.get("failed");
  if (failed !== null) {
    if (failed !== "true" && failed !== "false") {
      return { ok: false, error: "failed must be true or false" };
    }
    query.failedOnly = failed === "true";
  }
  return { ok: true, query };
}

function iso(ms: number | undefined) {
  return ms === undefined ? null : new Date(ms).toISOString();
}

type Case = {
  testId: string;
  suite?: string;
  name: string;
  file?: string;
  status: string;
  durationMs: number;
  message?: string;
  retries?: number;
};

export function testCaseJson(testCase: Case) {
  return {
    id: testCase.testId,
    suite: testCase.suite ?? null,
    name: testCase.name,
    file: testCase.file ?? null,
    status: testCase.status,
    durationMs: testCase.durationMs,
    message: testCase.message ?? null,
    retries: testCase.retries ?? 0,
  };
}

type Run = {
  attemptId: string;
  repository?: string;
  branch?: string;
  jobName?: string;
  workflowRunId?: number;
  commitSha?: string;
  recordedAt: number;
  files: number;
  truncated: boolean;
  totals: {
    tests: number;
    passed: number;
    failed: number;
    errored: number;
    skipped: number;
    flaky: number;
    durationMs: number;
  };
  profile?: string;
  runnerName?: string;
  result?: string;
  failures: Case[];
};

export function testRunJson(run: Run) {
  return {
    attemptId: run.attemptId,
    repository: run.repository ?? null,
    branch: run.branch ?? null,
    job: run.jobName ?? null,
    workflowRunId: run.workflowRunId ?? null,
    commit: run.commitSha ?? null,
    recordedAt: iso(run.recordedAt),
    profile: run.profile ?? null,
    runner: run.runnerName ?? null,
    result: run.result ?? null,
    files: run.files,
    truncated: run.truncated,
    totals: run.totals,
    failures: run.failures.map(testCaseJson),
  };
}

type Flaky = {
  repository: string;
  testId: string;
  suite?: string;
  name: string;
  file?: string;
  firstSeenAt: number;
  lastSeenAt: number;
  occurrences: number;
  lastEvidence: string;
  lastBranch?: string;
  lastCommitSha?: string;
  lastMessage?: string;
  attemptIds: string[];
};

export function flakyTestJson(row: Flaky) {
  return {
    repository: row.repository,
    id: row.testId,
    suite: row.suite ?? null,
    name: row.name,
    file: row.file ?? null,
    firstSeenAt: iso(row.firstSeenAt),
    lastSeenAt: iso(row.lastSeenAt),
    occurrences: row.occurrences,
    evidence: row.lastEvidence,
    branch: row.lastBranch ?? null,
    commit: row.lastCommitSha ?? null,
    message: row.lastMessage ?? null,
    attemptIds: row.attemptIds,
  };
}

export function registerTestRoutes(http: HttpRouter) {
  http.route({
    path: `${API_PREFIX}/tests`,
    method: "GET",
    handler: operatorRoute("read", async (ctx, request) => {
      const parsed = parseTestsQuery(new URL(request.url).searchParams, Date.now(), {
        failedFlag: true,
      });
      if (!parsed.ok) return apiError(400, "invalid_request", parsed.error);
      const runs = await ctx.runQuery(internal.testReports.operatorRuns, parsed.query);
      return apiJson({ runs: runs.map(testRunJson) }, 200);
    }),
  });

  http.route({
    path: `${API_PREFIX}/tests/flaky`,
    method: "GET",
    handler: operatorRoute("read", async (ctx, request) => {
      const parsed = parseTestsQuery(new URL(request.url).searchParams, Date.now(), {
        failedFlag: false,
      });
      if (!parsed.ok) return apiError(400, "invalid_request", parsed.error);
      const rows = await ctx.runQuery(internal.testReports.operatorFlaky, parsed.query);
      return apiJson({ flakyTests: rows.map(flakyTestJson) }, 200);
    }),
  });
}
