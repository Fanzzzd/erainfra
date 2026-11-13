import { convexTest } from "convex-test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { internal } from "../convex/_generated/api";
import schema from "../convex/schema";

// Which credential `refreshRunnerReleases` reads actions/runner's releases with. A credential only
// lifts the anonymous rate limit, so the order is: the controller's App, then none. This drives the
// real action and records what each GitHub client was constructed with.

type AppOptions = { appId: number | string; privateKey: string };

const constructedApps: AppOptions[] = [];
const anonymousClients: unknown[] = [];
const sentRequests: Array<{ route: string; via: "installation" | "anonymous" | "app" }> = [];

vi.mock("octokit", () => {
  class RequestError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }

  function recordingClient(via: "installation" | "anonymous" | "app") {
    return {
      request: (route: string) => {
        sentRequests.push({ route, via });
        if (route === "GET /app/installations") {
          return Promise.resolve({ data: [{ id: 42 }] });
        }
        return Promise.resolve({
          data: [{ tag_name: "v2.330.0", published_at: "2026-10-01T00:00:00Z" }],
        });
      },
    };
  }

  class Octokit {
    constructor(options?: unknown) {
      anonymousClients.push(options);
    }
    request = recordingClient("anonymous").request;
  }

  class App {
    constructor(options: AppOptions) {
      constructedApps.push(options);
    }
    getInstallationOctokit() {
      return Promise.resolve(recordingClient("installation"));
    }
    octokit = recordingClient("app");
  }

  return { App, Octokit, RequestError };
});

const modules = import.meta.glob("../convex/**/*.ts");

const RELEASES_ROUTE = "GET /repos/{owner}/{repo}/releases";

beforeEach(() => {
  constructedApps.length = 0;
  anonymousClients.length = 0;
  sentRequests.length = 0;
  vi.unstubAllEnvs();
  // Retired credentials left in the environment must not be read.
  vi.stubEnv("GITHUB_PAT", "ghp_retired");
  vi.stubEnv("GITHUB_APP_ID", "4242");
  vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "-----BEGIN RSA PRIVATE KEY-----retired");
});

function setup() {
  return convexTest(schema, modules);
}

function releaseReadVia() {
  return sentRequests.find((request) => request.route === RELEASES_ROUTE)?.via;
}

describe("runner release read credential", () => {
  it("uses the controller's App", async () => {
    const t = setup();
    vi.stubEnv("CONTROLLER_GITHUB_APP_CLIENT_ID", "Iv23.controller");
    vi.stubEnv("CONTROLLER_GITHUB_APP_PRIVATE_KEY", "-----BEGIN RSA PRIVATE KEY-----\\ncontroller");

    await t.action(internal.github.refreshRunnerReleases, {});

    expect(constructedApps).toEqual([
      { appId: "Iv23.controller", privateKey: "-----BEGIN RSA PRIVATE KEY-----\ncontroller" },
    ]);
    expect(releaseReadVia()).toBe("installation");
  });

  it("reads anonymously with no controller App, and never with a retired credential", async () => {
    const t = setup();

    await t.action(internal.github.refreshRunnerReleases, {});

    expect(constructedApps).toEqual([]);
    expect(anonymousClients).toEqual([undefined]);
    expect(releaseReadVia()).toBe("anonymous");
    const row = await t.run(async (ctx) => await ctx.db.query("runnerReleases").first());
    expect(row?.releases.map((release) => release.version)).toEqual(["2.330.0"]);
  });
});
