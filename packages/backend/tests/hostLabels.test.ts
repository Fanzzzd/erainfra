import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, it } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { missingHostLabels, normalizeHostLabels } from "../convex/hostLabels";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");
type Harness = TestConvex<typeof schema>;

// A Profile pinned to host labels (ADR 0017) beside an unpinned one, on the same image and size.
const PINNED = "erainfra-4vcpu-ubuntu-2404-gpu";
const PLAIN = "erainfra-4vcpu-ubuntu-2404";
const CONTRACT = {
  executor: "firecracker" as const,
  imageRelease:
    "ghcr.io/fanzzzd/runner@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  vcpus: 2,
  memoryMiB: 4096,
};

const FIRECRACKER_FACTS = {
  isolation: "firecracker-microvm",
  boundary: "guest-kernel" as const,
  checks: [
    "firecracker-binary",
    "guest-kernel-image",
    "guest-kernel-arguments",
    "kvm-device",
    "cni-plugins",
    "cni-network-configuration",
    "job-network-policy",
    "containerd-snapshotter",
    "cni-address-reservations",
    "snapshot-storage-headroom",
    "cache-isolation",
    "image-release",
    "warm-pool",
  ].map((name) => ({ name, passed: true })),
  cacheScope: "immutable-image",
  cacheSharedWritable: false,
  hardware: { kvm: true },
  storage: {
    snapshotter: "devmapper",
    poolName: "runner-center-thinpool",
    poolTotalMiB: 51_200,
    poolFreeMiB: 40_960,
  },
  network: {
    policyName: "runner-center",
    policyHash: `sha256:${"b".repeat(64)}`,
    subnet: "10.241.0.0/16",
    egressMode: "public",
  },
};

async function registerProfile(t: Harness, name: string, workerLabels?: string[]) {
  return await t.mutation(internal.controllerApi.registerProfile, {
    name,
    scaleSetName: name,
    ...CONTRACT,
    minRunners: 0,
    maxRunners: 4,
    ...(workerLabels === undefined ? {} : { workerLabels }),
  });
}

async function addMachine(t: Harness, name: string, labels: string[]) {
  return await t.run(async (ctx) =>
    ctx.db.insert("machines", {
      name,
      os: "linux",
      labels,
      maxSlots: 2,
      usedSlots: 0,
      lastSeen: Date.now(),
      token: `token-${name}`,
    }),
  );
}

async function reportReady(t: Harness, machine: string, profile: string) {
  return await t.mutation(api.workerApi.reportReadiness, {
    token: `token-${machine}`,
    profile,
    ...CONTRACT,
    state: "ready",
    ...FIRECRACKER_FACTS,
    warmPool: { target: 0, parked: 0, claimed: 0 },
  });
}

async function createAttempt(t: Harness, profile: string, runnerId: number) {
  await t.mutation(internal.controllerApi.createAttempt, {
    profile,
    ...CONTRACT,
    runnerName: `runner-${runnerId}`,
    runnerId,
    encodedJITConfig: `secret-${runnerId}`,
  });
  await t.mutation(internal.attemptScheduler.tryAssign, {});
}

async function placements(t: Harness) {
  return await t.run(async (ctx) => {
    const machines = new Map(
      (await ctx.db.query("machines").collect()).map((machine) => [machine._id, machine.name]),
    );
    return (await ctx.db.query("attempts").collect()).map((attempt) => ({
      runner: attempt.runnerName,
      profile: attempt.profile,
      worker: attempt.machineId === undefined ? undefined : machines.get(attempt.machineId),
    }));
  });
}

describe("host labels", () => {
  it("normalizes labels and refuses anything that is not one", () => {
    expect(normalizeHostLabels([" GPU", "nvme", "gpu"])).toEqual({
      ok: true,
      labels: ["gpu", "nvme"],
    });
    for (const bad of [["has space"], ["-x"], [""], ["a".repeat(64)], [1]]) {
      expect(normalizeHostLabels(bad).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(normalizeHostLabels(Array.from({ length: 17 }, (_, i) => `l${i}`)).ok).toBe(false);
    // Labels a Worker registered with before ADR 0017 may be any case.
    expect(missingHostLabels(["gpu", "hk"], ["GPU"])).toEqual(["hk"]);
    expect(missingHostLabels(undefined, [])).toEqual([]);
  });
});

describe("a Profile pinned to host labels", () => {
  it("is discovered, made ready and scheduled only on Workers carrying every label", async () => {
    const t = convexTest(schema, modules);
    await registerProfile(t, PINNED, ["gpu"]);
    await registerProfile(t, PLAIN);
    await addMachine(t, "plain-1", []);
    await addMachine(t, "gpu-1", ["gpu", "nvme"]);

    const discovered = async (machine: string) =>
      (await t.query(api.workerApi.profiles, { token: `token-${machine}` })).map(
        (profile) => profile.profile,
      );
    expect(await discovered("plain-1")).toEqual([PLAIN]);
    expect(await discovered("gpu-1")).toEqual([PLAIN, PINNED]);

    // A Worker without the label cannot advertise the Profile even if it tries.
    await expect(reportReady(t, "plain-1", PINNED)).rejects.toThrow(
      "this Worker lacks the host label gpu the Profile is pinned to",
    );
    await reportReady(t, "plain-1", PLAIN);
    await reportReady(t, "gpu-1", PLAIN);
    await reportReady(t, "gpu-1", PINNED);

    await createAttempt(t, PINNED, 1);
    await createAttempt(t, PINNED, 2);
    await createAttempt(t, PINNED, 3);
    // gpu-1 has two slots; the third pinned Attempt waits rather than spill onto plain-1.
    expect(await placements(t)).toEqual([
      { runner: "runner-1", profile: PINNED, worker: "gpu-1" },
      { runner: "runner-2", profile: PINNED, worker: "gpu-1" },
      { runner: "runner-3", profile: PINNED, worker: undefined },
    ]);

    // The unpinned Profile still uses any Worker.
    await createAttempt(t, PLAIN, 4);
    expect((await placements(t)).at(-1)).toEqual({
      runner: "runner-4",
      profile: PLAIN,
      worker: "plain-1",
    });
  });

  it("stops counting a Worker the moment it loses a label, everywhere readiness is read", async () => {
    const t = convexTest(schema, modules);
    await registerProfile(t, PINNED, ["gpu"]);
    await addMachine(t, "gpu-1", ["gpu"]);
    await reportReady(t, "gpu-1", PINNED);

    const route = async () =>
      (await (await t.fetch(`/runs-on?profile=${PINNED}&fallback=ubuntu-24.04`)).json()) as {
        "runs-on": string;
      };
    expect((await route())["runs-on"]).toBe(PINNED);

    const result = await t.mutation(internal.machines.setLabels, { name: "gpu-1", labels: [] });
    expect(result).toEqual({
      ok: true,
      name: "gpu-1",
      labels: [],
      retiredRunners: 0,
      requeuedAttempts: 0,
    });

    // The readiness row is still there, but neither the router, the Profile list nor the
    // scheduler counts it.
    expect((await route())["runs-on"]).toBe("ubuntu-24.04");
    const [profile] = await t.query(internal.operatorApi.profiles, {});
    expect(profile?.workerLabels).toEqual(["gpu"]);
    expect(profile?.readyWorkers).toBe(0);
    expect(profile?.workers[0]?.lastError).toBe(
      "this Worker lacks the host label gpu the Profile is pinned to",
    );
    await createAttempt(t, PINNED, 1);
    expect((await placements(t))[0]?.worker).toBeUndefined();

    // Giving the label back places the waiting Attempt.
    await t.mutation(internal.machines.setLabels, { name: "gpu-1", labels: ["GPU"] });
    await t.mutation(internal.attemptScheduler.tryAssign, {});
    expect((await placements(t))[0]?.worker).toBe("gpu-1");
    // One of gpu-1's two slots is still free, so the router sends the next job there too.
    expect((await route())["runs-on"]).toBe(PINNED);
  });

  it("unpins when a controller registers the Profile without workerLabels", async () => {
    const t = convexTest(schema, modules);
    await registerProfile(t, PINNED, ["gpu"]);
    await addMachine(t, "plain-1", []);
    expect(await t.query(api.workerApi.profiles, { token: "token-plain-1" })).toEqual([]);
    await registerProfile(t, PINNED);
    const stored = await t.run((ctx) =>
      ctx.db
        .query("profiles")
        .withIndex("by_name", (q) => q.eq("name", PINNED))
        .unique(),
    );
    expect(stored?.workerLabels).toBeUndefined();
    expect(
      (await t.query(api.workerApi.profiles, { token: "token-plain-1" })).map((p) => p.profile),
    ).toEqual([PINNED]);
  });
});

describe("scale-set labels that answer to another Profile's name", () => {
  it("are refused in both directions, because GitHub could hand either Profile's jobs to the other", async () => {
    const t = convexTest(schema, modules);
    await registerProfile(t, PLAIN);
    const second = await t.mutation(internal.controllerApi.registerProfile, {
      name: PINNED,
      scaleSetName: PINNED,
      ...CONTRACT,
      minRunners: 0,
      maxRunners: 4,
      githubConfigUrl: "https://github.com/acme",
      labels: [PINNED, PLAIN, "gpu"],
      workerLabels: ["gpu"],
    });
    expect(second).toEqual({
      conflict: `scale-set label ${PLAIN} is Profile ${PLAIN}'s name; its jobs could run on this Profile instead (ADR 0017)`,
    });
    const stored = await t.run((ctx) => ctx.db.query("profiles").collect());
    expect(stored.map((profile) => profile.name)).toEqual([PLAIN]);

    // The pinned Profile on its own name is fine; then the plain one may not claim it.
    expect(await registerProfile(t, PINNED, ["gpu"])).toBeNull();
    const reverse = await t.mutation(internal.controllerApi.registerProfile, {
      name: PLAIN,
      scaleSetName: PLAIN,
      ...CONTRACT,
      minRunners: 0,
      maxRunners: 4,
      githubConfigUrl: "https://github.com/acme",
      labels: [PLAIN, PINNED.toUpperCase()],
    });
    expect(reverse).toHaveProperty("conflict");
  });
});

describe("the controller and operator HTTP surfaces", () => {
  afterEach(() => {
    delete process.env.CONTROLLER_TOKEN;
  });

  it("registers workerLabels normalized, and answers 409 to a label conflict", async () => {
    const token = "controller-token-for-host-labels";
    process.env.CONTROLLER_TOKEN = token;
    const t = convexTest(schema, modules);
    await registerProfile(t, PLAIN);
    const post = async (body: Record<string, unknown>) => {
      const grant = await t.mutation(internal.controllerLease.acquire, {
        profile: body.name as string,
        hostname: "host-labels-test",
        instance: "host-labels-instance",
        caller: { kind: "controllerToken", slot: "current" },
      });
      if (!grant.granted) throw new Error("the test needs a lease");
      return t.fetch("/controller/profiles", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "X-EraInfra-Lease-Epoch": String(grant.epoch),
        },
        body: JSON.stringify(body),
      });
    };
    const profile = {
      name: PINNED,
      scaleSetName: PINNED,
      ...CONTRACT,
      minRunners: 0,
      maxRunners: 4,
    };
    expect((await post({ ...profile, workerLabels: ["GPU", " hk", "gpu"] })).status).toBe(204);
    const stored = await t.run((ctx) =>
      ctx.db
        .query("profiles")
        .withIndex("by_name", (q) => q.eq("name", PINNED))
        .unique(),
    );
    expect(stored?.workerLabels).toEqual(["gpu", "hk"]);

    expect((await post({ ...profile, workerLabels: ["two words"] })).status).toBe(400);
    expect((await post({ ...profile, workerLabels: "gpu" })).status).toBe(400);

    const conflict = await post({
      ...profile,
      githubConfigUrl: "https://github.com/acme",
      labels: [PINNED, PLAIN],
    });
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { error: string }).error).toContain(
      `scale-set label ${PLAIN}`,
    );
  });

  it("lets an admin token replace a Worker's labels and shows them in /workers and /profiles", async () => {
    const t = convexTest(schema, modules);
    await registerProfile(t, PINNED, ["gpu"]);
    await addMachine(t, "hk-worker01", ["legacy"]);
    const userId = await t.run((ctx) => ctx.db.insert("users", { email: "op@example.test" }));
    const operator = t.withIdentity({ subject: `${userId}|session` });
    const admin = (await operator.mutation(api.apiTokens.create, { name: "a", scope: "admin" }))
      .token;
    const read = (await operator.mutation(api.apiTokens.create, { name: "r", scope: "read" }))
      .token;
    const put = (path: string, body: unknown, bearer = admin) =>
      t.fetch(path, {
        method: "PUT",
        headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });

    const ok = await put("/api/v1/workers/hk-worker01/labels", { labels: ["GPU", "nvme"] });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      worker: { name: "hk-worker01", labels: ["gpu", "nvme"] },
      retiredRunners: 0,
      requeuedAttempts: 0,
    });

    expect((await put("/api/v1/workers/hk-worker01/labels", { labels: ["x"] }, read)).status).toBe(
      403,
    );
    expect((await put("/api/v1/workers/nobody/labels", { labels: [] })).status).toBe(404);
    expect((await put("/api/v1/workers/hk-worker01/labels", { labels: ["a b"] })).status).toBe(400);
    expect((await put("/api/v1/workers/hk-worker01/labels", { labels: "gpu" })).status).toBe(400);
    expect((await put("/api/v1/workers/hk-worker01/labels", "{")).status).toBe(400);
    expect((await put("/api/v1/workers/hk-worker01/other", { labels: [] })).status).toBe(404);

    const get = async (path: string) =>
      (await (await t.fetch(path, { headers: { Authorization: `Bearer ${read}` } })).json()) as {
        workers?: { name: string; labels: string[] }[];
        profiles?: { name: string; workerLabels: string[] }[];
      };
    expect((await get("/api/v1/workers")).workers?.[0]?.labels).toEqual(["gpu", "nvme"]);
    expect((await get("/api/v1/profiles")).profiles?.[0]?.workerLabels).toEqual(["gpu"]);
  });
});
