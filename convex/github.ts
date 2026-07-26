"use node";

import { Octokit } from "octokit";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

export const issueJit = internalAction({
  args: {
    commandId: v.id("commands"),
    jobId: v.id("jobs"),
    repo: v.string(),
    runnerName: v.string(),
    labels: v.array(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    try {
      const token = process.env.GITHUB_PAT;
      if (token === undefined || token.length === 0) {
        throw new Error("GITHUB_PAT is not configured");
      }
      const [owner, repo, extra] = args.repo.split("/");
      if (owner === undefined || repo === undefined || extra !== undefined) {
        throw new Error(`Invalid repository name: ${args.repo}`);
      }

      const octokit = new Octokit({ auth: token });
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
