import { convexTest, type TestConvex } from "convex-test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../convex/_generated/api";
import schema from "../convex/schema";
import { githubMock } from "./support/githubMock.ts";
import { RECENT_FAILURE_LIMIT } from "../convex/webhooks";

const modules = {
  ...import.meta.glob("../convex/**/*.ts"),
  "../convex/github.ts": githubMock,
};

// Carries the schema so ctx.db is fully typed inside t.run().
type Harness = TestConvex<typeof schema>;

const OPERATOR = { subject: "operator", issuer: "test" };

beforeEach(() => {
  vi.stubEnv("ALLOWED_REPOS", "acme/app");
  vi.stubEnv("ALLOW_PUBLIC_REPOS", "");
});

type DeliverySeed = {
  deliveryId: string;
  status: "pending" | "processed" | "rejected" | "failed";
  receivedAt: number;
  settledAt?: number;
  attempts?: number;
  lastError?: string;
  repo?: string;
};

function seedDelivery(t: Harness, seed: DeliverySeed) {
  return t.run(async (ctx) =>
    ctx.db.insert("webhookDeliveries", {
      deliveryId: seed.deliveryId,
      event: "workflow_job",
      receivedAt: seed.receivedAt,
      status: seed.status,
      attempts: seed.attempts ?? 1,
      lastError: seed.lastError,
      settledAt: seed.settledAt,
      workflowJob: {
        action: "queued" as const,
        ghJobId: 1,
        githubInstallationId: 42,
        repo: seed.repo ?? "acme/app",
        repoIsPublic: false,
        workflowName: "CI",
        labels: ["self-hosted", "rc-linux"],
      },
    }),
  );
}

describe("settings.repositoryPolicy", () => {
  it("requires dashboard authentication", async () => {
    const t = convexTest(schema, modules);
    await expect(t.query(api.settings.repositoryPolicy, {})).rejects.toThrow(
      /Authentication required/,
    );
  });

  it("reports a configured allowlist with its normalized patterns", async () => {
    vi.stubEnv("ALLOWED_REPOS", " Acme/App , acme/tools , acme/app ");
    const t = convexTest(schema, modules).withIdentity(OPERATOR);

    const policy = await t.query(api.settings.repositoryPolicy, {});
    expect(policy.configured).toBe(true);
    // Trimmed, lowercased, de-duplicated — what decideRepository matches on.
    expect(policy.allowedRepos).toEqual(["acme/app", "acme/tools"]);
    expect(policy.allowsAllRepos).toBe(false);
    expect(policy.allowPublicRepos).toBe(false);
  });

  it("reports an unset allowlist as not configured", async () => {
    vi.stubEnv("ALLOWED_REPOS", "");
    const t = convexTest(schema, modules).withIdentity(OPERATOR);

    const policy = await t.query(api.settings.repositoryPolicy, {});
    expect(policy.configured).toBe(false);
    expect(policy.allowedRepos).toEqual([]);
  });

  it("surfaces the wildcard and the public opt-in", async () => {
    vi.stubEnv("ALLOWED_REPOS", "*");
    vi.stubEnv("ALLOW_PUBLIC_REPOS", "true");
    const t = convexTest(schema, modules).withIdentity(OPERATOR);

    const policy = await t.query(api.settings.repositoryPolicy, {});
    expect(policy.allowsAllRepos).toBe(true);
    expect(policy.allowPublicRepos).toBe(true);
  });
});

describe("webhooks.recentFailures", () => {
  it("requires dashboard authentication", async () => {
    const t = convexTest(schema, modules);
    await expect(t.query(api.webhooks.recentFailures, {})).rejects.toThrow(
      /Authentication required/,
    );
  });

  it("returns only rejected and failed deliveries, newest first", async () => {
    const t = convexTest(schema, modules);
    await seedDelivery(t, { deliveryId: "ok", status: "processed", receivedAt: 500 });
    await seedDelivery(t, { deliveryId: "waiting", status: "pending", receivedAt: 600 });
    await seedDelivery(t, {
      deliveryId: "old-reject",
      status: "rejected",
      receivedAt: 100,
      lastError: "Repository evil/fork is not in ALLOWED_REPOS",
      repo: "evil/fork",
    });
    await seedDelivery(t, { deliveryId: "recent-fail", status: "failed", receivedAt: 300 });

    const failures = await t.withIdentity(OPERATOR).query(api.webhooks.recentFailures, {});
    expect(failures.map((d) => d.deliveryId)).toEqual(["recent-fail", "old-reject"]);
    expect(failures.map((d) => d.status)).toEqual(["failed", "rejected"]);
  });

  it("exposes the diagnostic fields and lifts the repository out of the event", async () => {
    const t = convexTest(schema, modules);
    await seedDelivery(t, {
      deliveryId: "d-1",
      status: "rejected",
      receivedAt: 100,
      settledAt: 150,
      attempts: 3,
      lastError: "Repository evil/fork is not in ALLOWED_REPOS",
      repo: "evil/fork",
    });

    const [delivery] = await t.withIdentity(OPERATOR).query(api.webhooks.recentFailures, {});
    expect(delivery).toMatchObject({
      deliveryId: "d-1",
      event: "workflow_job",
      repo: "evil/fork",
      status: "rejected",
      receivedAt: 100,
      settledAt: 150,
      attempts: 3,
      lastError: "Repository evil/fork is not in ALLOWED_REPOS",
    });
  });

  // The projection is the security control: the stored event (labels, job ids,
  // installation id) must not ride along to a browser just because it is on the
  // document. Asserted on the key set so adding a column cannot widen it silently.
  it("never returns the stored event payload", async () => {
    const t = convexTest(schema, modules);
    // Every optional populated, so the key set below is the whole surface
    // rather than whatever happened to be set.
    await seedDelivery(t, {
      deliveryId: "d-1",
      status: "rejected",
      receivedAt: 100,
      settledAt: 150,
      lastError: "not allowed",
    });

    const [delivery] = await t.withIdentity(OPERATOR).query(api.webhooks.recentFailures, {});
    expect(Object.keys(delivery ?? {}).toSorted()).toEqual([
      "_id",
      "attempts",
      "deliveryId",
      "event",
      "lastError",
      "receivedAt",
      "repo",
      "settledAt",
      "status",
    ]);
    expect(JSON.stringify(delivery)).not.toContain("githubInstallationId");
    expect(JSON.stringify(delivery)).not.toContain("rc-linux");
  });

  it("caps how much history it returns", async () => {
    const t = convexTest(schema, modules);
    for (let index = 0; index < RECENT_FAILURE_LIMIT + 10; index += 1) {
      await seedDelivery(t, {
        deliveryId: `d-${index}`,
        status: "rejected",
        receivedAt: 1_000 + index,
      });
    }

    const failures = await t.withIdentity(OPERATOR).query(api.webhooks.recentFailures, {});
    expect(failures).toHaveLength(RECENT_FAILURE_LIMIT);
    // Capped from the newest end, not the oldest.
    expect(failures[0]?.deliveryId).toBe(`d-${RECENT_FAILURE_LIMIT + 9}`);
  });

  it("returns nothing when no delivery has failed", async () => {
    const t = convexTest(schema, modules);
    await seedDelivery(t, { deliveryId: "ok", status: "processed", receivedAt: 100 });

    expect(await t.withIdentity(OPERATOR).query(api.webhooks.recentFailures, {})).toEqual([]);
  });
});
