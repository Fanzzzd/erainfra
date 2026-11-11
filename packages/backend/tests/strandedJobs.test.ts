import { generateKeyPairSync } from "node:crypto";

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { internal } from "../convex/_generated/api";
import { parseJobsAcquired } from "../convex/controllerHttp";
import schema from "../convex/schema";
import { PERMISSION_DETAIL, strandedSettings } from "../convex/strandedJobs";
import {
  CONTRACT,
  MINUTE,
  NOW,
  insertAttempt,
  insertMachine,
  insertProfile,
  insertReadiness,
} from "./support/fleetFixture";

const modules = import.meta.glob("../convex/**/*.ts");
type Harness = TestConvex<typeof schema>;

const RUN_ID = 4242;
const RUN_URL = `https://api.github.com/repos/acme/payable/actions/runs/${RUN_ID}`;

let privateKey: string;
beforeAll(() => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  privateKey = pair.privateKey.export({ format: "pem", type: "pkcs1" }).toString();
});

type Answer = (method: string, url: string) => Response | undefined;
let calls: { method: string; url: string; body?: string }[] = [];
let answer: Answer = () => undefined;
let tokenPermissions: unknown[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  // convex-test never lets the clock run backwards, so each test starts early and only moves on.
  vi.setSystemTime(NOW - 120 * MINUTE);
  calls = [];
  tokenPermissions = [];
  answer = () => undefined;
  vi.stubEnv("CONTROLLER_GITHUB_APP_CLIENT_ID", "Iv1.controller");
  vi.stubEnv("CONTROLLER_GITHUB_APP_PRIVATE_KEY", privateKey);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/orgs/acme/installation")) return Response.json({ id: 42 });
      if (url.endsWith("/access_tokens")) {
        tokenPermissions.push(JSON.parse(String(init?.body)));
        return Response.json(
          { token: "ghs_short-lived", expires_at: new Date(Date.now() + 3_600_000).toISOString() },
          { status: 201 },
        );
      }
      calls.push({ method, url });
      const response = answer(method, url);
      if (response === undefined) throw new Error(`unexpected request ${method} ${url}`);
      return response;
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function fleet(t: Harness, options: { readyWorker?: boolean } = {}) {
  await insertProfile(t, { githubConfigUrl: "https://github.com/acme" });
  if (options.readyWorker) {
    const machineId = await insertMachine(t, "worker-1");
    await insertReadiness(t, machineId);
  }
}

async function acquire(t: Harness, runnerRequestId: string, acquiredAt: number) {
  vi.setSystemTime(acquiredAt);
  await t.mutation(internal.controllerApi.recordJobsAcquired, {
    profile: CONTRACT.profile,
    jobs: [
      {
        runnerRequestId,
        repository: "payable",
        owner: "acme",
        jobId: `job-${runnerRequestId}`,
        displayName: "local",
        workflowRunId: RUN_ID,
      },
    ],
  });
}

async function scanAt(t: Harness, now: number) {
  vi.setSystemTime(now);
  await t.mutation(internal.strandedJobs.scan, {});
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

function jobRow(t: Harness, runnerRequestId: string) {
  return t.run((ctx) =>
    ctx.db
      .query("scaleSetJobs")
      .withIndex("by_runnerRequestId", (query) => query.eq("runnerRequestId", runnerRequestId))
      .unique(),
  );
}

describe("stranded job settings", () => {
  it("defaults to wait after 5 minutes and bounds the minutes", () => {
    expect(strandedSettings({})).toEqual({ action: "wait", afterMinutes: 5 });
    expect(strandedSettings({ ERAINFRA_STRANDED_JOB_ACTION: "Rerun" }).action).toBe("rerun");
    expect(strandedSettings({ ERAINFRA_STRANDED_JOB_ACTION: "delete" }).action).toBe("wait");
    expect(strandedSettings({ ERAINFRA_STRANDED_JOB_AFTER_MINUTES: "0" }).afterMinutes).toBe(1);
    expect(strandedSettings({ ERAINFRA_STRANDED_JOB_AFTER_MINUTES: "9999" }).afterMinutes).toBe(
      1_440,
    );
    expect(strandedSettings({ ERAINFRA_STRANDED_JOB_AFTER_MINUTES: "2.5" }).afterMinutes).toBe(5);
  });
});

describe("stranded job recovery", () => {
  it("does nothing while the action is wait", async () => {
    const t = convexTest(schema, modules);
    await fleet(t);
    await acquire(t, "1", NOW - 60 * MINUTE);
    await scanAt(t, NOW);
    expect((await jobRow(t, "1"))?.stranded).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("does nothing before the threshold", async () => {
    vi.stubEnv("ERAINFRA_STRANDED_JOB_ACTION", "cancel");
    const t = convexTest(schema, modules);
    await fleet(t);
    await acquire(t, "1", NOW - 4 * MINUTE);
    await scanAt(t, NOW);
    expect((await jobRow(t, "1"))?.stranded).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("does nothing while the Profile has a ready Worker", async () => {
    vi.stubEnv("ERAINFRA_STRANDED_JOB_ACTION", "cancel");
    const t = convexTest(schema, modules);
    await fleet(t, { readyWorker: true });
    await acquire(t, "1", NOW - 30 * MINUTE);
    await scanAt(t, NOW);
    expect((await jobRow(t, "1"))?.stranded).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("waits while the Profile's last ready Worker dropped within the threshold", async () => {
    vi.stubEnv("ERAINFRA_STRANDED_JOB_ACTION", "cancel");
    const t = convexTest(schema, modules);
    await insertProfile(t, { githubConfigUrl: "https://github.com/acme" });
    // Ready, but silent for 2 minutes: too stale to schedule on, too recent to give up on.
    const machineId = await insertMachine(t, "worker-1", { lastSeen: NOW - 2 * MINUTE });
    await insertReadiness(t, machineId);
    await acquire(t, "1", NOW - 30 * MINUTE);
    await scanAt(t, NOW);
    expect((await jobRow(t, "1"))?.stranded).toBeUndefined();
    expect(calls).toEqual([]);

    // Silent for 10 minutes, past the 5-minute threshold: now the job is stranded.
    await t.run((ctx) => ctx.db.patch(machineId, { lastSeen: NOW - 10 * MINUTE }));
    await scanAt(t, NOW);
    expect((await jobRow(t, "1"))?.stranded).toBeDefined();
  });

  it("marks a stranded job, names the cause on an Attempt and cancels the run", async () => {
    vi.stubEnv("ERAINFRA_STRANDED_JOB_ACTION", "cancel");
    const t = convexTest(schema, modules);
    await fleet(t);
    const attemptId = await insertAttempt(t, { createdAt: NOW - 6 * MINUTE });
    await acquire(t, "1", NOW - 6 * MINUTE);
    answer = (method, url) =>
      method === "POST" && url === `${RUN_URL}/cancel`
        ? new Response(null, { status: 202 })
        : undefined;
    await scanAt(t, NOW);

    const row = await jobRow(t, "1");
    expect(row?.stranded).toEqual({ action: "cancel", at: NOW, outcome: "cancelled" });
    expect(calls).toEqual([{ method: "POST", url: `${RUN_URL}/cancel` }]);
    // The token asks for Actions write on the run's repository only.
    expect(tokenPermissions).toEqual([
      { repositories: ["payable"], permissions: { actions: "write" } },
    ]);
    const attempt = await t.run((ctx) => ctx.db.get(attemptId));
    expect(attempt?.state).toBe("cancelled");
    expect(attempt?.cancelReason).toBe(
      `No ready Worker for ${CONTRACT.profile} within 5 minutes; cancelled the run`,
    );
  });

  it("reruns a run at most once", async () => {
    vi.stubEnv("ERAINFRA_STRANDED_JOB_ACTION", "rerun");
    const t = convexTest(schema, modules);
    await fleet(t);
    await acquire(t, "1", NOW - 6 * MINUTE);
    let polls = 0;
    answer = (method, url) => {
      if (method === "POST" && url === `${RUN_URL}/cancel`)
        return new Response(null, { status: 202 });
      if (method === "GET" && url === RUN_URL) {
        polls += 1;
        return Response.json({ status: polls < 2 ? "in_progress" : "completed" });
      }
      if (method === "POST" && url === `${RUN_URL}/rerun`)
        return new Response(null, { status: 201 });
      return undefined;
    };
    await scanAt(t, NOW);
    expect((await jobRow(t, "1"))?.stranded).toMatchObject({
      action: "rerun",
      outcome: "rerun-requested",
    });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `POST ${RUN_URL}/cancel`,
      `GET ${RUN_URL}`,
      `GET ${RUN_URL}`,
      `POST ${RUN_URL}/rerun`,
    ]);

    // The rerun's job strands again: the run is only cancelled this time.
    calls = [];
    const later = Date.now() + 10 * MINUTE;
    await acquire(t, "2", later);
    await scanAt(t, later + 6 * MINUTE);
    expect((await jobRow(t, "2"))?.stranded).toMatchObject({
      action: "cancel",
      outcome: "cancelled",
    });
    expect(calls).toEqual([{ method: "POST", url: `${RUN_URL}/cancel` }]);
  });

  it("acts once for several jobs of the same run", async () => {
    vi.stubEnv("ERAINFRA_STRANDED_JOB_ACTION", "cancel");
    const t = convexTest(schema, modules);
    await fleet(t);
    await acquire(t, "1", NOW - 7 * MINUTE);
    await acquire(t, "2", NOW - 6 * MINUTE);
    answer = (method, url) =>
      method === "POST" && url === `${RUN_URL}/cancel`
        ? new Response(null, { status: 202 })
        : undefined;
    await scanAt(t, NOW);
    expect(calls).toHaveLength(1);
    expect((await jobRow(t, "2"))?.stranded?.detail).toBe("Handled with another job of this run");
  });

  it("records the missing permission when GitHub answers 403", async () => {
    vi.stubEnv("ERAINFRA_STRANDED_JOB_ACTION", "rerun");
    const t = convexTest(schema, modules);
    await fleet(t);
    await acquire(t, "1", NOW - 6 * MINUTE);
    answer = () =>
      Response.json({ message: "Resource not accessible by integration" }, { status: 403 });
    await scanAt(t, NOW);
    expect((await jobRow(t, "1"))?.stranded).toEqual({
      action: "rerun",
      at: NOW,
      outcome: "failed",
      detail: PERMISSION_DETAIL,
    });
    expect(calls).toHaveLength(1);
  });
});

describe("acquired jobs", () => {
  it("settles when the job starts or ends without a Runner", async () => {
    const t = convexTest(schema, modules);
    await fleet(t);
    await insertAttempt(t, { runnerName: "runner-a", state: "ready" });
    await acquire(t, "1", NOW);
    await acquire(t, "2", NOW);
    await acquire(t, "2", NOW);
    await t.mutation(internal.controllerApi.markJobStarted, {
      profile: CONTRACT.profile,
      runnerName: "runner-a",
      runnerRequestId: "1",
    });
    expect(await jobRow(t, "1")).toBeNull();
    await t.mutation(internal.controllerApi.acknowledgeRunnerlessJobCompleted, {
      profile: CONTRACT.profile,
      runnerRequestId: "2",
    });
    expect(await jobRow(t, "2")).toBeNull();
  });

  it("parses the controller's report and refuses a bad one", () => {
    expect(
      parseJobsAcquired({
        profile: " rc-linux-js ",
        jobs: [{ runnerRequestId: "9007199254740993", workflowRunId: 7, repository: " payable " }],
      }),
    ).toEqual({
      profile: "rc-linux-js",
      jobs: [
        {
          runnerRequestId: "9007199254740993",
          workflowRunId: 7,
          repository: "payable",
          owner: undefined,
          jobId: undefined,
          displayName: undefined,
          queueTime: undefined,
        },
      ],
    });
    expect(parseJobsAcquired({ profile: "p", jobs: [{}] })).toBeNull();
    expect(parseJobsAcquired({ profile: "p", jobs: [{ runnerRequestId: "0" }] })).toBeNull();
    expect(parseJobsAcquired({ profile: "p" })).toBeNull();
  });
});
