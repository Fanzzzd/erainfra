import { convexTest } from "convex-test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "../convex/_generated/api";
import schema from "../convex/schema";

// Regression cover for the merge hazard in `octokitFor`.
//
// `issueJit` and `drainRunnerDeletions` both authenticate as the installation.
// Only the `issueJit` block sits in a conflict region when the GitHub App
// onboarding work meets the control-plane hardening, so a resolution that
// fixes the visible hunk and leaves the delete path reading `process.env`
// still typechecks and still passes every other test — while a
// Manifest-created deployment issues JIT configs happily and silently 401s on
// every runner deletion. Nothing observes that but these tests.
//
// Rather than assert on the shape of the source, this drives the real actions
// and records what each GitHub client was actually constructed with.

type AppOptions = { appId: number; privateKey: string };

const constructedApps: AppOptions[] = [];
const constructedPats: string[] = [];
const sentRequests: Array<{ route: string; via: "installation" | "pat"; installationId?: number }> =
  [];

vi.mock("octokit", () => {
  class RequestError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }

  function recordingClient(via: "installation" | "pat", installationId?: number) {
    return {
      request: (route: string) => {
        sentRequests.push({ route, via, installationId });
        return Promise.resolve({
          data: { encoded_jit_config: "jit-config", runner: { id: 77 } },
        });
      },
    };
  }

  class Octokit {
    constructor(options: { auth: string }) {
      constructedPats.push(options.auth);
    }
    request = recordingClient("pat").request;
  }

  class App {
    constructor(options: AppOptions) {
      constructedApps.push(options);
    }
    getInstallationOctokit(installationId: number) {
      return Promise.resolve(recordingClient("installation", installationId));
    }
  }

  return { App, Octokit, RequestError };
});

// The real `github` module — the point of this file — so no override here.
const modules = import.meta.glob("../convex/**/*.ts");

const INSTALLATION_ID = 42;
const STORED = { appId: 4242, privateKey: "-----BEGIN RSA PRIVATE KEY-----stored" };

beforeEach(() => {
  constructedApps.length = 0;
  constructedPats.length = 0;
  sentRequests.length = 0;
  vi.unstubAllEnvs();
  // A hand-registered App and a legacy PAT are both present throughout, so
  // "the stored App was used" is a real choice rather than the only option.
  vi.stubEnv("GITHUB_APP_ID", "999");
  vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "-----BEGIN RSA PRIVATE KEY-----env");
  vi.stubEnv("GITHUB_PAT", "ghp_legacy");
});

function setup() {
  return convexTest(schema, modules);
}

async function storeApp(t: ReturnType<typeof setup>) {
  await t.run(async (ctx) => {
    await ctx.db.insert("githubApp", {
      appId: STORED.appId,
      clientId: "Iv1.abc123",
      slug: "runner-center-test",
      name: "Runner Center Test",
      privateKey: STORED.privateKey,
      webhookSecret: "whsec",
      htmlUrl: "https://github.com/apps/runner-center-test",
      createdAt: Date.now(),
    });
  });
}

// No default parameter anywhere below: passing `undefined` explicitly would
// silently fall back to it, which is exactly the case these tests care about.
async function queueDeletion(
  t: ReturnType<typeof setup>,
  githubInstallationId: number | undefined,
) {
  await t.mutation(internal.runners.enqueue, {
    repo: "acme/app",
    githubInstallationId,
    runnerId: 77,
    runnerName: "rc-abc123",
  });
}

async function issueJitFor(t: ReturnType<typeof setup>, githubInstallationId: number | undefined) {
  const ids = await t.run(async (ctx) => {
    const machineId = await ctx.db.insert("machines", {
      name: "builder-1",
      os: "linux",
      labels: [],
      maxSlots: 1,
      usedSlots: 1,
      lastSeen: Date.now(),
      token: "machine-token",
    });
    const jobId = await ctx.db.insert("jobs", {
      ghJobId: 1234,
      githubInstallationId,
      repo: "acme/app",
      workflowName: "build",
      labels: ["self-hosted"],
      status: "assigned",
      machineId,
      queuedAt: Date.now(),
    });
    const commandId = await ctx.db.insert("commands", {
      machineId,
      jobId,
      runnerName: "rc-abc123",
      status: "pending",
    });
    return { jobId, commandId };
  });

  await t.action(internal.github.issueJit, {
    commandId: ids.commandId,
    jobId: ids.jobId,
    repo: "acme/app",
    githubInstallationId,
    runnerName: "rc-abc123",
    labels: ["self-hosted"],
  });
}

describe("runner deletion credential resolution", () => {
  it("authenticates with the Manifest-stored App, not the environment App", async () => {
    const t = setup();
    await storeApp(t);
    await queueDeletion(t, INSTALLATION_ID);

    const result = await t.action(internal.github.drainRunnerDeletions, {});

    expect(result).toEqual({ deleted: 1, failed: 0 });
    expect(constructedApps).toEqual([STORED]);
    expect(sentRequests).toEqual([
      {
        route: "DELETE /repos/{owner}/{repo}/actions/runners/{runner_id}",
        via: "installation",
        installationId: INSTALLATION_ID,
      },
    ]);
  });

  it("never falls back to the PAT for a deletion carrying an installation id", async () => {
    const t = setup();
    // No stored App and no environment App — only the legacy PAT is available.
    vi.stubEnv("GITHUB_APP_ID", "");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "");
    await queueDeletion(t, INSTALLATION_ID);

    const result = await t.action(internal.github.drainRunnerDeletions, {});

    // Fails closed rather than deleting the runner as the wrong identity.
    expect(result).toEqual({ deleted: 0, failed: 1 });
    expect(constructedPats).toEqual([]);
    expect(sentRequests).toEqual([]);

    const lastError = await t.run(async (ctx) => {
      const [deletion] = await ctx.db.query("runnerDeletions").collect();
      return deletion?.lastError;
    });
    expect(lastError).toMatch(/Connect a GitHub App/);
  });

  it("falls back to the hand-registered environment App when nothing is stored", async () => {
    const t = setup();
    await queueDeletion(t, INSTALLATION_ID);

    await t.action(internal.github.drainRunnerDeletions, {});

    expect(constructedApps).toEqual([
      { appId: 999, privateKey: "-----BEGIN RSA PRIVATE KEY-----env" },
    ]);
    expect(constructedPats).toEqual([]);
  });

  it("uses the PAT only for a deletion with no installation id", async () => {
    const t = setup();
    await storeApp(t);
    await queueDeletion(t, undefined);

    await t.action(internal.github.drainRunnerDeletions, {});

    expect(constructedApps).toEqual([]);
    expect(constructedPats).toEqual(["ghp_legacy"]);
    expect(sentRequests.map((request) => request.via)).toEqual(["pat"]);
  });
});

describe("issueJit and runner deletion share one resolver", () => {
  it("authenticate as the same stored App", async () => {
    const t = setup();
    await storeApp(t);

    await issueJitFor(t, INSTALLATION_ID);
    const afterIssue = [...constructedApps];

    await queueDeletion(t, INSTALLATION_ID);
    await t.action(internal.github.drainRunnerDeletions, {});
    const afterDelete = constructedApps.slice(afterIssue.length);

    expect(afterIssue).toEqual([STORED]);
    expect(afterDelete).toEqual([STORED]);
    // The property that matters: the delete path cannot drift onto a different
    // credential from the issue path.
    expect(afterDelete).toEqual(afterIssue);
    expect(constructedPats).toEqual([]);
    expect(sentRequests.map((request) => request.via)).toEqual(["installation", "installation"]);
  });

  it("both refuse the PAT when the App is unresolvable", async () => {
    const t = setup();
    vi.stubEnv("GITHUB_APP_ID", "");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "");

    await issueJitFor(t, INSTALLATION_ID);
    await queueDeletion(t, INSTALLATION_ID);
    await t.action(internal.github.drainRunnerDeletions, {});

    expect(constructedApps).toEqual([]);
    expect(constructedPats).toEqual([]);
    expect(sentRequests).toEqual([]);
  });
});
