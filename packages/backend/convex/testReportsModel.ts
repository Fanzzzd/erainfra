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
/** The Go package's bounds. `testdata/test-report-limits.json` holds the values both sides test. */
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
/**
 * How many tests one upload may mark flaky: its own cases first, then earlier runs' failures it
 * passed. Each costs a read and a write of a flaky row, and the second kind a read of the earlier
 * run's case, so the cap is what keeps the upload's transaction inside Convex's limits whatever its
 * peers hold. A run that turns more than this many tests flaky at once is not reporting flakiness.
 */
export const MAX_FLAKY_FINDINGS = MAX_CASES;

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
  /** What two Attempts must share to be runs of the same code; see revisionKey. */
  revision: v.optional(v.string()),
  recordedAt: v.number(),
  files: v.number(),
  truncated: v.boolean(),
  totals: testTotalsValidator,
  /**
   * Empty. The passed-id hashes are up to 240 kB a report and live in testReportHashes, so the
   * views that read many report rows never carry them. The field stays because the schema only
   * grows.
   */
  passed: v.string(),
  /** Whether the report failed or errored any test: what the failing-runs list is indexed on. */
  failing: v.optional(v.boolean()),
};

/**
 * One row per report, beside it: the hashes flaky detection compares a later run of the same
 * revision against. Only an upload reads them, and only for its at most MAX_REVISION_PEERS peers.
 */
export const testReportHashFields = {
  reportId: v.id("testReports"),
  /** Every passing test's id hash, sorted and concatenated; see passedHash. At most 240 kB. */
  passed: v.string(),
  /** The failed and errored cases' id hashes, the same way. At most 6 kB. */
  failing: v.string(),
};

/** One row per case a report listed: its failures, errors, flaky cases and slowest passes. */
export const testCaseFields = {
  reportId: v.id("testReports"),
  attemptId: v.id("attempts"),
  repository: v.optional(v.string()),
  branch: v.optional(v.string()),
  recordedAt: v.number(),
  testId: v.string(),
  /** passedHash(testId), so an earlier run's failure found by hash is one indexed read. */
  testHash: v.optional(v.string()),
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

/** The `owner/name` a workflow ref's file lives in, or undefined when it names none. */
function workflowRefRepository(workflowRef: string) {
  const at = workflowRef.indexOf("/.github/workflows/");
  return at < 0 ? undefined : workflowRef.slice(0, at);
}

type RunFacts = {
  repo?: string;
  owner?: string;
  eventName?: string;
  workflowRef?: string;
  headBranch?: string;
  workflowRunId?: number;
  displayName?: string;
};

/**
 * The branch a run tested, as the Tests views show it.
 *
 * The controller's `headBranch` is the workflow run's own head_branch from GitHub's REST API. The
 * job's workflow ref is not a substitute: for a job of a called workflow it names the called
 * file's ref (`uses: acme/shared/.github/workflows/test.yml@main` makes it `main` whatever branch
 * was pushed). An Attempt recorded by a controller that does not send headBranch falls back to the
 * workflow ref only when that file is in the run's own repository. A called workflow in the same
 * repository at another ref still looks like the run's branch then, which is why the branch from
 * a workflow ref labels a run and never joins two (see revisionKey).
 */
export function runBranch(attempt: RunFacts) {
  if (attempt.headBranch !== undefined) return attempt.headBranch;
  const repository = repositoryName(attempt);
  const workflowRef = attempt.workflowRef;
  if (repository === undefined || workflowRef === undefined) return undefined;
  if (workflowRefRepository(workflowRef)?.toLowerCase() !== repository.toLowerCase()) {
    return undefined;
  }
  return branchFromWorkflowRef(workflowRef);
}

/**
 * Events whose runs test the code at their own branch's head, so that two runs on one branch
 * naming one commit ran the same code: a push, a schedule and a manual dispatch run the branch's
 * workflow at its commit, and a merge queue gives every group its own branch. Every other event
 * is left out. A pull request runs a merge commit its head SHA does not name, and may come from a
 * fork; `pull_request_target`, `issue_comment`, `workflow_run` and `repository_dispatch` run on
 * the default branch while often checking out someone else's code.
 */
const COMMIT_JOINED_EVENTS = new Set(["push", "schedule", "workflow_dispatch", "merge_group"]);

/**
 * What two Attempts must share to be runs of the same code, in one repository.
 *
 * The commit id comes from the job's own `.git`, which the job can write, so a commit alone would
 * let any job join any other's runs: a pull request claiming main's commit could fail main's
 * tests and so mark them flaky. A commit therefore joins runs only together with the branch, and
 * only for an event in COMMIT_JOINED_EVENTS. The branch is the workflow run's head_branch, which
 * the controller read from GitHub (see runBranch), and the event is from GitHub's JobStarted
 * message; neither is anything the job wrote. Inside that key a job can only claim another commit
 * of its own branch's runs. An Attempt without a head branch from the controller is never joined
 * by commit: its workflow ref may be a called workflow's, at any branch the caller names.
 *
 * Every other Attempt is joined by its workflow run alone. GitHub reruns a run at the commit and
 * ref it started with (docs.github.com, "Re-running workflows and jobs": a rerun "uses the same
 * GITHUB_SHA (commit SHA) and GITHUB_REF (Git ref) of the original event"), and the run id is the
 * controller's, so a rerun of a pull request still finds its flaky tests and never another run's.
 *
 * Either way the key also names the job, by GitHub's display name, which carries the matrix
 * values (`test (ubuntu, 18)`). Two legs of a matrix, or two jobs of a run, run the same commit
 * on different platforms or settings, so a test that fails on one and passes on the other is a
 * deterministic difference between them, not a flaky test. A rerun of a job keeps its name.
 */
export function revisionKey(attempt: RunFacts, commitSha: string | undefined) {
  const job = attempt.displayName ?? null;
  if (
    commitSha !== undefined &&
    attempt.headBranch !== undefined &&
    attempt.eventName !== undefined &&
    COMMIT_JOINED_EVENTS.has(attempt.eventName)
  ) {
    return `commit:${JSON.stringify([commitSha, attempt.headBranch, job])}`;
  }
  if (attempt.workflowRunId !== undefined) {
    return `run:${JSON.stringify([attempt.workflowRunId, job])}`;
  }
  return undefined;
}

export type FlakyFinding = {
  testCase: Pick<TestCase, "id" | "suite" | "name" | "file" | "message">;
  evidence: FlakyEvidence;
};

export type RevisionPeer<Ref> = {
  /** Names the peer to the caller, which reads its cases. */
  ref: Ref;
  /** The peer's passed hashes. */
  passed: string;
  /** The peer's failed and errored case hashes. */
  failing: string;
};

/** A test an earlier run failed and this upload passed. Only its hash is known here. */
export type PeerFailure<Ref> = { ref: Ref; hash: string };

export const isFailing = (status: TestStatus) => status === "failed" || status === "errored";

/** The sorted, concatenated, unique hashes of a report's failed and errored cases. */
export async function failingHashes(cases: TestCase[]) {
  const failing = cases.filter((testCase) => isFailing(testCase.status));
  const hashes = await Promise.all(failing.map((testCase) => passedHash(testCase.id)));
  return [...new Set(hashes)].toSorted().join("");
}

/**
 * The tests one upload shows to be flaky. A case the runner itself retried into a pass is flaky
 * on its own evidence. Otherwise a test is flaky when, for the same revision, it failed in one
 * Attempt and passed in another: either this upload failed it and an earlier one passed it, or
 * the reverse. Both sides are known from hashes, so no peer's case list is read: `findings` are
 * this upload's own cases, and `peerFailures` are earlier failures this upload passed, by hash,
 * for the caller to read one by one. Each test is reported once, and at most `limit` in all.
 */
export async function findFlaky<Ref>(
  cases: TestCase[],
  passed: string,
  peers: RevisionPeer<Ref>[],
  limit = MAX_FLAKY_FINDINGS,
): Promise<{ findings: FlakyFinding[]; peerFailures: PeerFailure<Ref>[] }> {
  const findings = new Map<string, FlakyFinding>();
  for (const testCase of cases) {
    if (findings.size >= limit) break;
    if (testCase.status === "flaky") {
      findings.set(testCase.id, { testCase, evidence: "retried" });
    }
  }
  const failing = cases.filter((testCase) => isFailing(testCase.status));
  const hashes = await Promise.all(failing.map((testCase) => passedHash(testCase.id)));
  failing.forEach((testCase, index) => {
    if (findings.size >= limit || findings.has(testCase.id)) return;
    if (peers.some((peer) => hasPassed(peer.passed, hashes[index]!))) {
      findings.set(testCase.id, { testCase, evidence: "rerun" });
    }
  });
  // A test this upload listed is settled by its own case above.
  const seen = new Set(await Promise.all(cases.map((testCase) => passedHash(testCase.id))));
  const peerFailures: PeerFailure<Ref>[] = [];
  for (const peer of peers) {
    const count = peer.failing.length / PASSED_HASH_LENGTH;
    for (let index = 0; index < count; index++) {
      if (findings.size + peerFailures.length >= limit) break;
      const hash = passedAt(peer.failing, index);
      if (seen.has(hash) || !hasPassed(passed, hash)) continue;
      seen.add(hash);
      peerFailures.push({ ref: peer.ref, hash });
    }
  }
  return { findings: [...findings.values()], peerFailures };
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
