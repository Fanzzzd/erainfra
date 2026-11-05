import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import schema from "../convex/schema";
import {
  LEASE_RENEW_INTERVAL_MS,
  LEASE_TTL_MS,
  POOR_NETWORK_HEAD_START_MS,
} from "../convex/controllerLease";
import {
  CONTRACT,
  NOW,
  insertAttempt,
  insertMachine,
  insertProfile,
  insertReadiness,
} from "./support/fleetFixture.ts";

// The controller lease of ADR 0014 end to end through the HTTP routes: acquire, renew, release,
// takeover after expiry, the network head start, epoch fencing on every route that touches a
// Profile's state, and a Worker's machine token accepted only while its Worker holds the lease.

const modules = import.meta.glob("../convex/**/*.ts");
type Harness = TestConvex<typeof schema>;

const TOKEN = "controller-token-current";
const GOOD_WORKER = "0123456789abcdef0123456789abcdef";
const POOR_WORKER = "fedcba9876543210fedcba9876543210";
const REPOSITORY_URL = "https://github.com/acme/widgets";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("CONTROLLER_TOKEN", TOKEN);
  vi.stubEnv("CONTROLLER_TOKEN_NEXT", "");
  vi.stubEnv("CONTROLLER_REQUIRE_LEASE", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function advance(ms: number) {
  vi.setSystemTime(Date.now() + ms);
}

type Call = { bearer?: string; epoch?: number | string };

function post(t: Harness, path: string, body: unknown, call: Call = {}) {
  return t.fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${call.bearer ?? TOKEN}`,
      ...(call.epoch === undefined ? {} : { "X-EraInfra-Lease-Epoch": String(call.epoch) }),
    },
    body: JSON.stringify(body),
  });
}

function get(t: Harness, path: string, call: Call = {}) {
  return t.fetch(path, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${call.bearer ?? TOKEN}`,
      ...(call.epoch === undefined ? {} : { "X-EraInfra-Lease-Epoch": String(call.epoch) }),
    },
  });
}

type Acquired =
  | {
      granted: true;
      epoch: number;
      ttlMs: number;
      renewIntervalMs: number;
      networkPoor: boolean;
      profile?: Record<string, unknown>;
    }
  | {
      granted: false;
      reason: string;
      holder?: string;
      retryAfterMs: number;
      networkPoor: boolean;
    };

async function acquire(t: Harness, instance: string, call: Call = {}, hostname = instance) {
  const response = await post(
    t,
    "/controller/lease/acquire",
    { profile: CONTRACT.profile, hostname, instance },
    call,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as Acquired;
}

function renew(t: Harness, instance: string, epoch: number, call: Call = {}) {
  return post(
    t,
    "/controller/lease/renew",
    { profile: CONTRACT.profile, hostname: instance, instance },
    { ...call, epoch },
  );
}

async function granted(t: Harness, instance: string, call: Call = {}) {
  const result = await acquire(t, instance, call);
  if (!result.granted) throw new Error(`expected a grant, got ${JSON.stringify(result)}`);
  return result;
}

/** A Worker that is ready for CONTRACT, with a fresh benchmark rating its network as given. */
async function worker(t: Harness, token: string, networkScore = 80) {
  const machineId = await insertMachine(t, `worker-${token.slice(0, 4)}`, {
    token,
    benchmark: {
      measuredAt: NOW - 60_000,
      scores: { cpu: 80, memory: 80, disk: 80, network: networkScore, balanced: 80 },
    },
  });
  await insertReadiness(t, machineId);
  return machineId;
}

async function setup() {
  const t = convexTest(schema, modules);
  await insertProfile(t, { githubConfigUrl: REPOSITORY_URL, labels: [CONTRACT.profile] });
  return t;
}

describe("acquire, renew and release", () => {
  it("grants a free lease, refuses a second candidate until it expires, then hands it over with a new epoch", async () => {
    const t = await setup();
    const first = await granted(t, "instance-aaaaaaaa");
    expect(first).toMatchObject({
      epoch: 1,
      ttlMs: LEASE_TTL_MS,
      renewIntervalMs: LEASE_RENEW_INTERVAL_MS,
      networkPoor: false,
    });
    expect(first.profile).toMatchObject({
      name: CONTRACT.profile,
      githubConfigUrl: REPOSITORY_URL,
    });

    const refused = await acquire(t, "instance-bbbbbbbb");
    expect(refused).toMatchObject({
      granted: false,
      reason: "held",
      holder: "instance-aaaaaaaa",
      retryAfterMs: LEASE_TTL_MS,
    });

    // Renewing keeps it: the second candidate is still refused after the first grant would have
    // run out.
    advance(LEASE_RENEW_INTERVAL_MS);
    expect((await renew(t, "instance-aaaaaaaa", 1)).status).toBe(200);
    advance(LEASE_TTL_MS - LEASE_RENEW_INTERVAL_MS + 1);
    expect(await acquire(t, "instance-bbbbbbbb")).toMatchObject({ granted: false, reason: "held" });

    // The holder goes silent. One expiry later the candidate takes over, under a new epoch.
    advance(LEASE_TTL_MS);
    const second = await granted(t, "instance-bbbbbbbb");
    expect(second.epoch).toBe(2);

    // The old holder's renewal is refused with the lease-lost status.
    const stale = await renew(t, "instance-aaaaaaaa", 1);
    expect(stale.status).toBe(412);
    expect(await stale.json()).toMatchObject({ code: "lease-lost" });
  });

  it("gives a re-asking holder its own epoch back", async () => {
    const t = await setup();
    const first = await granted(t, "instance-aaaaaaaa");
    advance(5_000);
    expect(await granted(t, "instance-aaaaaaaa")).toMatchObject({ epoch: first.epoch });
  });

  it("frees the lease at once on release, so a standby need not wait for expiry", async () => {
    const t = await setup();
    await granted(t, "instance-aaaaaaaa");
    const released = await post(
      t,
      "/controller/lease/release",
      { profile: CONTRACT.profile, hostname: "a", instance: "instance-aaaaaaaa" },
      { epoch: 1 },
    );
    expect(released.status).toBe(204);
    expect(await granted(t, "instance-bbbbbbbb")).toMatchObject({ epoch: 3 });
  });

  it("ignores a release from a process that no longer holds the lease", async () => {
    const t = await setup();
    await granted(t, "instance-aaaaaaaa");
    advance(LEASE_TTL_MS + 1);
    await granted(t, "instance-bbbbbbbb");
    await post(
      t,
      "/controller/lease/release",
      { profile: CONTRACT.profile, hostname: "a", instance: "instance-aaaaaaaa" },
      { epoch: 1 },
    );
    expect(await acquire(t, "instance-cccccccc")).toMatchObject({ granted: false, reason: "held" });
  });

  it("keeps the retiring holder's lease renewable, but prevents standby acquisition after pause", async () => {
    const t = await setup();
    await granted(t, "instance-aaaaaaaa");
    const paused = await post(
      t,
      "/controller/profiles/pause",
      { name: CONTRACT.profile },
      { epoch: 1 },
    );
    expect(paused.status).toBe(204);
    expect((await renew(t, "instance-aaaaaaaa", 1)).status).toBe(200);
    advance(LEASE_TTL_MS + 1);
    expect(await acquire(t, "instance-bbbbbbbb")).toMatchObject({
      granted: false,
      reason: "profilePaused",
    });
  });

  it("refuses a malformed epoch rather than reading it as no epoch", async () => {
    const t = await setup();
    const response = await get(t, `/controller/attempts?profile=${CONTRACT.profile}`, {
      epoch: "1; DROP",
    });
    expect(response.status).toBe(400);
  });
});

describe("epoch fencing on every controller route", () => {
  // Each route with a body that would succeed under the current epoch.
  async function routes(t: Harness) {
    await insertAttempt(t, { runnerName: "runner-started", runnerId: 11 });
    await insertAttempt(t, { runnerName: "runner-completed", runnerId: 12, state: "running" });
    await insertAttempt(t, { runnerName: "runner-cancelled", runnerId: 13 });
    await insertAttempt(t, {
      runnerName: "runner-cleanup",
      runnerId: 14,
      state: "cancelled",
      runnerCleanupPending: true,
    });
    return [
      {
        name: "register Profile",
        call: (call: Call) =>
          post(
            t,
            "/controller/profiles",
            {
              name: CONTRACT.profile,
              scaleSetName: CONTRACT.profile,
              executor: CONTRACT.executor,
              imageRelease: CONTRACT.imageRelease,
              vcpus: CONTRACT.vcpus,
              memoryMiB: CONTRACT.memoryMiB,
              minRunners: 0,
              maxRunners: 4,
              githubConfigUrl: REPOSITORY_URL,
            },
            call,
          ),
      },
      {
        name: "heartbeat",
        call: (call: Call) =>
          post(
            t,
            "/controller/heartbeat",
            {
              profile: CONTRACT.profile,
              hostname: "host-a",
              version: "dev",
              sessionState: "listening",
              assignedJobs: 0,
              runningJobs: 0,
              lease: { role: "holder", epoch: Number(call.epoch) },
            },
            call,
          ),
      },
      {
        name: "list Attempts",
        call: (call: Call) => get(t, `/controller/attempts?profile=${CONTRACT.profile}`, call),
      },
      {
        name: "create Attempt",
        call: (call: Call) =>
          post(
            t,
            "/controller/attempts",
            {
              profile: CONTRACT.profile,
              executor: CONTRACT.executor,
              imageRelease: CONTRACT.imageRelease,
              vcpus: CONTRACT.vcpus,
              memoryMiB: CONTRACT.memoryMiB,
              runnerName: "runner-new",
              runnerId: 21,
              encodedJITConfig: "jit",
            },
            call,
          ),
      },
      {
        name: "cancel Attempt",
        call: (call: Call) =>
          post(
            t,
            "/controller/attempts/cancel",
            { profile: CONTRACT.profile, runnerName: "runner-cancelled", reason: "scale down" },
            call,
          ),
      },
      {
        name: "list runner cleanups",
        call: (call: Call) =>
          get(t, `/controller/runner-cleanups?profile=${CONTRACT.profile}`, call),
      },
      {
        name: "complete runner cleanup",
        call: (call: Call) =>
          post(
            t,
            "/controller/runner-cleanups/complete",
            { profile: CONTRACT.profile, runnerName: "runner-cleanup", runnerId: 14 },
            call,
          ),
      },
      {
        name: "job started",
        call: (call: Call) =>
          post(
            t,
            "/controller/jobs/started",
            { profile: CONTRACT.profile, runnerName: "runner-started" },
            call,
          ),
      },
      {
        name: "job completed",
        call: (call: Call) =>
          post(
            t,
            "/controller/jobs/completed",
            { profile: CONTRACT.profile, runnerName: "runner-completed", finishedAt: NOW },
            call,
          ),
      },
      {
        // Last: a pause revokes the lease.
        name: "pause Profile",
        call: (call: Call) =>
          post(t, "/controller/profiles/pause", { name: CONTRACT.profile }, call),
      },
    ];
  }

  it("refuses a partitioned former holder's write on every route with 412, and accepts the holder's", async () => {
    const t = await setup();
    await granted(t, "instance-aaaaaaaa");
    advance(LEASE_TTL_MS + 1);
    const current = await granted(t, "instance-bbbbbbbb");
    expect(current.epoch).toBe(2);

    const calls = await routes(t);
    for (const route of calls) {
      const stale = await route.call({ epoch: 1 });
      expect(stale.status, `${route.name} with a stale epoch`).toBe(412);
    }
    for (const route of calls) {
      const fresh = await route.call({ epoch: current.epoch });
      expect(fresh.status, `${route.name} with the current epoch`).toBeLessThan(300);
    }
  });

  it("refuses the holder's own epoch once its grant has run out unrenewed", async () => {
    const t = await setup();
    const first = await granted(t, "instance-aaaaaaaa");
    advance(LEASE_TTL_MS + 1);
    const response = await get(t, `/controller/attempts?profile=${CONTRACT.profile}`, {
      epoch: first.epoch,
    });
    expect(response.status).toBe(412);
  });

  it("does not change state on a refused write", async () => {
    const t = await setup();
    await granted(t, "instance-aaaaaaaa");
    advance(LEASE_TTL_MS + 1);
    await granted(t, "instance-bbbbbbbb");
    const refused = await post(
      t,
      "/controller/attempts",
      {
        profile: CONTRACT.profile,
        executor: CONTRACT.executor,
        imageRelease: CONTRACT.imageRelease,
        vcpus: CONTRACT.vcpus,
        memoryMiB: CONTRACT.memoryMiB,
        runnerName: "runner-stale",
        runnerId: 31,
        encodedJITConfig: "jit",
      },
      { epoch: 1 },
    );
    expect(refused.status).toBe(412);
    const attempts = await t.run((ctx) => ctx.db.query("attempts").collect());
    expect(attempts.map((attempt) => attempt.runnerName)).not.toContain("runner-stale");
  });

  it("requires the dedicated host to hold the lease too, with no unfenced legacy path", async () => {
    const t = await setup();
    const path = `/controller/attempts?profile=${CONTRACT.profile}`;
    expect((await get(t, path)).status).toBe(412);
    await granted(t, "instance-aaaaaaaa");
    expect((await get(t, path)).status).toBe(412);
    expect((await get(t, path, { epoch: 1 })).status).toBe(200);
  });
});

describe("a Worker's machine token", () => {
  it("serves as a controller credential only while its Worker holds the lease", async () => {
    const t = await setup();
    await worker(t, GOOD_WORKER);
    const path = `/controller/attempts?profile=${CONTRACT.profile}`;

    // Before it holds the lease, with or without an epoch.
    expect((await get(t, path, { bearer: GOOD_WORKER })).status).toBe(412);

    const lease = await granted(t, "instance-worker1", { bearer: GOOD_WORKER });
    expect(lease.epoch).toBe(1);
    expect((await get(t, path, { bearer: GOOD_WORKER, epoch: 1 })).status).toBe(200);
    // Without the epoch it is not the legacy path: a Worker always needs the lease.
    expect((await get(t, path, { bearer: GOOD_WORKER })).status).toBe(412);

    // A dedicated host takes over after expiry; the Worker's token stops working at once.
    advance(LEASE_TTL_MS + 1);
    await granted(t, "instance-dedicated");
    expect((await get(t, path, { bearer: GOOD_WORKER, epoch: 1 })).status).toBe(412);
    // Guessing the new epoch does not turn a machine credential into the dedicated holder.
    expect((await get(t, path, { bearer: GOOD_WORKER, epoch: 2 })).status).toBe(412);
  });

  it("is refused for an unknown machine", async () => {
    const t = await setup();
    const response = await post(
      t,
      "/controller/lease/acquire",
      { profile: CONTRACT.profile, hostname: "x", instance: "instance-unknown" },
      { bearer: "00000000000000000000000000000000" },
    );
    expect(response.status).toBe(401);
  });

  it("may not register or pause a Profile, even while it holds the lease", async () => {
    const t = await setup();
    await worker(t, GOOD_WORKER);
    await granted(t, "instance-worker1", { bearer: GOOD_WORKER });
    const register = await post(
      t,
      "/controller/profiles",
      {
        name: CONTRACT.profile,
        scaleSetName: CONTRACT.profile,
        executor: CONTRACT.executor,
        imageRelease: `ghcr.io/evil/runner@sha256:${"c".repeat(64)}`,
        vcpus: CONTRACT.vcpus,
        memoryMiB: CONTRACT.memoryMiB,
        minRunners: 0,
        maxRunners: 4,
      },
      { bearer: GOOD_WORKER, epoch: 1 },
    );
    expect(register.status).toBe(403);
    const pause = await post(
      t,
      "/controller/profiles/pause",
      { name: CONTRACT.profile },
      { bearer: GOOD_WORKER, epoch: 1 },
    );
    expect(pause.status).toBe(403);
    const profile = await t.run((ctx) => ctx.db.query("profiles").first());
    expect(profile?.imageRelease).toBe(CONTRACT.imageRelease);
    expect(profile?.state).toBe("active");
  });

  it("asks only for a Profile it is ready for, that is active and fully described", async () => {
    const t = convexTest(schema, modules);
    expect(await acquire(t, "instance-worker1", { bearer: GOOD_WORKER }).catch(() => null)).toBe(
      null,
    );
    await insertProfile(t);
    const machineId = await insertMachine(t, "worker", { token: GOOD_WORKER });
    expect(await acquire(t, "instance-worker1", { bearer: GOOD_WORKER })).toMatchObject({
      granted: false,
      reason: "profileIncomplete",
    });
    await t.run(async (ctx) => {
      const profile = await ctx.db.query("profiles").first();
      await ctx.db.patch(profile!._id, { githubConfigUrl: REPOSITORY_URL });
    });
    expect(await acquire(t, "instance-worker1", { bearer: GOOD_WORKER })).toMatchObject({
      granted: false,
      reason: "notReady",
    });
    await insertReadiness(t, machineId, { state: "degraded" });
    expect(await acquire(t, "instance-worker1", { bearer: GOOD_WORKER })).toMatchObject({
      granted: false,
      reason: "notReady",
    });
    await t.run(async (ctx) => {
      const readiness = await ctx.db.query("workerReadiness").first();
      await ctx.db.patch(readiness!._id, { state: "ready" });
    });
    expect(await acquire(t, "instance-worker1", { bearer: GOOD_WORKER })).toMatchObject({
      granted: true,
      epoch: 1,
    });
    advance(LEASE_TTL_MS + 1);
    const retirement = await granted(t, "instance-retirement");
    await post(
      t,
      "/controller/profiles/pause",
      { name: CONTRACT.profile },
      { epoch: retirement.epoch },
    );
    expect(await acquire(t, "instance-worker1", { bearer: GOOD_WORKER })).toMatchObject({
      granted: false,
      reason: "profilePaused",
    });
  });

  it("never leases a cache-facts Profile to a standby that cannot publish the facts", async () => {
    const t = convexTest(schema, modules);
    await insertProfile(t, { githubConfigUrl: REPOSITORY_URL, githubCacheFacts: true });
    await worker(t, GOOD_WORKER);
    const ask = async (canPublishCacheFacts?: boolean) => {
      const response = await post(
        t,
        "/controller/lease/acquire",
        {
          profile: CONTRACT.profile,
          hostname: "worker",
          instance: "instance-worker1",
          ...(canPublishCacheFacts === undefined ? {} : { canPublishCacheFacts }),
        },
        { bearer: GOOD_WORKER },
      );
      expect(response.status).toBe(200);
      return (await response.json()) as Acquired;
    };
    // Omitted means an older standby that never configured the cache: refused, like an explicit false.
    expect(await ask()).toMatchObject({ granted: false, reason: "incapable" });
    expect(await ask(false)).toMatchObject({ granted: false, reason: "incapable" });
    const refused = await t.run((ctx) => ctx.db.query("controllerLeases").first());
    expect(refused?.holder).toBeUndefined();
    expect(await ask(true)).toMatchObject({ granted: true, epoch: 1 });
  });

  it("does not ask a standby for cache facts its Profile does not publish", async () => {
    const t = await setup();
    await worker(t, GOOD_WORKER);
    expect(await acquire(t, "instance-worker1", { bearer: GOOD_WORKER })).toMatchObject({
      granted: true,
    });
  });

  it("reports a standby heartbeat for a Profile its Worker serves, and records the credential", async () => {
    const t = await setup();
    await worker(t, GOOD_WORKER);
    const response = await post(
      t,
      "/controller/heartbeat",
      {
        profile: CONTRACT.profile,
        hostname: "ubuntu0",
        version: "dev",
        sessionState: "standby",
        assignedJobs: 0,
        runningJobs: 0,
        lease: { role: "standby" },
      },
      { bearer: GOOD_WORKER },
    );
    expect(response.status).toBe(204);
    const [row] = await t.run((ctx) => ctx.db.query("controllerHeartbeats").collect());
    expect(row).toMatchObject({
      tokenSlot: "machine",
      leaseRole: "standby",
      sessionState: "standby",
    });
  });

  it("refuses a standby heartbeat that claims to be listening", async () => {
    const t = await setup();
    const response = await post(t, "/controller/heartbeat", {
      profile: CONTRACT.profile,
      hostname: "ubuntu0",
      version: "dev",
      sessionState: "listening",
      assignedJobs: 0,
      runningJobs: 0,
      lease: { role: "standby" },
    });
    expect(response.status).toBe(400);
  });
});

describe("the network head start", () => {
  it("lets a well-connected Worker take a freed lease first, and a lone poor one take it later", async () => {
    const t = await setup();
    await worker(t, POOR_WORKER, 20);
    await worker(t, GOOD_WORKER, 90);

    // Nobody has held it yet: the poor Worker is told to wait out the head start.
    const poorFirst = await acquire(t, "instance-poor", { bearer: POOR_WORKER });
    expect(poorFirst).toMatchObject({
      granted: false,
      reason: "headStart",
      networkPoor: true,
      retryAfterMs: POOR_NETWORK_HEAD_START_MS,
    });
    // The good one is granted at once.
    const good = await granted(t, "instance-good", { bearer: GOOD_WORKER });
    expect(good.networkPoor).toBe(false);

    // While it is held, the poor Worker is told to come back the head start after it expires.
    const held = await acquire(t, "instance-poor", { bearer: POOR_WORKER });
    expect(held).toMatchObject({
      granted: false,
      reason: "held",
      retryAfterMs: LEASE_TTL_MS + POOR_NETWORK_HEAD_START_MS,
    });

    // The good Worker dies. Right at expiry the poor one is still held back...
    advance(LEASE_TTL_MS);
    expect(await acquire(t, "instance-poor", { bearer: POOR_WORKER })).toMatchObject({
      granted: false,
      reason: "headStart",
    });
    // ...and once the head start has passed with nobody else asking, it serves.
    advance(POOR_NETWORK_HEAD_START_MS);
    expect(await acquire(t, "instance-poor", { bearer: POOR_WORKER })).toMatchObject({
      granted: true,
      epoch: 2,
      networkPoor: true,
    });
  });

  it("ignores a stale benchmark", async () => {
    const t = await setup();
    const machineId = await worker(t, POOR_WORKER, 20);
    await t.run((ctx) =>
      ctx.db.patch(machineId, {
        benchmark: {
          measuredAt: NOW - 8 * 24 * 60 * 60_000,
          scores: { cpu: 80, memory: 80, disk: 80, network: 20, balanced: 80 },
        },
      }),
    );
    expect(await acquire(t, "instance-poor", { bearer: POOR_WORKER })).toMatchObject({
      granted: true,
      networkPoor: false,
    });
  });
});
