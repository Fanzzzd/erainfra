import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { parseTestsQuery } from "../convex/operatorTestsHttp";
import schema from "../convex/schema";
import {
  branchFromWorkflowRef,
  hasPassed,
  MAX_CASES,
  MAX_MESSAGE_BYTES,
  passedHash,
  repositoryName,
  slowestTests,
  TEST_RETENTION_MS,
  TESTS_LATE_REPORT_MS,
  type TestCase,
  type TestReport,
} from "../convex/testReportsModel";

const modules = import.meta.glob("../convex/**/*.ts");
type Harness = TestConvex<typeof schema>;
const IMAGE = `ghcr.io/fanzzzd/runner@sha256:${"a".repeat(64)}`;
const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
const T0 = Date.parse("2026-11-01T00:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

function failed(id: string, message = "assertion failed"): TestCase {
  const [suite, name] = id.split("::") as [string, string];
  return { id, suite, name, status: "failed", durationMs: 10, message };
}

/**
 * A report as testreport.Build makes one: `cases` are the notable ones, `passing` every passing id
 * (the slowest of which may also be listed in `cases`).
 */
async function report(
  cases: TestCase[],
  passing: string[],
  extra: Partial<TestReport> = {},
): Promise<TestReport> {
  const hashes = [...new Set(await Promise.all(passing.map(passedHash)))].toSorted();
  const count = (status: TestCase["status"]) =>
    cases.filter((testCase) => testCase.status === status).length;
  const totals = {
    passed: passing.length,
    failed: count("failed"),
    errored: count("errored"),
    skipped: 0,
    flaky: count("flaky"),
    durationMs: 1000,
  };
  return {
    version: 1,
    files: 1,
    truncated: false,
    totals: {
      ...totals,
      tests: totals.passed + totals.failed + totals.errored + totals.flaky,
    },
    cases,
    passed: hashes.join(""),
    ...extra,
  };
}

async function setup(t: Harness) {
  return await t.run(async (ctx) => {
    const machine = { os: "linux" as const, labels: [], maxSlots: 2, usedSlots: 1, lastSeen: T0 };
    const machineId = await ctx.db.insert("machines", {
      ...machine,
      name: "linux-a",
      token: "machine-token",
    });
    await ctx.db.insert("machines", { ...machine, name: "linux-b", token: "other-token" });
    return machineId;
  });
}

let runnerCounter = 0;
async function attempt(
  t: Harness,
  machineId: Id<"machines">,
  fields: Partial<{
    repo: string;
    owner: string;
    workflowRunId: number;
    workflowRef: string;
    headBranch: string | undefined;
    eventName: string;
    finishedAt: number;
    displayName: string;
  }> = {},
) {
  runnerCounter++;
  return await t.run(async (ctx) =>
    ctx.db.insert("attempts", {
      profile: "erainfra-4vcpu-ubuntu-2404",
      executor: "firecracker",
      imageRelease: IMAGE,
      vcpus: 4,
      memoryMiB: 16_384,
      runnerName: `runner-${runnerCounter}`,
      runnerId: runnerCounter,
      state: "running",
      machineId,
      createdAt: T0,
      repo: "app",
      owner: "acme",
      workflowRunId: 100,
      workflowRef: "acme/app/.github/workflows/ci.yml@refs/heads/main",
      headBranch: "main",
      eventName: "push",
      displayName: "test",
      ...fields,
    }),
  );
}

function send(t: Harness, attemptId: Id<"attempts">, body: TestReport, token = "machine-token") {
  return t.mutation(api.workerApi.reportAttemptTests, { token, attemptId, report: body });
}

async function tables(t: Harness) {
  return await t.run(async (ctx) => ({
    reports: await ctx.db.query("testReports").collect(),
    cases: await ctx.db.query("testCases").collect(),
    flaky: await ctx.db.query("flakyTests").collect(),
  }));
}

describe("test report ingestion", () => {
  it("accepts a report only from the Worker that ran the Attempt, once", async () => {
    const t = convexTest(schema, modules);
    const machineId = await setup(t);
    const attemptId = await attempt(t, machineId);
    const body = await report([failed("pkg::TestA")], ["pkg::TestB"], { commitSha: COMMIT_A });

    await expect(send(t, attemptId, body, "forged")).rejects.toThrow("Invalid machine token");
    expect(await send(t, attemptId, body, "other-token")).toBe(false);
    expect((await tables(t)).reports).toHaveLength(0);

    expect(await send(t, attemptId, body)).toBe(true);
    expect(await send(t, attemptId, body)).toBe(true);
    const { reports, cases } = await tables(t);
    expect(reports).toHaveLength(1);
    expect(cases).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      repository: "acme/app",
      branch: "main",
      jobName: "test",
      commitSha: COMMIT_A,
      revision: `commit:${JSON.stringify([COMMIT_A, "main", "test"])}`,
      // The hashes live beside the report, so the views reading many reports never carry them.
      passed: "",
      failing: true,
    });
    const hashes = await t.run(async (ctx) => ctx.db.query("testReportHashes").collect());
    expect(hashes).toEqual([
      expect.objectContaining({
        reportId: reports[0]!._id,
        passed: body.passed,
        failing: await passedHash("pkg::TestA"),
      }),
    ]);
    expect(cases[0]).toMatchObject({
      testId: "pkg::TestA",
      status: "failed",
      repository: "acme/app",
    });
  });

  it("accepts the report the Go package writes, byte for byte", async () => {
    const golden = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL(
            "../../../apps/runtime/internal/testreport/testdata/report.golden.json",
            import.meta.url,
          ),
        ),
        "utf8",
      ),
    ) as TestReport;
    const t = convexTest(schema, modules);
    const machineId = await setup(t);
    const attemptId = await attempt(t, machineId);
    expect(await send(t, attemptId, golden)).toBe(true);
    const { reports, cases, flaky } = await tables(t);
    expect(reports[0]!.totals).toEqual(golden.totals);
    expect(cases).toHaveLength(golden.cases!.length);
    // Two cases the runners retried into a pass: gotestsum's rerun and Surefire's flakyFailure.
    expect(flaky.map((row) => row.testId).toSorted()).toEqual([
      "com.example.CalculatorTest::connects",
      "github.com/example/app/store::TestRace",
    ]);
    // The Go hashes are the ones this side computes.
    expect(
      hasPassed(golden.passed, await passedHash("github.com/example/app/store::TestOpen")),
    ).toBe(true);
  });

  it("refuses writes past the late window", async () => {
    const t = convexTest(schema, modules);
    const machineId = await setup(t);
    const attemptId = await attempt(t, machineId, {
      finishedAt: T0 - TESTS_LATE_REPORT_MS - 1,
    });
    expect(await send(t, attemptId, await report([], ["a"]))).toBe(false);
  });

  it("refuses a report that breaks a bound the Go package enforces", async () => {
    const t = convexTest(schema, modules);
    const machineId = await setup(t);
    const attemptId = await attempt(t, machineId);
    const valid = await report([failed("s::a")], ["s::b", "s::c"]);
    const broken: [string, TestReport][] = [
      ["counts", { ...valid, totals: { ...valid.totals, tests: valid.totals.tests + 1 } }],
      ["unsorted hashes", { ...valid, passed: valid.passed.slice(12) + valid.passed.slice(0, 12) }],
      ["ragged hashes", { ...valid, passed: valid.passed + "abc" }],
      ["uppercase hashes", { ...valid, passed: valid.passed.toUpperCase() }],
      ["message", { ...valid, cases: [failed("s::a", "m".repeat(MAX_MESSAGE_BYTES + 1))] }],
      ["empty id", { ...valid, cases: [{ ...failed("s::a"), id: "" }] }],
      [
        "terminal escape",
        { ...valid, cases: [{ ...failed("s::a"), name: "a\u001b]0;pwned\u0007" }] },
      ],
      ["commit", { ...valid, commitSha: "main" }],
      ["negative", { ...valid, totals: { ...valid.totals, durationMs: -1 } }],
      [
        "too many cases",
        {
          ...valid,
          cases: Array.from({ length: MAX_CASES + 1 }, (_, i) => failed(`s::${i}`)),
          totals: { ...valid.totals, failed: MAX_CASES + 1, tests: MAX_CASES + 3 },
        },
      ],
    ];
    for (const [name, body] of broken) {
      await expect(send(t, attemptId, body), name).rejects.toThrow();
    }
    expect((await tables(t)).reports).toHaveLength(0);
  });
});

describe("flaky detection", () => {
  it("flags a test that failed and then passed on a rerun of the same commit", async () => {
    const t = convexTest(schema, modules);
    const machineId = await setup(t);
    const first = await attempt(t, machineId);
    const rerun = await attempt(t, machineId);
    const third = await attempt(t, machineId, { workflowRunId: 101 });

    await send(
      t,
      first,
      await report([failed("pkg::TestRace", "lost update")], ["pkg::TestOk"], {
        commitSha: COMMIT_A,
      }),
    );
    expect((await tables(t)).flaky).toHaveLength(0);

    vi.setSystemTime(T0 + 60_000);
    await send(
      t,
      rerun,
      await report([], ["pkg::TestRace", "pkg::TestOk"], { commitSha: COMMIT_A }),
    );
    let { flaky } = await tables(t);
    expect(flaky).toHaveLength(1);
    expect(flaky[0]).toMatchObject({
      repository: "acme/app",
      testId: "pkg::TestRace",
      occurrences: 1,
      lastEvidence: "rerun",
      lastCommitSha: COMMIT_A,
      lastMessage: "lost update",
      attemptIds: [rerun],
      lastSeenAt: T0 + 60_000,
    });

    // Another run of the same commit fails it again: a second occurrence.
    vi.setSystemTime(T0 + 120_000);
    await send(
      t,
      third,
      await report([failed("pkg::TestRace")], ["pkg::TestOk"], { commitSha: COMMIT_A }),
    );
    ({ flaky } = await tables(t));
    expect(flaky).toHaveLength(1);
    expect(flaky[0]!.occurrences).toBe(2);
    expect(flaky[0]!.attemptIds).toEqual([third, rerun]);
  });

  it("does not call a test flaky across different commits or repositories", async () => {
    const t = convexTest(schema, modules);
    const machineId = await setup(t);
    const onA = await attempt(t, machineId);
    const onB = await attempt(t, machineId);
    const otherRepo = await attempt(t, machineId, { repo: "other" });
    await send(t, onA, await report([failed("pkg::TestX")], [], { commitSha: COMMIT_A }));
    await send(t, onB, await report([], ["pkg::TestX"], { commitSha: COMMIT_B }));
    await send(t, otherRepo, await report([], ["pkg::TestX"], { commitSha: COMMIT_A }));
    expect((await tables(t)).flaky).toHaveLength(0);
  });

  it("falls back to the workflow run when the guest found no commit", async () => {
    const t = convexTest(schema, modules);
    const machineId = await setup(t);
    const first = await attempt(t, machineId, { workflowRunId: 7 });
    const rerun = await attempt(t, machineId, { workflowRunId: 7 });
    const otherRun = await attempt(t, machineId, { workflowRunId: 8 });
    await send(t, first, await report([], ["pkg::TestY"]));
    await send(t, otherRun, await report([failed("pkg::TestY")], []));
    expect((await tables(t)).flaky).toHaveLength(0);
    await send(t, rerun, await report([failed("pkg::TestY")], []));
    const { flaky } = await tables(t);
    expect(flaky.map((row) => [row.testId, row.lastEvidence])).toEqual([["pkg::TestY", "rerun"]]);
  });

  // The commit is the job's own claim, so a job that names main's commit must not be compared
  // with main's runs unless GitHub, through the controller, says it ran main's push-like event.
  it.each([
    [
      "a pull request",
      "pull_request",
      "acme/app/.github/workflows/ci.yml@refs/pull/7/merge",
      "fix",
    ],
    // A reusable workflow's job carries the callee's ref, so this one names main.
    [
      "a pull request calling a workflow at main",
      "pull_request",
      "acme/app/.github/workflows/reusable.yml@refs/heads/main",
      "fix",
    ],
    [
      "pull_request_target",
      "pull_request_target",
      "acme/app/.github/workflows/ci.yml@refs/heads/main",
      "fix",
    ],
    [
      "a comment command on main",
      "issue_comment",
      "acme/app/.github/workflows/ci.yml@refs/heads/main",
      "main",
    ],
    [
      "a push to another branch",
      "push",
      "acme/app/.github/workflows/ci.yml@refs/heads/feature",
      "feature",
    ],
    [
      "a push to another branch calling a workflow of its own repository at main",
      "push",
      "acme/app/.github/workflows/reusable.yml@refs/heads/main",
      "feature",
    ],
    [
      "a push calling another repository's workflow at main",
      "push",
      "mallory/tools/.github/workflows/test.yml@refs/heads/main",
      "feature",
    ],
    // A controller that does not send the run's head branch: the workflow ref may be a callee's.
    [
      "a push whose controller sent no head branch",
      "push",
      "acme/app/.github/workflows/ci.yml@refs/heads/main",
      undefined,
    ],
    [
      "an Attempt with no event",
      undefined,
      "acme/app/.github/workflows/ci.yml@refs/heads/main",
      "main",
    ],
  ])(
    "never lets %s that claims main's commit mark main's tests flaky",
    async (_, eventName, workflowRef, headBranch) => {
      const t = convexTest(schema, modules);
      const machineId = await setup(t);
      const tests = ["pkg::TestA", "pkg::TestB"];
      const main = await attempt(t, machineId, { workflowRunId: 100 });
      await send(t, main, await report([], tests, { commitSha: COMMIT_A }));
      const other = await attempt(t, machineId, {
        workflowRunId: 200,
        workflowRef,
        eventName,
        headBranch,
      });
      // Every test fails, and the report names main's commit.
      await send(
        t,
        other,
        await report(
          tests.map((id) => failed(id)),
          [],
          { commitSha: COMMIT_A },
        ),
      );
      expect((await tables(t)).flaky).toHaveLength(0);
    },
  );

  it("still finds a pull request's flaky test on a rerun of its own workflow run", async () => {
    const t = convexTest(schema, modules);
    const machineId = await setup(t);
    const fields = {
      workflowRunId: 300,
      eventName: "pull_request",
      workflowRef: "acme/app/.github/workflows/ci.yml@refs/pull/7/merge",
      headBranch: "fix",
    };
    const first = await attempt(t, machineId, fields);
    const rerun = await attempt(t, machineId, fields);
    const otherRun = await attempt(t, machineId, { ...fields, workflowRunId: 301 });
    await send(t, first, await report([failed("pkg::TestZ")], [], { commitSha: COMMIT_B }));
    // Another run of the same pull request and claimed commit is not compared.
    await send(t, otherRun, await report([], ["pkg::TestZ"], { commitSha: COMMIT_B }));
    expect((await tables(t)).flaky).toHaveLength(0);
    await send(t, rerun, await report([], ["pkg::TestZ"], { commitSha: COMMIT_B }));
    const { flaky } = await tables(t);
    expect(flaky.map((row) => [row.testId, row.lastBranch])).toEqual([["pkg::TestZ", "fix"]]);
  });

  it("does not call a deterministic failure on one matrix leg flaky", async () => {
    const t = convexTest(schema, modules);
    const machineId = await setup(t);
    // One push run, two legs: the test always fails on one and passes on the other.
    const linux = await attempt(t, machineId, { workflowRunId: 500, displayName: "test (linux)" });
    const node18 = await attempt(t, machineId, {
      workflowRunId: 500,
      displayName: "test (node 18)",
    });
    await send(t, linux, await report([], ["pkg::TestPath"], { commitSha: COMMIT_A }));
    await send(t, node18, await report([failed("pkg::TestPath")], [], { commitSha: COMMIT_A }));
    // The same goes for two runs of the commit, and for a leg with no commit.
    const nextRun = await attempt(t, machineId, {
      workflowRunId: 501,
      displayName: "test (linux)",
    });
    await send(t, nextRun, await report([], ["pkg::TestPath"], { commitSha: COMMIT_A }));
    const noCommit = await attempt(t, machineId, {
      workflowRunId: 500,
      displayName: "test (linux)",
    });
    await send(t, noCommit, await report([], ["pkg::TestPath"]));
    expect((await tables(t)).flaky).toHaveLength(0);
    // A rerun of the failing leg that passes is the flaky evidence.
    const rerun = await attempt(t, machineId, {
      workflowRunId: 502,
      displayName: "test (node 18)",
    });
    await send(t, rerun, await report([], ["pkg::TestPath"], { commitSha: COMMIT_A }));
    const { flaky } = await tables(t);
    expect(flaky.map((row) => [row.testId, row.attemptIds])).toEqual([["pkg::TestPath", [rerun]]]);
  });

  it.each([
    [
      "the run's head branch",
      "acme/shared/.github/workflows/test.yml@refs/heads/main",
      "feature",
      "feature",
    ],
    [
      "a head branch over its own workflow ref",
      "acme/app/.github/workflows/ci.yml@refs/heads/main",
      "feature",
      "feature",
    ],
    [
      "a fork's branch as GitHub's owner:branch",
      "acme/app/.github/workflows/ci.yml@refs/pull/7/merge",
      "mallory:main",
      "mallory:main",
    ],
    // Without a head branch from the controller, only a workflow file of the run's own repository.
    [
      "its own workflow ref",
      "acme/app/.github/workflows/ci.yml@refs/heads/feature",
      undefined,
      "feature",
    ],
    [
      "its own workflow ref in another case",
      "Acme/App/.github/workflows/ci.yml@refs/heads/feature",
      undefined,
      "feature",
    ],
    [
      "no branch for another repository's workflow",
      "acme/shared/.github/workflows/test.yml@refs/heads/main",
      undefined,
      undefined,
    ],
  ])("labels a report with %s", async (_, workflowRef, headBranch, branch) => {
    const t = convexTest(schema, modules);
    const machineId = await setup(t);
    const attemptId = await attempt(t, machineId, { workflowRunId: 200, workflowRef, headBranch });
    await send(t, attemptId, await report([failed("pkg::TestA")], [], { commitSha: COMMIT_B }));
    const { reports, cases } = await tables(t);
    expect(reports[0]!.branch).toBe(branch);
    expect(cases[0]!.branch).toBe(branch);
  });

  it("compares a scheduled run with a push of the same commit on the same branch", async () => {
    const t = convexTest(schema, modules);
    const machineId = await setup(t);
    const push = await attempt(t, machineId, { workflowRunId: 400 });
    const nightly = await attempt(t, machineId, { workflowRunId: 401, eventName: "schedule" });
    await send(t, push, await report([], ["pkg::TestN"], { commitSha: COMMIT_A }));
    await send(t, nightly, await report([failed("pkg::TestN")], [], { commitSha: COMMIT_A }));
    expect((await tables(t)).flaky.map((row) => row.testId)).toEqual(["pkg::TestN"]);
  });

  it("flags a case the test runner retried into a pass inside one Attempt", async () => {
    const t = convexTest(schema, modules);
    const machineId = await setup(t);
    const attemptId = await attempt(t, machineId);
    const retried: TestCase = {
      id: "com.example.FooTest::connects",
      suite: "com.example.FooTest",
      name: "connects",
      status: "flaky",
      durationMs: 1200,
      message: "Connection reset",
      retries: 1,
    };
    await send(t, attemptId, await report([retried], ["com.example.FooTest::adds"]));
    const { flaky } = await tables(t);
    expect(flaky).toHaveLength(1);
    expect(flaky[0]).toMatchObject({ lastEvidence: "retried", lastMessage: "Connection reset" });
  });
});

function slow(id: string, durationMs: number): TestCase {
  return { id, suite: id.split("::")[0], name: id.split("::")[1]!, status: "passed", durationMs };
}

describe("test result views", () => {
  async function seeded() {
    const t = convexTest(schema, modules);
    const machineId = await setup(t);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", { email: "o@example.test" }));
    const operator = t.withIdentity({ subject: `${userId}|session` });
    const green = await attempt(t, machineId, { displayName: "unit" });
    const red = await attempt(t, machineId, { displayName: "unit" });
    await send(
      t,
      green,
      await report(
        [slow("s::<script>alert(1)</script>", 900), slow("s::fast", 100)],
        ["s::<script>alert(1)</script>", "s::fast", "s::broken"],
        { commitSha: COMMIT_A },
      ),
    );
    vi.setSystemTime(T0 + 1000);
    await send(
      t,
      red,
      await report(
        [failed("s::broken"), slow("s::<script>alert(1)</script>", 1100)],
        ["s::<script>alert(1)</script>", "s::fast"],
        { commitSha: COMMIT_A },
      ),
    );
    return { t, operator, green, red };
  }

  it("keeps the dashboard queries behind dashboard authentication", async () => {
    const { t, operator, red } = await seeded();
    await expect(t.query(api.testReports.runs, {})).rejects.toThrow("Authentication required");
    await expect(t.query(api.testReports.flaky, {})).rejects.toThrow("Authentication required");
    await expect(t.query(api.testReports.forAttempt, { attemptId: red })).rejects.toThrow(
      "Authentication required",
    );

    const runs = await operator.query(api.testReports.runs, { repository: "acme/app" });
    expect(runs.map((run) => run.attemptId)).toEqual([red, expect.anything()]);
    expect(runs[0]!.failures.map((failure) => failure.testId)).toEqual(["s::broken"]);
    const failedOnly = await operator.query(api.testReports.runs, { failedOnly: true });
    expect(failedOnly.map((run) => run.attemptId)).toEqual([red]);

    const slowest = await operator.query(api.testReports.slowest, { repository: "acme/app" });
    expect(slowest[0]).toMatchObject({
      testId: "s::<script>alert(1)</script>",
      runs: 2,
      meanDurationMs: 1000,
      maxDurationMs: 1100,
      lastDurationMs: 1100,
    });
    const flaky = await operator.query(api.testReports.flaky, {});
    expect(flaky.map((row) => row.testId)).toEqual(["s::broken"]);
    expect(await operator.query(api.testReports.repositories, {})).toEqual(["acme/app"]);
    const detail = await operator.query(api.testReports.forAttempt, { attemptId: red });
    expect(detail?.totals.failed).toBe(1);
    expect(detail?.cases).toHaveLength(2);
  });

  it("serves runs and flaky tests on the operator API as JSON text", async () => {
    const { t, operator, red } = await seeded();
    const unauthenticated = await t.fetch("/api/v1/tests", { method: "GET" });
    expect(unauthenticated.status).toBe(401);

    const { token } = await operator.mutation(api.apiTokens.create, { name: "ci", scope: "read" });
    const headers = { Authorization: `Bearer ${token}` };
    const response = await t.fetch("/api/v1/tests?repo=acme/app&failed=true&since=7d", {
      method: "GET",
      headers,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { runs: Record<string, unknown>[] };
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]).toMatchObject({
      attemptId: red,
      repository: "acme/app",
      branch: "main",
      job: "unit",
      commit: COMMIT_A,
      recordedAt: new Date(T0 + 1000).toISOString(),
      profile: "erainfra-4vcpu-ubuntu-2404",
      failures: [
        {
          id: "s::broken",
          suite: "s",
          name: "broken",
          file: null,
          status: "failed",
          durationMs: 10,
          message: "assertion failed",
          retries: 0,
        },
      ],
    });

    const flaky = await t.fetch("/api/v1/tests/flaky", { method: "GET", headers });
    const flakyBody = (await flaky.json()) as { flakyTests: Record<string, unknown>[] };
    expect(flakyBody.flakyTests[0]).toMatchObject({
      repository: "acme/app",
      id: "s::broken",
      evidence: "rerun",
      occurrences: 1,
      attemptIds: [red],
    });

    const bad = await t.fetch("/api/v1/tests/flaky?failed=true", { method: "GET", headers });
    expect(bad.status).toBe(400);
  });

  it("parses the operator API's filters strictly", () => {
    const now = T0;
    expect(
      parseTestsQuery(new URLSearchParams("repo=acme/app&since=24h&limit=5"), now, {
        failedFlag: true,
      }),
    ).toEqual({
      ok: true,
      query: { repository: "acme/app", since: now - 86_400_000, limit: 5 },
    });
    for (const query of [
      "repo=app",
      "repo=a/b/c",
      "limit=0",
      "limit=101",
      "failed=yes",
      "cursor=x",
      "since=soon",
    ]) {
      expect(parseTestsQuery(new URLSearchParams(query), now, { failedFlag: true }).ok, query).toBe(
        false,
      );
    }
  });
});

describe("test result retention", () => {
  it("purges reports, their cases and flaky rows past the window", async () => {
    const t = convexTest(schema, modules);
    const machineId = await setup(t);
    const old = await attempt(t, machineId);
    const rerun = await attempt(t, machineId);
    await send(t, old, await report([failed("s::x")], ["s::y"], { commitSha: COMMIT_A }));
    await send(t, rerun, await report([], ["s::x", "s::y"], { commitSha: COMMIT_A }));
    vi.setSystemTime(T0 + TEST_RETENTION_MS / 2);
    const fresh = await attempt(t, machineId, { workflowRunId: 900 });
    await send(t, fresh, await report([failed("s::z")], [], { commitSha: COMMIT_B }));

    vi.setSystemTime(T0 + TEST_RETENTION_MS + 1);
    await t.mutation(internal.testReports.purgeExpired, {});
    const { reports, cases, flaky } = await tables(t);
    expect(reports.map((row) => row.attemptId)).toEqual([fresh]);
    expect(cases.map((row) => row.testId)).toEqual(["s::z"]);
    expect(flaky).toHaveLength(0);
  });
});

describe("test report model", () => {
  it("hashes ids exactly as the Go package does", async () => {
    // SHA-256("abc") = ba7816bf8f01cfea…; testreport.PassedHash keeps 12 hex characters.
    expect(await passedHash("abc")).toBe("ba7816bf8f01");
    const sorted = (await Promise.all(["a", "b", "c", "d"].map(passedHash))).toSorted();
    const joined = sorted.join("");
    for (const hash of sorted) expect(hasPassed(joined, hash)).toBe(true);
    expect(hasPassed(joined, "000000000000")).toBe(false);
    expect(hasPassed("", sorted[0]!)).toBe(false);
  });

  it("reads branches from workflow refs and names repositories", () => {
    expect(branchFromWorkflowRef("o/r/.github/workflows/ci.yml@refs/heads/feature/x")).toBe(
      "feature/x",
    );
    expect(branchFromWorkflowRef("o/r/.github/workflows/ci.yml@refs/pull/12/merge")).toBe(
      "pull/12/merge",
    );
    expect(branchFromWorkflowRef("o/r/.github/workflows/ci.yml@refs/tags/v1")).toBe("tags/v1");
    expect(branchFromWorkflowRef(undefined)).toBeUndefined();
    expect(branchFromWorkflowRef("no-ref")).toBeUndefined();
    expect(repositoryName({ repo: "app", owner: "acme" })).toBe("acme/app");
    expect(repositoryName({ repo: "acme/app" })).toBe("acme/app");
    expect(repositoryName({ repo: "app" })).toBe("app");
    expect(repositoryName({})).toBeUndefined();
  });

  it("orders the slowest tests by mean duration", () => {
    const rows = [
      { testId: "a", name: "a", durationMs: 100, recordedAt: 1 },
      { testId: "a", name: "a", durationMs: 300, recordedAt: 2 },
      { testId: "b", name: "b", durationMs: 250, recordedAt: 1 },
      { testId: "c", name: "c", durationMs: 10, recordedAt: 1 },
    ];
    expect(slowestTests(rows, 2)).toEqual([
      {
        testId: "b",
        name: "b",
        runs: 1,
        maxDurationMs: 250,
        meanDurationMs: 250,
        lastDurationMs: 250,
        lastSeenAt: 1,
      },
      {
        testId: "a",
        name: "a",
        runs: 2,
        maxDurationMs: 300,
        meanDurationMs: 200,
        lastDurationMs: 300,
        lastSeenAt: 2,
      },
    ]);
  });
});
