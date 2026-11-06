import { convexTest, type TestConvex } from "convex-test";
import { getDocumentSize } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import {
  MAX_CASES,
  MAX_FLAKY_FINDINGS,
  MAX_ID_BYTES,
  MAX_MESSAGE_BYTES,
  MAX_NAME_BYTES,
  MAX_PASSED,
  MAX_REVISION_PEERS,
  passedHash,
  PASSED_HASH_LENGTH,
  TEST_RETENTION_MS,
  type TestCase,
  type TestReport,
} from "../convex/testReportsModel";

// Every test here runs with Convex's per-transaction limits enforced (16 MiB read and written,
// 32,000 documents read, 4,096 queries), at the largest report the bounds allow: 500 cases with
// every text field near its byte bound, and 20,000 passed hashes.

const modules = import.meta.glob("../convex/**/*.ts");
type Harness = TestConvex<typeof schema>;
const IMAGE = `ghcr.io/fanzzzd/runner@sha256:${"a".repeat(64)}`;
const COMMIT = "c".repeat(40);
const T0 = Date.parse("2026-11-01T00:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

function harness() {
  return convexTest({ schema, modules, transactionLimits: true });
}

const pad = (text: string, bytes: number) => (text + "x".repeat(bytes)).slice(0, bytes);

/** A failed case with every field at (or, for the id, just under) its bound: about 2.6 kB. */
function heavyCase(key: string): TestCase {
  const half = (MAX_ID_BYTES - 2) / 2;
  const suite = pad(`suite.${key}.`, half);
  const name = pad(`name.${key}.`, half);
  return {
    id: `${suite}::${name}`,
    suite,
    name,
    file: pad(`src/${key}.`, MAX_NAME_BYTES),
    status: "failed",
    durationMs: 1,
    message: pad(`expected ${key} `, MAX_MESSAGE_BYTES),
  };
}

/**
 * MAX_PASSED sorted unique hashes: the real hashes of `ids`, filled up with made-up ones.
 */
async function passedOf(ids: string[], salt: number) {
  const hashes = new Set(await Promise.all(ids.map(passedHash)));
  for (let index = 0; hashes.size < MAX_PASSED; index++) {
    hashes.add(`${salt.toString(16).padStart(4, "0")}${index.toString(16).padStart(8, "0")}`);
  }
  return [...hashes].toSorted().join("");
}

function body(cases: TestCase[], passed: string, commitSha?: string): TestReport {
  const passing = passed.length / PASSED_HASH_LENGTH;
  const failed = cases.filter((testCase) => testCase.status === "failed").length;
  return {
    version: 1,
    files: 1,
    truncated: false,
    ...(commitSha === undefined ? {} : { commitSha }),
    totals: {
      tests: passing + failed,
      passed: passing,
      failed,
      errored: 0,
      skipped: 0,
      flaky: 0,
      durationMs: 1000,
    },
    cases,
    passed,
  };
}

async function setup(t: Harness) {
  return await t.run(async (ctx) =>
    ctx.db.insert("machines", {
      name: "linux-a",
      os: "linux",
      labels: [],
      maxSlots: 2,
      usedSlots: 1,
      lastSeen: T0,
      token: "machine-token",
    }),
  );
}

let runner = 0;
async function attempt(t: Harness, machineId: Id<"machines">, workflowRunId: number) {
  runner++;
  return await t.run(async (ctx) =>
    ctx.db.insert("attempts", {
      profile: "erainfra-4vcpu-ubuntu-2404",
      executor: "firecracker",
      imageRelease: IMAGE,
      vcpus: 4,
      memoryMiB: 16_384,
      runnerName: `runner-${runner}`,
      runnerId: runner,
      state: "running",
      machineId,
      createdAt: T0,
      repo: "app",
      owner: "acme",
      workflowRunId,
      workflowRef: "acme/app/.github/workflows/ci.yml@refs/heads/main",
      eventName: "push",
      displayName: "test",
    }),
  );
}

function send(t: Harness, attemptId: Id<"attempts">, report: TestReport) {
  return t.mutation(api.workerApi.reportAttemptTests, {
    token: "machine-token",
    attemptId,
    report,
  });
}

async function operator(t: Harness) {
  const userId = await t.run(async (ctx) => ctx.db.insert("users", { email: "o@example.test" }));
  return t.withIdentity({ subject: `${userId}|session` });
}

describe("test reports inside Convex's transaction limits", () => {
  it("stores the largest report against 20 of the largest earlier reports of its revision", async () => {
    const t = harness();
    const machineId = await setup(t);
    // What the last upload fails and every peer passed.
    const ownFailures = Array.from({ length: MAX_CASES }, (_, i) => heavyCase(`own.${i}`));
    const shared = await passedOf(
      ownFailures.map((testCase) => testCase.id),
      0xffff,
    );
    const peerFailures: TestCase[] = [];
    for (let peer = 0; peer < MAX_REVISION_PEERS; peer++) {
      const cases = Array.from({ length: MAX_CASES }, (_, i) => heavyCase(`peer${peer}.${i}`));
      peerFailures.push(...cases);
      const id = await attempt(t, machineId, 1000 + peer);
      expect(await send(t, id, body(cases, shared, COMMIT))).toBe(true);
    }
    const size = await t.run(async (ctx) => {
      const row = await ctx.db.query("testCases").first();
      return getDocumentSize(row!);
    });
    expect(size).toBeGreaterThan(2500);

    // The last upload fails what the peers passed and passes what they failed: every finding
    // from both directions, far more than one upload may record.
    const last = await attempt(t, machineId, 2000);
    const passed = await passedOf(
      peerFailures.slice(0, MAX_PASSED).map((testCase) => testCase.id),
      0xfffe,
    );
    await expect(send(t, last, body(ownFailures, passed, COMMIT))).resolves.toBe(true);
    const flaky = await t.run(async (ctx) => ctx.db.query("flakyTests").collect());
    expect(flaky).toHaveLength(MAX_FLAKY_FINDINGS);
  }, 600_000);

  it("serves the Tests page and the operator API over 300 reports of 20,000 passing tests", async () => {
    const t = harness();
    const machineId = await setup(t);
    const passed = await passedOf([], 1);
    const failures = Array.from({ length: MAX_CASES }, (_, i) => heavyCase(`fail.${i}`));
    let lastAttempt: Id<"attempts"> | undefined;
    for (let index = 0; index < 300; index++) {
      vi.setSystemTime(T0 + index * 1000);
      lastAttempt = await attempt(t, machineId, 1000 + index);
      // One in three also fails 500 heavy cases, so the failing-runs page is full of them.
      const cases = index % 3 === 0 ? failures : [];
      const commitSha = index.toString(16).padStart(40, "0");
      expect(await send(t, lastAttempt, body(cases, passed, commitSha))).toBe(true);
    }
    const op = await operator(t);
    expect(await op.query(api.testReports.repositories, {})).toEqual(["acme/app"]);
    const failing = await op.query(api.testReports.runs, { failedOnly: true, limit: 100 });
    expect(failing).toHaveLength(100);
    expect(failing.every((run) => run.failures.length === 20)).toBe(true);
    expect(await op.query(api.testReports.runs, { limit: 100 })).toHaveLength(100);
    expect(
      await op.query(api.testReports.runs, { repository: "acme/app", failedOnly: true }),
    ).toHaveLength(50);
    await op.query(api.testReports.slowest, {});
    await op.query(api.testReports.flaky, { repository: "acme/app" });
    const first = await t.run(async (ctx) =>
      ctx.db.query("testReports").withIndex("by_recordedAt").first(),
    );
    const detail = await op.query(api.testReports.forAttempt, { attemptId: first!.attemptId });
    expect(detail?.cases).toHaveLength(MAX_CASES);
    expect(await t.query(internal.testReports.operatorRuns, { limit: 100 })).toHaveLength(100);
  }, 600_000);

  it("purges expired reports of 500 heavy cases each, a bounded batch per transaction", async () => {
    const t = harness();
    const machineId = await setup(t);
    const passed = await passedOf([], 2);
    for (let index = 0; index < 12; index++) {
      const cases = Array.from({ length: MAX_CASES }, (_, i) => heavyCase(`r${index}.${i}`));
      const id = await attempt(t, machineId, 1000 + index);
      const commitSha = index.toString(16).padStart(40, "0");
      expect(await send(t, id, body(cases, passed, commitSha))).toBe(true);
    }
    vi.setSystemTime(T0 + TEST_RETENTION_MS / 2);
    const fresh = await attempt(t, machineId, 5000);
    expect(await send(t, fresh, body([heavyCase("fresh")], passed, COMMIT))).toBe(true);

    vi.setSystemTime(T0 + TEST_RETENTION_MS + 60_000);
    // The first transaction stops at its case budget, short of every expired report.
    expect(await t.mutation(internal.testReports.purgeExpired, {})).toBeGreaterThan(0);
    expect(
      (await t.run(async (ctx) => ctx.db.query("testReports").collect())).length,
    ).toBeGreaterThan(1);
    // Its own rescheduling finishes the rest.
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const left = await t.run(async (ctx) => ({
      reports: await ctx.db.query("testReports").collect(),
      hashes: await ctx.db.query("testReportHashes").collect(),
      cases: await ctx.db.query("testCases").collect(),
    }));
    expect(left.reports.map((row) => row.attemptId)).toEqual([fresh]);
    expect(left.hashes.map((row) => row.reportId)).toEqual([left.reports[0]!._id]);
    expect(left.cases).toHaveLength(1);
  }, 600_000);
});
