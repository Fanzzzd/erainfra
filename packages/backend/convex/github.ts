"use node";

import { App, Octokit } from "octokit";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { resolveAppCredentials } from "./githubAppConfig";

export const issueJit = internalAction({
  args: {
    commandId: v.id("commands"),
    jobId: v.id("jobs"),
    repo: v.string(),
    githubInstallationId: v.optional(v.number()),
    runnerName: v.string(),
    labels: v.array(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    try {
      const [owner, repo, extra] = args.repo.split("/");
      if (owner === undefined || repo === undefined || extra !== undefined) {
        throw new Error(`Invalid repository name: ${args.repo}`);
      }

      let octokit: Octokit;
      if (args.githubInstallationId !== undefined) {
        // App credentials stored by the Manifest flow outrank the environment;
        // a hand-registered App in GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY is the
        // fallback. Either way this path never downgrades to the PAT: the job
        // arrived through an App installation and must be served as that App.
        const stored = await ctx.runQuery(internal.githubApp.credentials, {});
        const resolved = resolveAppCredentials(stored, {
          appId: process.env.GITHUB_APP_ID,
          privateKey: process.env.GITHUB_APP_PRIVATE_KEY,
        });
        if (!resolved.ok) {
          throw new Error(resolved.error);
        }

        const app = new App({
          appId: resolved.appId,
          privateKey: resolved.privateKey,
        });
        octokit = await app.getInstallationOctokit(args.githubInstallationId);
      } else {
        const token = process.env.GITHUB_PAT;
        if (token === undefined || token.length === 0) {
          throw new Error(
            "This job arrived without a GitHub App installation and GITHUB_PAT is not configured. Connect a GitHub App from the dashboard and install it on this repository, or set GITHUB_PAT for the legacy path.",
          );
        }
        octokit = new Octokit({ auth: token });
      }

      const response = await octokit.request(
        "POST /repos/{owner}/{repo}/actions/runners/generate-jitconfig",
        {
          owner,
          repo,
          name: args.runnerName,
          runner_group_id: 1,
          labels: args.labels,
        },
      );
      const jitConfig = response.data.encoded_jit_config;
      if (typeof jitConfig !== "string" || jitConfig.length === 0) {
        throw new Error("GitHub returned an empty JIT configuration");
      }

      await ctx.runMutation(internal.scheduler.storeJitConfig, {
        commandId: args.commandId,
        jitConfig,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to issue JIT config for ${args.repo}/${args.runnerName}: ${message}`);
      await ctx.runMutation(internal.scheduler.revertAssignment, {
        commandId: args.commandId,
        jobId: args.jobId,
      });
    }
    return null;
  },
});
