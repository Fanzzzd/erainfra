"use node";

import { App, Octokit } from "octokit";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

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
        // An App created through the Manifest flow lives in the database;
        // hand-registered Apps still come from environment variables.
        const stored = await ctx.runQuery(internal.githubApp.credentials, {});
        let appId: number;
        let privateKeyValue: string;

        if (stored !== null) {
          appId = stored.appId;
          privateKeyValue = stored.privateKey;
        } else {
          const appIdValue = process.env.GITHUB_APP_ID;
          if (
            appIdValue === undefined ||
            !/^[1-9]\d*$/.test(appIdValue) ||
            !Number.isSafeInteger(Number(appIdValue))
          ) {
            throw new Error("GITHUB_APP_ID must be a positive integer");
          }
          const envPrivateKey = process.env.GITHUB_APP_PRIVATE_KEY;
          if (envPrivateKey === undefined || envPrivateKey.trim().length === 0) {
            throw new Error("GITHUB_APP_PRIVATE_KEY is not configured");
          }
          appId = Number(appIdValue);
          privateKeyValue = envPrivateKey;
        }

        const privateKey = privateKeyValue.includes("\\n")
          ? privateKeyValue.replace(/\\n/g, "\n")
          : privateKeyValue;
        const app = new App({
          appId,
          privateKey,
        });
        octokit = await app.getInstallationOctokit(
          args.githubInstallationId,
        );
      } else {
        const token = process.env.GITHUB_PAT;
        if (token === undefined || token.length === 0) {
          throw new Error("GITHUB_PAT is not configured");
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
      console.error(
        `Failed to issue JIT config for ${args.repo}/${args.runnerName}: ${message}`,
      );
      await ctx.runMutation(internal.scheduler.revertAssignment, {
        commandId: args.commandId,
        jobId: args.jobId,
      });
    }
    return null;
  },
});
