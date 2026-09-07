import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { ACTIVITY_SAMPLE, ACTIVITY_WINDOW_MS } from "../convex/profiles";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");

const CONTRACT = {
  executor: "firecracker" as const,
  imageRelease:
    "ghcr.io/fanzzzd/runner@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  vcpus: 4,
  memoryMiB: 16_384,
};

const operator = { subject: "operator", issuer: "https://example.test" };

async function harness() {
  const t = convexTest(schema, modules);
  for (const name of ["rc-e2e", "rc-linux-js"]) {
    await t.mutation(internal.controllerApi.registerProfile, {
      ...CONTRACT,
      name,
      scaleSetName: name,
      minRunners: 0,
      maxRunners: 5,
    });
  }
  return t;
}

async function seedAttempt(
  t: Awaited<ReturnType<typeof harness>>,
  profile: string,
  createdAt: number,
  repo?: string,
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("attempts", {
      ...CONTRACT,
      profile,
      runnerName: `rc-${profile}-${createdAt}`,
      runnerId: createdAt,
      state: "completed",
      createdAt,
      repo,
      displayName: repo === undefined ? undefined : "test",
    });
  });
}

describe("profiles.activity", () => {
  it("reports the last started job per Profile and the week's count", async () => {
    const t = await harness();
    const now = Date.now();
    const day = 24 * 60 * 60_000;
    // rc-linux-js: a consumer job 18 days ago, then only unused capacity.
    await seedAttempt(t, "rc-linux-js", now - 18 * day, "bielcrystal-labs/biel-payable-system");
    await seedAttempt(t, "rc-linux-js", now - 2 * day);
    // rc-e2e: canaries this week, one of them without a job.
    await seedAttempt(t, "rc-e2e", now - 3 * day, "Fanzzzd/erainfra");
    await seedAttempt(t, "rc-e2e", now - 1 * day, "Fanzzzd/erainfra");
    await seedAttempt(t, "rc-e2e", now - 60_000);

    const activity = await t.withIdentity(operator).query(api.profiles.activity, {});

    expect(activity).toEqual([
      {
        name: "rc-e2e",
        lastJob: { repo: "Fanzzzd/erainfra", at: now - 1 * day, displayName: "test" },
        jobsInWindow: 2,
        sampleExhausted: false,
      },
      {
        name: "rc-linux-js",
        lastJob: {
          repo: "bielcrystal-labs/biel-payable-system",
          at: now - 18 * day,
          displayName: "test",
        },
        jobsInWindow: 0,
        sampleExhausted: false,
      },
    ]);
  });

  it("has nothing to say about a Profile no job ever started on", async () => {
    const t = await harness();
    const [e2e] = await t.withIdentity(operator).query(api.profiles.activity, {});
    expect(e2e).toEqual({ name: "rc-e2e", jobsInWindow: 0, sampleExhausted: false });
  });

  it("reads a bounded window and says so when the week overflows it", async () => {
    const t = await harness();
    const now = Date.now();
    for (let i = 0; i < ACTIVITY_SAMPLE + 5; i++) {
      await seedAttempt(t, "rc-e2e", now - i * 60_000, "Fanzzzd/erainfra");
    }
    const [e2e] = await t.withIdentity(operator).query(api.profiles.activity, {});
    expect(e2e).toMatchObject({ jobsInWindow: ACTIVITY_SAMPLE, sampleExhausted: true });
    expect(ACTIVITY_SAMPLE * 60_000).toBeLessThan(ACTIVITY_WINDOW_MS);
  });

  it("requires the dashboard identity", async () => {
    const t = await harness();
    await expect(t.query(api.profiles.activity, {})).rejects.toThrow(/Authentication required/);
  });
});
