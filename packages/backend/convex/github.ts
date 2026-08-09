"use node";

import { App, Octokit, RequestError } from "octokit";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, type ActionCtx } from "./_generated/server";
import { resolveAppCredentials } from "./githubAppConfig";

function splitRepo(fullName: string) {
  const [owner, repo, extra] = fullName.split("/");
  if (owner === undefined || repo === undefined || extra !== undefined) {
    throw new Error(`Invalid repository name: ${fullName}`);
  }
  return { owner, repo };
}

/**
 * Installation authentication when the payload carried an installation id,
 * otherwise the legacy classic PAT. A job stored with an installation id never
 * falls back to the PAT.
 *
 * Credential precedence for the App path: the record written by the Manifest
 * flow outranks a hand-registered App in GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY.
 * Every GitHub call goes through here — issuing a JIT config and deleting an
 * abandoned registration alike — so a Manifest-created deployment authenticates
 * the same way on both paths.
 */
async function octokitFor(
  ctx: ActionCtx,
  githubInstallationId: number | undefined,
): Promise<Octokit> {
  if (githubInstallationId !== undefined) {
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
    return await app.getInstallationOctokit(githubInstallationId);
  }

  const token = process.env.GITHUB_PAT;
  if (token === undefined || token.length === 0) {
    throw new Error(
      "This job arrived without a GitHub App installation and GITHUB_PAT is not configured. Connect a GitHub App from the dashboard and install it on this repository, or set GITHUB_PAT for the legacy path.",
    );
  }
  return new Octokit({ auth: token });
}

function describeError(error: unknown) {
  if (error instanceof RequestError) {
    const hint =
      error.status === 403 || error.status === 404
        ? ' — the GitHub App needs the "Administration" repository permission (read and write) to manage runners'
        : "";
    return `GitHub responded ${error.status}: ${error.message}${hint}`;
  }
  return error instanceof Error ? error.message : String(error);
}

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
    let issuedRunnerId: number | undefined;
    try {
      const { owner, repo } = splitRepo(args.repo);
      const octokit = await octokitFor(ctx, args.githubInstallationId);

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
      const runnerId = response.data.runner?.id;
      issuedRunnerId = typeof runnerId === "number" ? runnerId : undefined;

      const stored = await ctx.runMutation(internal.scheduler.storeJitConfig, {
        commandId: args.commandId,
        jitConfig,
        runnerId: issuedRunnerId,
      });
      if (!stored && issuedRunnerId !== undefined) {
        // The command disappeared while GitHub was minting the config, so the
        // registration would otherwise linger as an offline runner forever.
        await ctx.runMutation(internal.runners.enqueue, {
          repo: args.repo,
          githubInstallationId: args.githubInstallationId,
          runnerId: issuedRunnerId,
          runnerName: args.runnerName,
        });
        await ctx.scheduler.runAfter(0, internal.github.drainRunnerDeletions, {});
      }
    } catch (error) {
      const message = describeError(error);
      console.error(`Failed to issue JIT config for ${args.repo}/${args.runnerName}: ${message}`);
      if (issuedRunnerId !== undefined) {
        await ctx.runMutation(internal.runners.enqueue, {
          repo: args.repo,
          githubInstallationId: args.githubInstallationId,
          runnerId: issuedRunnerId,
          runnerName: args.runnerName,
        });
      }
      await ctx.runMutation(internal.scheduler.failAttempt, {
        commandId: args.commandId,
        jobId: args.jobId,
        error: message,
      });
      await ctx.scheduler.runAfter(0, internal.github.drainRunnerDeletions, {});
    }
    return null;
  },
});

const DELETION_BATCH = 20;

/**
 * Delete JIT runner registrations that were created but never consumed.
 * A registration that no longer exists (404) or was never usable (422) counts
 * as done — the goal is only that GitHub stops listing it.
 */
export const drainRunnerDeletions = internalAction({
  args: {},
  returns: v.object({ deleted: v.number(), failed: v.number() }),
  handler: async (ctx): Promise<{ deleted: number; failed: number }> => {
    const pending = await ctx.runMutation(internal.runners.claimDeletions, {
      limit: DELETION_BATCH,
    });

    let deleted = 0;
    let failed = 0;
    for (const deletion of pending) {
      try {
        const { owner, repo } = splitRepo(deletion.repo);
        const octokit = await octokitFor(ctx, deletion.githubInstallationId);
        await octokit.request("DELETE /repos/{owner}/{repo}/actions/runners/{runner_id}", {
          owner,
          repo,
          runner_id: deletion.runnerId,
        });
        await ctx.runMutation(internal.runners.settleDeletion, {
          deletionId: deletion._id,
          ok: true,
        });
        deleted += 1;
      } catch (error) {
        const alreadyGone = error instanceof RequestError && error.status === 404;
        if (alreadyGone) {
          await ctx.runMutation(internal.runners.settleDeletion, {
            deletionId: deletion._id,
            ok: true,
          });
          deleted += 1;
          continue;
        }
        const message = describeError(error);
        console.error(
          `Failed to delete runner ${deletion.runnerName} in ${deletion.repo}: ${message}`,
        );
        await ctx.runMutation(internal.runners.settleDeletion, {
          deletionId: deletion._id,
          ok: false,
          error: message,
        });
        failed += 1;
      }
    }
    return { deleted, failed };
  },
});
