import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import {
  bearerToken,
  hashApiToken,
  isWellFormedApiToken,
  LAST_USED_RESOLUTION_MS,
  newApiToken,
} from "../convex/apiTokenPolicy";
import { parseAttemptQuery, parseSince } from "../convex/operatorHttp";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");
type Harness = TestConvex<typeof schema>;

const CONTRACT = {
  executor: "firecracker" as const,
  imageRelease:
    "ghcr.io/fanzzzd/runner@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  vcpus: 4,
  memoryMiB: 16_384,
};

const T0 = Date.parse("2026-11-01T00:00:00.000Z");

async function harness() {
  const t = convexTest(schema, modules);
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", { email: "operator@example.test" }),
  );
  const operator = t.withIdentity({ subject: `${userId}|session` });
  return { t, operator };
}

async function mint(operator: ReturnType<Harness["withIdentity"]>, scope: "read" | "admin") {
  return await operator.mutation(api.apiTokens.create, { name: `${scope} token`, scope });
}

function get(t: Harness, path: string, token?: string) {
  return t.fetch(path, {
    method: "GET",
    headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
  });
}

async function seedAttempt(
  t: Harness,
  at: number,
  fields: Partial<{
    profile: string;
    state: "pending" | "running" | "completed" | "failed";
    repo: string;
    owner: string;
    machineId: Id<"machines">;
    queueTime: number;
    runnerAssignedAt: number;
    startedAt: number;
    finishedAt: number;
    workflowRunId: number;
    jitConfig: string;
  }> = {},
) {
  vi.setSystemTime(at);
  return await t.run(async (ctx) =>
    ctx.db.insert("attempts", {
      ...CONTRACT,
      profile: fields.profile ?? "erainfra-4vcpu-ubuntu-2404",
      runnerName: `runner-${at}`,
      runnerId: at,
      state: fields.state ?? "completed",
      createdAt: at,
      ...fields,
    }),
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  process.env.CONVEX_SITE_URL = "https://fleet.example.test";
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.CONVEX_SITE_URL;
});

describe("API token policy", () => {
  it("mints 256-bit tokens with a recognisable prefix", () => {
    const token = newApiToken();
    expect(token).toMatch(/^erainfra_[0-9a-f]{64}$/);
    expect(isWellFormedApiToken(token)).toBe(true);
    expect(newApiToken()).not.toBe(token);
  });

  it("reads only bearer credentials", () => {
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken("bearer abc")).toBe("abc");
    expect(bearerToken("Basic abc")).toBeNull();
    expect(bearerToken("Bearer")).toBeNull();
    expect(bearerToken("Bearer a b")).toBeNull();
    expect(bearerToken(null)).toBeNull();
  });
});

describe("operator API authentication", () => {
  it("refuses a request with no token, and says how to send one", async () => {
    const { t } = await harness();
    const response = await get(t, "/api/v1/profiles");
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe('Bearer realm="erainfra"');
    expect(await response.json()).toEqual({
      error: { code: "unauthorized", message: expect.stringContaining("Bearer") },
    });
  });

  it("gives an unknown, a malformed and a revoked token the same 401", async () => {
    const { t, operator } = await harness();
    const { _id, token } = await mint(operator, "read");
    expect((await get(t, "/api/v1/profiles", token)).status).toBe(200);

    await operator.mutation(api.apiTokens.revoke, { tokenId: _id });
    const bodies = [];
    for (const presented of [token, newApiToken(), "not-a-token"]) {
      const response = await get(t, "/api/v1/profiles", presented);
      expect(response.status).toBe(401);
      bodies.push(await response.json());
    }
    expect(new Set(bodies.map((body) => JSON.stringify(body))).size).toBe(1);
  });

  it("stores only the token's digest and never lists it", async () => {
    const { t, operator } = await harness();
    const { token } = await mint(operator, "admin");
    const [row] = await t.run(async (ctx) => ctx.db.query("apiTokens").collect());
    expect(row.tokenHash).toBe(await hashApiToken(token));
    expect(JSON.stringify(row)).not.toContain(token);

    const listed = await operator.query(api.apiTokens.list, {});
    expect(listed).toEqual([
      expect.objectContaining({
        name: "admin token",
        scope: "admin",
        hint: token.slice(0, 17),
        createdByEmail: "operator@example.test",
      }),
    ]);
    expect(JSON.stringify(listed)).not.toContain(token);
  });

  it("lets only a signed-in operator mint, list or revoke tokens", async () => {
    const { t } = await harness();
    await expect(t.mutation(api.apiTokens.create, { name: "x", scope: "read" })).rejects.toThrow(
      /Authentication required/,
    );
    await expect(t.query(api.apiTokens.list, {})).rejects.toThrow(/Authentication required/);
  });

  it("refuses a read-only token on an admin route with 403", async () => {
    const { t, operator } = await harness();
    const { token } = await mint(operator, "read");
    const response = await t.fetch("/api/v1/workers/registration-tokens", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("forbidden");
    expect(await t.run(async (ctx) => ctx.db.query("registrationTokens").collect())).toEqual([]);
  });

  it("lets an admin token mint a Worker registration token, as the dashboard does", async () => {
    const { t, operator } = await harness();
    const { token } = await mint(operator, "admin");
    const response = await t.fetch("/api/v1/workers/registration-tokens", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.registrationToken).toMatch(/^rcreg_/);
    expect(body.installCommands.posix).toBe(
      `curl -fsSL https://fleet.example.test/install | bash -s -- --token ${body.registrationToken}`,
    );
    expect(body.expiresAt).toBe(new Date(T0 + 15 * 60_000).toISOString());
  });

  it("reports the caller's own token and records when it was last used", async () => {
    const { t, operator } = await harness();
    const { _id, token } = await mint(operator, "read");
    const response = await get(t, "/api/v1/token", token);
    expect(await response.json()).toEqual({ token: { name: "read token", scope: "read" } });
    const lastUsed = async () => (await t.run(async (ctx) => ctx.db.get(_id)))?.lastUsedAt;
    expect(await lastUsed()).toBe(T0);

    vi.setSystemTime(T0 + LAST_USED_RESOLUTION_MS - 1);
    await get(t, "/api/v1/token", token);
    expect(await lastUsed()).toBe(T0);

    vi.setSystemTime(T0 + LAST_USED_RESOLUTION_MS);
    await get(t, "/api/v1/token", token);
    expect(await lastUsed()).toBe(T0 + LAST_USED_RESOLUTION_MS);
  });

  it("answers an unknown API path in JSON", async () => {
    const { t, operator } = await harness();
    const { token } = await mint(operator, "read");
    const response = await get(t, "/api/v1/nothing-here", token);
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("not_found");
  });
});

describe("operator API reads", () => {
  async function fleet() {
    const { t, operator } = await harness();
    const { token } = await mint(operator, "read");
    await t.mutation(internal.controllerApi.registerProfile, {
      ...CONTRACT,
      name: "erainfra-4vcpu-ubuntu-2404",
      scaleSetName: "erainfra-4vcpu-ubuntu-2404",
      minRunners: 0,
      maxRunners: 4,
    });
    const machineId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("machines", {
        name: "ubuntu0",
        os: "linux",
        labels: [],
        arch: "x64",
        cpus: 16,
        memoryMiB: 65_536,
        maxSlots: 3,
        usedSlots: 1,
        lastSeen: T0,
        token: "machine-secret",
      });
      await ctx.db.insert("workerReadiness", {
        ...CONTRACT,
        machineId: id,
        profile: "erainfra-4vcpu-ubuntu-2404",
        state: "preparing",
        checkedAt: T0,
        statusDetail: "pulling image",
      });
      return id;
    });
    return { t, token, machineId };
  }

  it("lists Profiles with readiness counts", async () => {
    const { t, token } = await fleet();
    const response = await get(t, "/api/v1/profiles", token);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const { profiles } = await response.json();
    expect(profiles).toEqual([
      expect.objectContaining({
        name: "erainfra-4vcpu-ubuntu-2404",
        state: "active",
        executor: "firecracker",
        boundary: "guest-kernel",
        readyWorkers: 0,
        freeSlots: 0,
        readiness: { ready: 0, preparing: 1, degraded: 0, failed: 0 },
        workers: [expect.objectContaining({ name: "ubuntu0", state: "preparing", online: true })],
      }),
    ]);
  });

  it("lists Workers with slots, readiness and heartbeat, and never the machine token", async () => {
    const { t, token, machineId } = await fleet();
    await seedAttempt(t, T0, { state: "running", machineId });
    vi.setSystemTime(T0 + 30_000);
    const response = await get(t, "/api/v1/workers", token);
    const text = await response.text();
    expect(text).not.toContain("machine-secret");
    const { workers } = JSON.parse(text);
    expect(workers).toEqual([
      expect.objectContaining({
        name: "ubuntu0",
        os: "linux",
        cpus: 16,
        online: true,
        lastHeartbeatAt: new Date(T0).toISOString(),
        slots: { max: 3, used: 1, policy: "auto", recommended: null },
        readiness: [
          expect.objectContaining({
            profile: "erainfra-4vcpu-ubuntu-2404",
            state: "preparing",
            statusDetail: "pulling image",
          }),
        ],
        activeAttempts: [expect.objectContaining({ state: "running" })],
      }),
    ]);
  });

  it("pages through Attempts newest first with an opaque cursor", async () => {
    const { t, token } = await fleet();
    for (let index = 0; index < 5; index += 1) {
      await seedAttempt(t, T0 + index * 1_000);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    const pageSizes: number[] = [];
    do {
      const query: string = cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`;
      const response = await get(t, `/api/v1/attempts?limit=2${query}`, token);
      expect(response.status).toBe(200);
      const body = await response.json();
      pageSizes.push(body.attempts.length);
      seen.push(...body.attempts.map((attempt: { createdAt: string }) => attempt.createdAt));
      cursor = body.nextCursor;
    } while (cursor !== null && pageSizes.length < 10);
    expect(pageSizes.slice(0, 3)).toEqual([2, 2, 1]);
    expect(seen).toEqual(
      [4, 3, 2, 1, 0].map((index) => new Date(T0 + index * 1_000).toISOString()),
    );
  });

  it("filters by Profile, state, repository and age", async () => {
    // Convex creation times only move forward, so the fleet is set up before
    // the oldest Attempt rather than at T0.
    vi.setSystemTime(T0 - 4 * 86_400_000);
    const { t, token } = await fleet();
    await seedAttempt(t, T0 - 3 * 86_400_000, { repo: "acme/web" });
    await seedAttempt(t, T0 - 1_000, { repo: "web", owner: "acme", state: "failed" });
    await seedAttempt(t, T0 - 500, { repo: "acme/api" });
    await seedAttempt(t, T0 - 100, { profile: "rc-linux-js", repo: "acme/web" });
    vi.setSystemTime(T0);

    const repos = async (query: string) => {
      const response = await get(t, `/api/v1/attempts?${query}`, token);
      expect(response.status).toBe(200);
      return (await response.json()).attempts.map(
        (attempt: { profile: string; repo: string; state: string }) =>
          `${attempt.profile}:${attempt.repo}:${attempt.state}`,
      );
    };

    expect(await repos("profile=rc-linux-js")).toEqual(["rc-linux-js:acme/web:completed"]);
    expect(await repos("state=failed")).toEqual(["erainfra-4vcpu-ubuntu-2404:acme/web:failed"]);
    expect(await repos("repo=acme/web")).toEqual([
      "rc-linux-js:acme/web:completed",
      "erainfra-4vcpu-ubuntu-2404:acme/web:failed",
      "erainfra-4vcpu-ubuntu-2404:acme/web:completed",
    ]);
    expect(await repos("repo=acme/web&since=1d")).toEqual([
      "rc-linux-js:acme/web:completed",
      "erainfra-4vcpu-ubuntu-2404:acme/web:failed",
    ]);
    expect(await repos("profile=erainfra-4vcpu-ubuntu-2404&state=completed&since=1h")).toEqual([
      "erainfra-4vcpu-ubuntu-2404:acme/api:completed",
    ]);
    expect(await repos(`since=${new Date(T0 - 2_000).toISOString()}`)).toHaveLength(3);
  });

  it("refuses malformed filters and a cursor from nowhere with 400", async () => {
    const { t, token } = await fleet();
    await seedAttempt(t, T0);
    for (const query of [
      "state=done",
      "limit=0",
      "limit=101",
      "since=yesterday",
      "repo=a/b/c",
      "colour=blue",
    ]) {
      const response = await get(t, `/api/v1/attempts?${query}`, token);
      expect(response.status, query).toBe(400);
      expect((await response.json()).error.code).toBe("invalid_request");
    }
    const response = await get(t, "/api/v1/attempts?cursor=garbage", token);
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_cursor");
  });

  it("shows one Attempt with queue wait and duration, and never its JIT config", async () => {
    const { t, token, machineId } = await fleet();
    const id = await seedAttempt(t, T0, {
      repo: "web",
      owner: "acme",
      machineId,
      queueTime: T0 + 1_000,
      runnerAssignedAt: T0 + 4_000,
      startedAt: T0 + 5_000,
      finishedAt: T0 + 65_000,
      workflowRunId: 77,
      jitConfig: "single-use-secret",
    });
    const response = await get(t, `/api/v1/attempts/${id}`, token);
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain("single-use-secret");
    expect(JSON.parse(text).attempt).toMatchObject({
      id,
      repo: "acme/web",
      worker: "ubuntu0",
      queueWaitMs: 3_000,
      durationMs: 60_000,
      workflowRunUrl: "https://github.com/acme/web/actions/runs/77",
      runnerName: `runner-${T0}`,
    });

    for (const missing of ["nope", encodeURIComponent("a/b")]) {
      const notFound = await get(t, `/api/v1/attempts/${missing}`, token);
      expect(notFound.status).toBe(404);
    }
  });
});

describe("operator API parameter parsing", () => {
  const now = T0;

  it("reads spans and RFC 3339 times for since", () => {
    expect(parseSince("30m", now)).toBe(now - 30 * 60_000);
    expect(parseSince("24h", now)).toBe(now - 86_400_000);
    expect(parseSince("7d", now)).toBe(now - 7 * 86_400_000);
    expect(parseSince("2026-10-31", now)).toBe(Date.parse("2026-10-31"));
    expect(parseSince("2026-10-31T12:00:00Z", now)).toBe(Date.parse("2026-10-31T12:00:00Z"));
    for (const bad of ["0h", "1w", "-1d", "yesterday", "1730000000000", ""]) {
      expect(parseSince(bad, now), bad).toBeNull();
    }
  });

  it("defaults the page size and keeps the cursor opaque", () => {
    const parsed = parseAttemptQuery(new URLSearchParams(""), now);
    expect(parsed).toEqual({ ok: true, query: { limit: 50, cursor: null } });
  });
});
