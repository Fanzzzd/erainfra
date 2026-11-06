import { ConvexError, v, type Infer } from "convex/values";

/**
 * Per-Attempt test results from the JUnit XML a job leaves in its workspace. The guest parses the
 * files and reports through the runtime and the Action Runner Agent (`apps/runtime/internal/
 * testreport`); this module holds the report's shape, its bounds and the pure analysis (branch,
 * revision, flaky detection, slowest tests), and `testReports.ts` stores, serves and expires it.
 *
 * Everything in a report was written by the job, so none of it is trusted: the bounds below are
 * the Go package's own, checked again here, and names and messages are only ever rendered as text.
 *
 * Nothing here touches the database, so the schema can import the validators.
 */

/** testreport.Version. */
export const TEST_REPORT_VERSION = 1;
/** How long a report and its cases are kept, and how long a flaky test stays listed unseen. */
export const TEST_RETENTION_MS = 30 * 24 * 60 * 60_000;
/** The same late-upload window as resource metrics: past it nothing writes to the Attempt. */
export const TESTS_LATE_REPORT_MS = 15 * 60_000;
/** The Go package's bounds, field for field (report.go, collect.go). */
export const MAX_CASES = 500;
export const MAX_PASSED = 20_000;
export const MAX_FILES = 200;
export const MAX_ID_BYTES = 512;
export const MAX_NAME_BYTES = 512;
export const MAX_MESSAGE_BYTES = 1024;
export const MAX_TOTAL = 10_000_000;
export const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
export const PASSED_HASH_LENGTH = 12;
/** How many earlier reports of one revision an upload is compared against. */
export const MAX_REVISION_PEERS = 20;
/** How many recent Attempts a flaky row remembers. */
export const MAX_FLAKY_ATTEMPTS = 10;

export const testStatusValidator = v.union(
  v.literal("passed"),
  v.literal("failed"),
  v.literal("errored"),
  v.literal("skipped"),
  v.literal("flaky"),
);
export type TestStatus = Infer<typeof testStatusValidator>;

export const testCaseValidator = v.object({
  id: v.string(),
  suite: v.optional(v.string()),
  name: v.string(),
  file: v.optional(v.string()),
  status: testStatusValidator,
  durationMs: v.number(),
  message: v.optional(v.string()),
  retries: v.optional(v.number()),
});
export type TestCase = Infer<typeof testCaseValidator>;

export const testTotalsValidator = v.object({
  tests: v.number(),
  passed: v.number(),
  failed: v.number(),
  errored: v.number(),
  skipped: v.number(),
  flaky: v.number(),
  durationMs: v.number(),
});
export type TestTotals = Infer<typeof testTotalsValidator>;

/** `testreport.Report`, version 1, field for field. */
export const testReportValidator = v.object({
  version: v.literal(TEST_REPORT_VERSION),
  commitSha: v.optional(v.string()),
  files: v.number(),
  truncated: v.boolean(),
  totals: testTotalsValidator,
  cases: v.union(v.array(testCaseValidator), v.null()),
  passed: v.string(),
});
export type TestReport = Infer<typeof testReportValidator>;

/** One row per Attempt that reported tests. */
export const testReportFields = {
  attemptId: v.id("attempts"),
  machineId: v.id("machines"),
  /** `owner/name`, or the bare name when the Attempt never learned its owner. */
  repository: v.optional(v.string()),
  branch: v.optional(v.string()),
  jobName: v.optional(v.string()),
  workflowRunId: v.optional(v.number()),
  commitSha: v.optional(v.string()),
  /**
   * What two Attempts must share to be runs of the same code: the commit, or failing that the
   * workflow run (a rerun keeps its run id and its commit), or failing that nothing.
   */
  revision: v.optional(v.string()),
  recordedAt: v.number(),
  files: v.number(),
  truncated: v.boolean(),
  totals: testTotalsValidator,
  /** The report's passed-id hashes, concatenated and sorted; see passedHash. */
  passed: v.string(),
};

/** One row per case a report listed: its failures, errors, flaky cases and slowest passes. */
export const testCaseFields = {
  reportId: v.id("testReports"),
  attemptId: v.id("attempts"),
  repository: v.optional(v.string()),
  branch: v.optional(v.string()),
  recordedAt: v.number(),
  testId: v.string(),
  suite: v.optional(v.string()),
  name: v.string(),
  file: v.optional(v.string()),
  status: testStatusValidator,
  durationMs: v.number(),
  message: v.optional(v.string()),
  retries: v.optional(v.number()),
};

export const flakyEvidenceValidator = v.union(
  // The test runner retried the case inside one Attempt and it passed on a later try.
  v.literal("retried"),
  // The case failed in one Attempt and passed in another of the same revision.
  v.literal("rerun"),
);
export type FlakyEvidence = Infer<typeof flakyEvidenceValidator>;

/** One row per repository and test that has been seen both failing and passing. */
export const flakyTestFields = {
  repository: v.string(),
  testId: v.string(),
  suite: v.optional(v.string()),
  name: v.string(),
  file: v.optional(v.string()),
  firstSeenAt: v.number(),
  lastSeenAt: v.number(),
  /** Uploads that showed the test flaky, at most one per Attempt. */
  occurrences: v.number(),
  lastEvidence: flakyEvidenceValidator,
  lastBranch: v.optional(v.string()),
  lastCommitSha: v.optional(v.string()),
  lastMessage: v.optional(v.string()),
  /** The most recent Attempts that showed it, newest first. */
  attemptIds: v.array(v.id("attempts")),
};

const encoder = new TextEncoder();
const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const LOWER_HEX = /^[0-9a-f]*$/;

function byteLength(value: string) {
  return encoder.encode(value).length;
}

function assertText(field: string, value: string | undefined, limit: number, required = false) {
  if (value === undefined) {
    if (required) throw new ConvexError(`Test report ${field} is missing`);
    return;
  }
  if (required && value.length === 0) throw new ConvexError(`Test report ${field} is empty`);
  if (byteLength(value) > limit) {
    throw new ConvexError(`Test report ${field} is longer than ${limit} bytes`);
  }
  // The Go package strips these (cleanText), so a report carrying one did not come from it. A
  // terminal escape in a test name would otherwise reach `erainfra tests list` verbatim.
  if (CONTROL.test(value)) {
    throw new ConvexError(`Test report ${field} holds a control character`);
  }
}

// Every C0 and C1 control character except tab and newline.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

function assertCount(value: number, max: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new ConvexError("Test report counts are out of range");
  }
}

/** testreport.Report.Validate, so a report that did not come from the Go package is refused. */
export function assertValidReport(report: TestReport) {
  if (report.commitSha !== undefined && !COMMIT.test(report.commitSha)) {
    throw new ConvexError("Test report commit is not a hex object id");
  }
  assertCount(report.files, MAX_FILES);
  const { totals } = report;
  for (const count of [
    totals.tests,
    totals.passed,
    totals.failed,
    totals.errored,
    totals.skipped,
    totals.flaky,
  ]) {
    assertCount(count, MAX_TOTAL);
  }
  if (
    totals.passed + totals.failed + totals.errored + totals.skipped + totals.flaky !==
    totals.tests
  ) {
    throw new ConvexError("Test report counts do not add up to its total");
  }
  assertCount(totals.durationMs, MAX_TOTAL * 1000);
  const cases = report.cases ?? [];
  if (cases.length > MAX_CASES || cases.length > totals.tests) {
    throw new ConvexError(`Test report lists more cases than it may`);
  }
  for (const testCase of cases) {
    assertText("case id", testCase.id, MAX_ID_BYTES, true);
    assertText("case name", testCase.name, MAX_NAME_BYTES, true);
    assertText("case suite", testCase.suite, MAX_NAME_BYTES);
    assertText("case file", testCase.file, MAX_NAME_BYTES);
    assertText("case message", testCase.message, MAX_MESSAGE_BYTES);
    assertCount(testCase.durationMs, MAX_DURATION_MS);
    if (testCase.retries !== undefined) assertCount(testCase.retries, 1000);
  }
  if (report.passed.length % PASSED_HASH_LENGTH !== 0 || !LOWER_HEX.test(report.passed)) {
    throw new ConvexError("Test report passed ids are not hex hashes");
  }
  const hashes = report.passed.length / PASSED_HASH_LENGTH;
  if (hashes > MAX_PASSED || hashes > totals.passed) {
    throw new ConvexError("Test report carries more passed ids than it may");
  }
  for (let index = 1; index < hashes; index++) {
    if (passedAt(report.passed, index - 1) >= passedAt(report.passed, index)) {
      throw new ConvexError("Test report passed ids are not sorted and unique");
    }
  }
}

function passedAt(passed: string, index: number) {
  return passed.slice(index * PASSED_HASH_LENGTH, (index + 1) * PASSED_HASH_LENGTH);
}

/** testreport.PassedHash: the first 12 hex characters of SHA-256 over the id's UTF-8 bytes. */
export async function passedHash(id: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(id)));
  return Array.from(digest.subarray(0, PASSED_HASH_LENGTH / 2), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Whether a sorted, concatenated hash string holds a hash: a binary search over fixed widths. */
export function hasPassed(passed: string, hash: string) {
  let low = 0;
  let high = passed.length / PASSED_HASH_LENGTH - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const candidate = passedAt(passed, middle);
    if (candidate === hash) return true;
    if (candidate < hash) low = middle + 1;
    else high = middle - 1;
  }
  return false;
}

/** `owner/name` from the Attempt's two fields, whichever form the controller stored. */
export function repositoryName(attempt: { repo?: string; owner?: string }) {
  if (attempt.repo === undefined || attempt.repo === "") return undefined;
  if (attempt.repo.includes("/") || attempt.owner === undefined || attempt.owner === "") {
    return attempt.repo;
  }
  return `${attempt.owner}/${attempt.repo}`;
}

/**
 * The branch a run tested, from the job's workflow ref (`owner/repo/.github/workflows/ci.yml@
 * refs/heads/main`): the branch name for a push, `pull/12/merge` for a pull request, and the
 * ref without `refs/` for anything else.
 */
export function branchFromWorkflowRef(workflowRef: string | undefined) {
  if (workflowRef === undefined) return undefined;
  const at = workflowRef.lastIndexOf("@");
  if (at < 0) return undefined;
  const ref = workflowRef.slice(at + 1);
  if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length) || undefined;
  if (ref.startsWith("refs/")) return ref.slice("refs/".length) || undefined;
  return ref || undefined;
}

/** See testReportFields.revision. */
export function revisionKey(commitSha: string | undefined, workflowRunId: number | undefined) {
  if (commitSha !== undefined) return `commit:${commitSha}`;
  if (workflowRunId !== undefined) return `run:${workflowRunId}`;
  return undefined;
}

export type FlakyFinding = {
  testCase: Pick<TestCase, "id" | "suite" | "name" | "file" | "message">;
  evidence: FlakyEvidence;
};

export type RevisionPeer = {
  /** The peer report's passed hashes. */
  passed: string;
  /** The peer report's failed and errored cases. */
  failing: Pick<TestCase, "id" | "suite" | "name" | "file" | "message">[];
};

const isFailing = (status: TestStatus) => status === "failed" || status === "errored";

/**
 * The tests one upload shows to be flaky. A case the runner itself retried into a pass is flaky
 * on its own evidence. Otherwise a test is flaky when, for the same revision, it failed in one
 * Attempt and passed in another: either this upload failed it and an earlier one passed it, or
 * the reverse. A pass is known from the passed hashes, which hold every passing test, so neither
 * side needs the other's full case list. Each test is reported once.
 */
export async function findFlaky(
  cases: TestCase[],
  passed: string,
  peers: RevisionPeer[],
): Promise<FlakyFinding[]> {
  const findings = new Map<string, FlakyFinding>();
  for (const testCase of cases) {
    if (testCase.status === "flaky") {
      findings.set(testCase.id, { testCase, evidence: "retried" });
    }
  }
  const failing = cases.filter((testCase) => isFailing(testCase.status));
  const hashes = await Promise.all(failing.map((testCase) => passedHash(testCase.id)));
  for (const peer of peers) {
    failing.forEach((testCase, index) => {
      if (!findings.has(testCase.id) && hasPassed(peer.passed, hashes[index]!)) {
        findings.set(testCase.id, { testCase, evidence: "rerun" });
      }
    });
    for (const testCase of peer.failing) {
      if (findings.has(testCase.id)) continue;
      if (hasPassed(passed, await passedHash(testCase.id))) {
        findings.set(testCase.id, { testCase, evidence: "rerun" });
      }
    }
  }
  return [...findings.values()];
}

export type SlowTest = {
  testId: string;
  suite?: string;
  name: string;
  runs: number;
  maxDurationMs: number;
  meanDurationMs: number;
  lastDurationMs: number;
  lastSeenAt: number;
};

/**
 * The slowest tests across recent runs, from the passing cases each report kept for their
 * duration (its slowest 50). Grouped by test, ordered by mean duration.
 */
export function slowestTests(
  rows: { testId: string; suite?: string; name: string; durationMs: number; recordedAt: number }[],
  limit: number,
): SlowTest[] {
  const byTest = new Map<string, SlowTest & { total: number }>();
  for (const row of rows) {
    const current = byTest.get(row.testId);
    if (current === undefined) {
      byTest.set(row.testId, {
        testId: row.testId,
        ...(row.suite === undefined ? {} : { suite: row.suite }),
        name: row.name,
        runs: 1,
        total: row.durationMs,
        maxDurationMs: row.durationMs,
        meanDurationMs: row.durationMs,
        lastDurationMs: row.durationMs,
        lastSeenAt: row.recordedAt,
      });
      continue;
    }
    current.runs++;
    current.total += row.durationMs;
    current.maxDurationMs = Math.max(current.maxDurationMs, row.durationMs);
    if (row.recordedAt > current.lastSeenAt) {
      current.lastSeenAt = row.recordedAt;
      current.lastDurationMs = row.durationMs;
    }
  }
  return [...byTest.values()]
    .map(({ total, ...test }) => ({ ...test, meanDurationMs: Math.round(total / test.runs) }))
    .toSorted((a, b) => b.meanDurationMs - a.meanDurationMs || a.testId.localeCompare(b.testId))
    .slice(0, limit);
}
