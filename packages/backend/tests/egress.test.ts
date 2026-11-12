import { readFileSync } from "node:fs";

import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";

import { api, internal } from "../convex/_generated/api";
import { parseRegisterProfile } from "../convex/controllerHttp";
import {
  boundedEgressRecord,
  egressEvidenceError,
  parseProfileEgress,
  PUBLIC_EGRESS,
  type ProfileEgress,
} from "../convex/egress";
import { FIRECRACKER_REQUIRED_CHECKS } from "../convex/isolation";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");
type Harness = TestConvex<typeof schema>;

const IMAGE = `ghcr.io/fanzzzd/runner@sha256:${"a".repeat(64)}`;
const PROFILE = "erainfra-4vcpu-ubuntu-2404-locked";
const GITHUB_ALLOWLIST: ProfileEgress = {
  mode: "allowlist",
  presets: ["github"],
  domains: ["registry.npmjs.org"],
  cidrs: [],
};

const CHECKS = [...FIRECRACKER_REQUIRED_CHECKS].map((name) => ({ name, passed: true }));

function facts(egress?: { mode: string; profile: ProfileEgress; checkPassed?: boolean }) {
  return {
    isolation: "firecracker-microvm",
    boundary: "guest-kernel" as const,
    checks:
      egress === undefined
        ? CHECKS
        : [...CHECKS, { name: "egress-policy", passed: egress.checkPassed ?? true }],
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
      policyHash: `sha256:${"c".repeat(64)}`,
      subnet: "10.241.0.0/16",
      egressMode: egress?.mode ?? "public",
      ...(egress === undefined
        ? {}
        : {
            egress: {
              mode: egress.mode,
              hostMode: "public",
              profileMode: egress.profile.mode,
              presets: egress.profile.presets,
              domains: egress.profile.domains,
              cidrs: egress.profile.cidrs,
              allowedDomainCount: 19,
            },
          }),
    },
  };
}

type SharedCases = {
  valid: { name: string; input: unknown; normalized: ProfileEgress }[];
  invalid: { name: string; input: unknown }[];
};

const shared = JSON.parse(
  readFileSync(new URL("../../../testdata/egress-policy-cases.json", import.meta.url), "utf8"),
) as SharedCases;

describe("parseProfileEgress", () => {
  // The Worker runtime validates the same file in Go, so a rule changed on
  // one side alone turns one suite red.
  it.each(shared.valid)(
    "accepts and normalizes $name like the runtime",
    ({ input, normalized }) => {
      expect(parseProfileEgress(input)).toEqual({ ok: true, egress: normalized });
    },
  );

  it.each(shared.invalid)("refuses $name like the runtime", ({ input }) => {
    expect(parseProfileEgress(input).ok).toBe(false);
  });

  it("refuses fields it does not know rather than dropping them", () => {
    expect(parseProfileEgress({ mode: "allowlist", presets: ["github"], ports: [443] }).ok).toBe(
      false,
    );
  });
});

describe("controller Profile payloads", () => {
  const base = {
    name: PROFILE,
    scaleSetName: PROFILE,
    executor: "firecracker",
    imageRelease: IMAGE,
    vcpus: 2,
    memoryMiB: 4096,
    minRunners: 0,
    maxRunners: 4,
  };

  it("reads a Profile without egress as public", () => {
    expect(parseRegisterProfile(base)?.egress).toEqual(PUBLIC_EGRESS);
  });

  it("carries a normalized egress policy", () => {
    expect(
      parseRegisterProfile({
        ...base,
        egress: { mode: "allowlist", presets: ["github"], domains: ["Registry.NPMJS.org."] },
      })?.egress,
    ).toEqual(GITHUB_ALLOWLIST);
  });

  it("refuses egress no Worker on that executor would enforce", () => {
    for (const executor of ["docker", "tart", "hyperv"]) {
      expect(parseRegisterProfile({ ...base, executor, egress: { mode: "audit" } })).toBeNull();
      expect(
        parseRegisterProfile({ ...base, executor, egress: { mode: "public" } }),
      ).not.toBeNull();
    }
    expect(parseRegisterProfile({ ...base, egress: { mode: "allowlist" } })).toBeNull();
  });
});

function enforced(profile: ProfileEgress, mode: string = profile.mode) {
  return {
    mode,
    hostMode: "public",
    profileMode: profile.mode,
    presets: profile.presets,
    domains: profile.domains,
    cidrs: profile.cidrs,
    allowedDomainCount: 1,
  };
}

describe("egressEvidenceError", () => {
  const passing = [{ name: "egress-policy", passed: true }];

  it("lets evidence that predates Profile egress prove a public Profile, and nothing else", () => {
    expect(egressEvidenceError(PUBLIC_EGRESS, undefined, CHECKS)).toBeUndefined();
    expect(egressEvidenceError(GITHUB_ALLOWLIST, undefined, CHECKS)).toMatch(/required/);
  });

  it("requires the evidence to name the Profile's current policy", () => {
    expect(
      egressEvidenceError(GITHUB_ALLOWLIST, enforced(GITHUB_ALLOWLIST), passing),
    ).toBeUndefined();
    const stale = { ...GITHUB_ALLOWLIST, domains: [] };
    expect(egressEvidenceError(GITHUB_ALLOWLIST, enforced(stale), passing)).toMatch(
      /does not match/,
    );
  });

  it("refuses an effective mode weaker than the Profile's, and a failed check", () => {
    expect(
      egressEvidenceError(GITHUB_ALLOWLIST, enforced(GITHUB_ALLOWLIST, "audit"), passing),
    ).toMatch(/weaker/);
    expect(
      egressEvidenceError(GITHUB_ALLOWLIST, enforced(GITHUB_ALLOWLIST), [
        { name: "egress-policy", passed: false },
      ]),
    ).toMatch(/egress-policy/);
  });

  it("accepts a stricter host override", () => {
    const audit: ProfileEgress = { mode: "audit", presets: [], domains: [], cidrs: [] };
    expect(egressEvidenceError(audit, enforced(audit, "allowlist"), passing)).toBeUndefined();
  });
});

describe("boundedEgressRecord", () => {
  it("clamps a record a compromised host could inflate", () => {
    const record = boundedEgressRecord({
      mode: "audit",
      names: Array.from({ length: 300 }, (_, index) => ({
        name: `host-${index}.example`,
        verdict: "allowed" as const,
        queries: 1.7,
      })),
      flows: [{ destination: "1.1.1.1", protocol: "tcp", port: 99_999, verdict: "blocked" }],
      omittedNames: 4,
    });
    expect(record.names).toHaveLength(256);
    expect(record.omittedNames).toBe(48);
    expect(record.names?.[0]?.queries).toBe(1);
    expect(record.flows?.[0]?.port).toBe(65_535);
  });
});

async function register(t: Harness, egress?: ProfileEgress) {
  await t.mutation(internal.controllerApi.registerProfile, {
    name: PROFILE,
    scaleSetName: PROFILE,
    executor: "firecracker",
    imageRelease: IMAGE,
    vcpus: 2,
    memoryMiB: 4_096,
    minRunners: 0,
    maxRunners: 4,
    ...(egress === undefined ? {} : { egress }),
  });
}

async function addMachine(t: Harness, token: string) {
  return t.run(async (ctx) =>
    ctx.db.insert("machines", {
      name: token,
      os: "linux",
      labels: [],
      maxSlots: 2,
      usedSlots: 0,
      lastSeen: Date.now(),
      token,
    }),
  );
}

function report(token: string, readiness: ReturnType<typeof facts>) {
  return {
    token,
    profile: PROFILE,
    executor: "firecracker" as const,
    imageRelease: IMAGE,
    vcpus: 2,
    memoryMiB: 4_096,
    state: "ready" as const,
    ...readiness,
  };
}

async function createAttempt(t: Harness, runnerName: string, runnerId: number) {
  await t.mutation(internal.controllerApi.createAttempt, {
    profile: PROFILE,
    executor: "firecracker",
    imageRelease: IMAGE,
    vcpus: 2,
    memoryMiB: 4_096,
    runnerName,
    runnerId,
    encodedJITConfig: `secret-${runnerName}`,
  });
  await t.mutation(internal.attemptScheduler.tryAssign, {});
  return t.run(async (ctx) =>
    ctx.db
      .query("attempts")
      .withIndex("by_runnerName", (q) => q.eq("runnerName", runnerName))
      .unique(),
  );
}

describe("Profile egress in the control plane", () => {
  it("stores public as no field, so Profiles registered before egress need no migration", async () => {
    const t = convexTest(schema, modules);
    await register(t, PUBLIC_EGRESS);
    const stored = await t.run(async (ctx) => ctx.db.query("profiles").unique());
    expect(stored?.egress).toBeUndefined();

    await addMachine(t, "token-a");
    const published = await t.query(api.workerApi.profiles, { token: "token-a" });
    expect(published[0]?.egress).toEqual(PUBLIC_EGRESS);

    // A Worker on a runtime that predates Profile egress keeps working for a
    // public Profile.
    await t.mutation(api.workerApi.reportReadiness, report("token-a", facts()));
    const attempt = await createAttempt(t, "runner-a", 1);
    expect(attempt?.machineId).toBeDefined();
  });

  it("publishes an allowlist to Workers and clears it when the controller drops it", async () => {
    const t = convexTest(schema, modules);
    await register(t, GITHUB_ALLOWLIST);
    await addMachine(t, "token-a");
    expect((await t.query(api.workerApi.profiles, { token: "token-a" }))[0]?.egress).toEqual(
      GITHUB_ALLOWLIST,
    );
    await register(t);
    expect((await t.run(async (ctx) => ctx.db.query("profiles").unique()))?.egress).toBeUndefined();
  });

  it("refuses a ready report that does not prove the Profile's allowlist", async () => {
    const t = convexTest(schema, modules);
    await register(t, GITHUB_ALLOWLIST);
    await addMachine(t, "token-a");
    await expect(
      t.mutation(api.workerApi.reportReadiness, report("token-a", facts())),
    ).rejects.toThrow(/network.egress is required/);
    await expect(
      t.mutation(
        api.workerApi.reportReadiness,
        report("token-a", facts({ mode: "public", profile: PUBLIC_EGRESS })),
      ),
    ).rejects.toThrow(/does not match/);
    await t.mutation(
      api.workerApi.reportReadiness,
      report("token-a", facts({ mode: "allowlist", profile: GITHUB_ALLOWLIST })),
    );
    const attempt = await createAttempt(t, "runner-a", 1);
    expect(attempt?.machineId).toBeDefined();

    const claimed = await t.mutation(api.workerApi.claimAttempt, {
      token: "token-a",
      attemptId: attempt!._id,
    });
    expect(claimed?.egress).toEqual(GITHUB_ALLOWLIST);
  });

  it("stops admitting a Worker the moment its Profile's egress changes", async () => {
    const t = convexTest(schema, modules);
    await register(t);
    await addMachine(t, "token-a");
    await t.mutation(
      api.workerApi.reportReadiness,
      report("token-a", facts({ mode: "public", profile: PUBLIC_EGRESS })),
    );
    // The controller restarts with an allowlist; the Worker has not re-run
    // readiness yet, so its evidence still proves only public egress.
    await register(t, GITHUB_ALLOWLIST);
    const attempt = await createAttempt(t, "runner-a", 1);
    expect(attempt?.machineId).toBeUndefined();

    const [listed] = await t.withIdentity({ subject: "operator" }).query(api.profiles.list, {});
    expect(listed?.egress).toEqual(GITHUB_ALLOWLIST);
    expect(listed?.readyWorkers).toBe(0);
    expect(listed?.workers[0]?.state).toBe("degraded");
    expect(listed?.workers[0]?.lastError).toMatch(/egress/);
  });

  it("keeps each Attempt's egress record with the Attempt", async () => {
    const t = convexTest(schema, modules);
    await register(t, GITHUB_ALLOWLIST);
    await addMachine(t, "token-a");
    await t.mutation(
      api.workerApi.reportReadiness,
      report("token-a", facts({ mode: "allowlist", profile: GITHUB_ALLOWLIST })),
    );
    const attempt = await createAttempt(t, "runner-a", 1);
    await t.mutation(api.workerApi.claimAttempt, { token: "token-a", attemptId: attempt!._id });
    await t.mutation(api.workerApi.reportAttempt, {
      token: "token-a",
      attemptId: attempt!._id,
      exitCode: 0,
      egress: {
        mode: "allowlist",
        names: [
          { name: "github.com", verdict: "allowed", queries: 4 },
          { name: "evil.example", verdict: "blocked", queries: 1 },
        ],
        flows: [
          {
            destination: "140.82.112.3",
            protocol: "tcp",
            port: 443,
            name: "github.com",
            verdict: "allowed",
          },
          { destination: "1.1.1.1", protocol: "tcp", port: 443, verdict: "blocked" },
        ],
      },
    });
    const stored = await t.run(async (ctx) => ctx.db.query("attemptEgress").unique());
    expect(stored?.attemptId).toBe(attempt!._id);
    expect(stored?.record.names).toHaveLength(2);
    expect(stored?.record.flows?.[1]).toMatchObject({ destination: "1.1.1.1", verdict: "blocked" });
    // The hot row the scheduler and Worker poll read carries none of it.
    const row = await t.run(async (ctx) => ctx.db.get(attempt!._id));
    expect(JSON.stringify(row)).not.toContain("evil.example");
    const shown = await t
      .withIdentity({ subject: "operator" })
      .query(api.attempts.egress, { attemptId: attempt!._id });
    expect(shown?.record.mode).toBe("allowlist");
    expect(shown?.record.names?.map((entry) => entry.name)).toEqual(["github.com", "evil.example"]);
  });
});
