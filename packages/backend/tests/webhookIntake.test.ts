import { convexTest, type TestConvex } from "convex-test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import { parseWorkflowJob } from "../convex/http";
import { githubMock } from "./support/githubMock.ts";

// The real `github` module is swapped out: convex-test executes scheduled
// functions, so tryAssign/reconcile would otherwise drive Octokit at the
// network. See tests/support/githubMock.ts.
const modules = {
  ...import.meta.glob("../convex/**/*.ts"),
  "../convex/github.ts": githubMock,
};

type WorkflowJob = {
  action: "queued" | "in_progress" | "completed";
  ghJobId: number;
  githubInstallationId?: number;
  repo: string;
  repoIsPublic: boolean;
  workflowName: string;
  labels: string[];
  runnerName?: string;
  conclusion?: string;
};

function workflowJob(overrides: Partial<WorkflowJob> = {}): WorkflowJob {
  return {
    action: "queued",
    ghJobId: 1234,
    githubInstallationId: 42,
    repo: "acme/app",
    repoIsPublic: false,
    workflowName: "CI",
    labels: ["self-hosted", "rc-linux"],
    ...overrides,
  };
}

// Carries the schema so ctx.db is fully typed inside t.run().
type Harness = TestConvex<typeof schema>;

/** Record a delivery and run its scheduled processor, as the HTTP route does. */
async function deliver(t: Harness, deliveryId: string, event: WorkflowJob) {
  const { duplicate } = await t.mutation(internal.webhooks.recordDelivery, {
    deliveryId,
    event: "workflow_job",
    workflowJob: event,
  });
  const delivery = await t.run(async (ctx) =>
    ctx.db
      .query("webhookDeliveries")
      .withIndex("by_deliveryId", (q) => q.eq("deliveryId", deliveryId))
      .unique(),
  );
  if (delivery !== null && delivery.status === "pending") {
    await t.mutation(internal.webhooks.processDelivery, { deliveryId: delivery._id });
  }
  return { duplicate };
}

function jobs(t: Harness) {
  return t.run(async (ctx) => ctx.db.query("jobs").collect());
}

function deliveries(t: Harness) {
  return t.run(async (ctx) => ctx.db.query("webhookDeliveries").collect());
}

beforeEach(() => {
  vi.stubEnv("ALLOWED_REPOS", "acme/app");
  vi.stubEnv("ALLOW_PUBLIC_REPOS", "");
});

describe("workflow_job payload parsing", () => {
  it("retains GitHub's actual runner name for assignment reconciliation", () => {
    expect(
      parseWorkflowJob({
        action: "in_progress",
        workflow_job: {
          id: 1234,
          workflow_name: "CI",
          labels: ["self-hosted", "macos-15"],
          runner_name: "rc-host-5678-1",
        },
        repository: { full_name: "acme/app", private: true },
        installation: { id: 42 },
      }),
    ).toMatchObject({
      ghJobId: 1234,
      runnerName: "rc-host-5678-1",
    });
  });
});

describe("repository allowlist", () => {
  it("creates no job for a repository that is not allowlisted", async () => {
    const t = convexTest(schema, modules);
    await deliver(t, "d-1", workflowJob({ repo: "evil/fork" }));

    expect(await jobs(t)).toHaveLength(0);
    const [delivery] = await deliveries(t);
    expect(delivery?.status).toBe("rejected");
    expect(delivery?.lastError).toContain("not in ALLOWED_REPOS");
  });

  it("creates no job for an allowlisted but public repository without the opt-in", async () => {
    const t = convexTest(schema, modules);
    await deliver(t, "d-1", workflowJob({ repoIsPublic: true }));

    expect(await jobs(t)).toHaveLength(0);
    const [delivery] = await deliveries(t);
    expect(delivery?.status).toBe("rejected");
    expect(delivery?.lastError).toContain("ALLOW_PUBLIC_REPOS");
  });

  it("accepts a public repository once it is explicitly opted in", async () => {
    vi.stubEnv("ALLOW_PUBLIC_REPOS", "true");
    const t = convexTest(schema, modules);
    await deliver(t, "d-1", workflowJob({ repoIsPublic: true }));

    expect(await jobs(t)).toHaveLength(1);
  });

  it("rejects everything when ALLOWED_REPOS is unset", async () => {
    vi.stubEnv("ALLOWED_REPOS", "");
    const t = convexTest(schema, modules);
    await deliver(t, "d-1", workflowJob());

    expect(await jobs(t)).toHaveLength(0);
  });

  it("enforces the allowlist before any job row exists, not after", async () => {
    const t = convexTest(schema, modules);
    await deliver(t, "d-1", workflowJob({ repo: "evil/fork", action: "queued" }));
    // Nothing was created and then cleaned up: the table was never written.
    expect(await jobs(t)).toHaveLength(0);
  });
});

describe("delivery idempotency", () => {
  it("processes a redelivered event exactly once", async () => {
    const t = convexTest(schema, modules);
    const event = workflowJob();

    const first = await deliver(t, "delivery-a", event);
    const second = await deliver(t, "delivery-a", event);
    const third = await deliver(t, "delivery-a", event);

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(third.duplicate).toBe(true);
    expect(await jobs(t)).toHaveLength(1);
    expect(await deliveries(t)).toHaveLength(1);
  });

  it("still treats two distinct deliveries of the same job as one job", async () => {
    const t = convexTest(schema, modules);
    await deliver(t, "delivery-a", workflowJob());
    await deliver(t, "delivery-b", workflowJob());

    expect(await deliveries(t)).toHaveLength(2);
    expect(await jobs(t)).toHaveLength(1);
  });

  it("does not reprocess a delivery that already settled", async () => {
    const t = convexTest(schema, modules);
    await deliver(t, "delivery-a", workflowJob());
    const [delivery] = await deliveries(t);
    expect(delivery).toBeDefined();

    await t.mutation(internal.webhooks.processDelivery, { deliveryId: delivery!._id });
    expect(await jobs(t)).toHaveLength(1);
  });
});

describe("out-of-order delivery", () => {
  it("does not provision a runner when completed arrives before queued", async () => {
    const t = convexTest(schema, modules);

    await deliver(t, "d-completed", workflowJob({ action: "completed", conclusion: "cancelled" }));
    let stored = await jobs(t);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.status).toBe("failed");
    expect(stored[0]?.conclusion).toBe("cancelled");

    // The late "queued" must not resurrect a job that has already finished.
    await deliver(t, "d-queued", workflowJob({ action: "queued" }));
    stored = await jobs(t);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.status).toBe("failed");

    const assigned = await t.mutation(internal.scheduler.tryAssign, {});
    expect(assigned).toBe(0);
    const commands = await t.run(async (ctx) => ctx.db.query("commands").collect());
    expect(commands).toHaveLength(0);
  });

  it("records a successful completion that arrives first as done", async () => {
    const t = convexTest(schema, modules);
    await deliver(t, "d-1", workflowJob({ action: "completed", conclusion: "success" }));
    const [job] = await jobs(t);
    expect(job?.status).toBe("done");
  });

  it("does not resurrect a job when queued arrives after in_progress", async () => {
    const t = convexTest(schema, modules);

    await deliver(t, "d-progress", workflowJob({ action: "in_progress" }));
    expect((await jobs(t))[0]?.status).toBe("running");

    await deliver(t, "d-queued", workflowJob({ action: "queued" }));
    const stored = await jobs(t);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.status).toBe("running");
  });

  it("ignores an out-of-order event for a job that is not self-hosted", async () => {
    const t = convexTest(schema, modules);
    await deliver(
      t,
      "d-1",
      workflowJob({ action: "completed", labels: ["ubuntu-latest"], conclusion: "success" }),
    );
    expect(await jobs(t)).toHaveLength(0);
  });
});

describe("stalled delivery recovery", () => {
  it("retries a pending delivery and gives up after the attempt budget", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.webhooks.recordDelivery, {
      deliveryId: "stuck",
      event: "workflow_job",
      workflowJob: workflowJob(),
    });

    const receivedAt = (await deliveries(t))[0]!.receivedAt;
    // Too soon: nothing is retried yet.
    let result = await t.mutation(internal.webhooks.retryStalledDeliveries, { now: receivedAt });
    expect(result.retried).toBe(0);

    const later = receivedAt + 120_000;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      result = await t.mutation(internal.webhooks.retryStalledDeliveries, { now: later });
      expect(result.retried).toBe(1);
    }
    result = await t.mutation(internal.webhooks.retryStalledDeliveries, { now: later });
    expect(result.abandoned).toBe(1);
    expect((await deliveries(t))[0]?.status).toBe("failed");
  });
});
