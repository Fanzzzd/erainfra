"use node";

import { v } from "convex/values";
import { App, Octokit, RequestError } from "octokit";

import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { controllerApp, normalizePrivateKey } from "./controllerGithubToken";
import { parseRunnerReleases, RUNNER_RELEASE_PAGE } from "./runnerReleaseModel";

/**
 * A client for reading a public repository: an installation token of the controller's App
 * (controllerGithubToken.ts) when this deployment holds one, else none. A token only lifts the
 * anonymous limit of 60 requests an hour, which other tenants on Convex's shared egress addresses
 * may already have spent.
 */
async function publicReadOctokit(): Promise<Octokit> {
  const controller = controllerApp(process.env);
  if (controller === null) return new Octokit();
  try {
    const app = new App({
      appId: controller.clientId,
      privateKey: normalizePrivateKey(controller.privateKey),
    });
    const installations = await app.octokit.request("GET /app/installations", { per_page: 1 });
    const installation = installations.data[0];
    if (installation !== undefined) return await app.getInstallationOctokit(installation.id);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`Reading the actions/runner releases without an App's token: ${reason}`);
  }
  return new Octokit();
}

/**
 * Refresh the actions/runner release list the runner-release-expiring alert reads
 * (runnerReleases.ts). The cron runs hourly and this asks GitHub only once the list is six hours
 * old, so a failed fetch is retried within the hour and the steady state is four requests a day.
 * A failure keeps the last good list.
 */
export const refreshRunnerReleases = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    const now = Date.now();
    if (!(await ctx.runQuery(internal.runnerReleases.refreshDue, { now }))) return null;
    try {
      const octokit = await publicReadOctokit();
      const response = await octokit.request("GET /repos/{owner}/{repo}/releases", {
        owner: "actions",
        repo: "runner",
        per_page: RUNNER_RELEASE_PAGE,
        headers: { "X-GitHub-Api-Version": "2022-11-28" },
        request: { signal: AbortSignal.timeout(30_000) },
      });
      const releases = parseRunnerReleases(response.data);
      if (releases.length === 0) throw new Error("GitHub listed no actions/runner release");
      await ctx.runMutation(internal.runnerReleases.record, { attemptedAt: now, releases });
    } catch (error) {
      const message =
        error instanceof RequestError
          ? `GitHub responded ${error.status}: ${error.message}`
          : error instanceof Error
            ? error.message
            : String(error);
      console.error(`Could not refresh the actions/runner release list: ${message}`);
      await ctx.runMutation(internal.runnerReleases.record, { attemptedAt: now, error: message });
    }
    return null;
  },
});
