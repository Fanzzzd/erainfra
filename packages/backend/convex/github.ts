"use node";

import { App, Octokit, RequestError } from "octokit";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, type ActionCtx } from "./_generated/server";
import { resolveAppCredentials } from "./githubAppConfig";
import {
  parseNextCursor,
  PER_PAGE,
  runRecovery,
  type FinishRecoveryRun,
  type RecoveryCandidate,
  type RecoveryClient,
} from "./recovery";

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

/**
 * A client authenticated as the App itself, with a JWT rather than an
 * installation token. Every `/app/hook/*` endpoint requires one: "You must use
 * a JWT to access this endpoint." `@octokit/app` builds `App.octokit` on
 * createAppAuth, so app-level routes are signed automatically.
 *
 * Same credential precedence as `octokitFor`: the record the Manifest flow
 * stored outranks GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY.
 *
 * Returns null instead of throwing when no App is configured. A deployment on
 * the legacy GITHUB_PAT cannot mint a JWT — there is no App to sign as — so
 * that is a capability it does not have, not a failure it should back off from.
 * The private key is read here, handed to `App`, and never returned or logged;
 * `resolveAppCredentials`'s guidance message is for the dashboard, not for a
 * log line repeated every five minutes.
 */
async function appOctokit(ctx: ActionCtx): Promise<Octokit | null> {
  const stored = await ctx.runQuery(internal.githubApp.credentials, {});
  const resolved = resolveAppCredentials(stored, {
    appId: process.env.GITHUB_APP_ID,
    privateKey: process.env.GITHUB_APP_PRIVATE_KEY,
  });
  if (!resolved.ok) {
    return null;
  }
  return new App({ appId: resolved.appId, privateKey: resolved.privateKey }).octokit;
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

/**
 * Ask GitHub to redeliver workflow_job events that never reached this
 * deployment. See recovery.ts for the algorithm and why the delivery GUID makes
 * it safe; this function is only the wiring.
 *
 * Two endpoints are used, both app-scoped and both JWT-authenticated:
 *   GET  /app/hook/deliveries
 *   POST /app/hook/deliveries/{delivery_id}/attempts
 *
 * The third, `GET /app/hook/deliveries/{delivery_id}`, is deliberately never
 * called. It is the only one that returns `request.payload`, `request.headers`
 * (including X-Hub-Signature-256) and `response.payload` — the event body and
 * this deployment's own response to it. The list endpoint returns none of that,
 * so not calling it is what keeps both out of this process and out of the logs.
 */
export const recoverLostDeliveries = internalAction({
  args: {},
  returns: v.object({ listed: v.number(), missing: v.number(), requested: v.number() }),
  handler: async (ctx): Promise<{ listed: number; missing: number; requested: number }> => {
    const openClient = async (): Promise<RecoveryClient | null> => {
      const octokit = await appOctokit(ctx);
      if (octokit === null) {
        return null;
      }
      return {
        listDeliveries: async (cursor) => {
          const response = await octokit.request("GET /app/hook/deliveries", {
            per_page: PER_PAGE,
            ...(cursor === undefined ? {} : { cursor }),
            headers: { "X-GitHub-Api-Version": "2022-11-28" },
          });
          // Cursor pagination: the next page is named in the `link` header, not
          // by a page number.
          const items = response.data.map((delivery) => {
            const id = Number(delivery.id);
            if (!Number.isSafeInteger(id)) {
              throw new Error(`GitHub returned an unsafe delivery id: ${String(delivery.id)}`);
            }
            return {
              id,
              guid: delivery.guid,
              delivered_at: delivery.delivered_at,
              status_code: delivery.status_code,
              event: delivery.event,
            };
          });
          return { items, nextCursor: parseNextCursor(response.headers.link) };
        },
        redeliver: async (githubDeliveryId: number) => {
          await octokit.request("POST /app/hook/deliveries/{delivery_id}/attempts", {
            delivery_id: githubDeliveryId,
            headers: { "X-GitHub-Api-Version": "2022-11-28" },
          });
        },
      };
    };

    const result = await runRecovery({
      now: () => Date.now(),
      reconcile: (now: number) => ctx.runMutation(internal.webhooks.reconcileRecovered, { now }),
      begin: (now: number) => ctx.runMutation(internal.webhooks.beginRecoveryRun, { now }),
      openClient,
      missingGuids: (guids: string[]) => ctx.runQuery(internal.webhooks.missingGuids, { guids }),
      claim: (now: number, candidates: RecoveryCandidate[]) =>
        ctx.runMutation(internal.webhooks.claimRecovery, { now, candidates }),
      settle: async (guid: string, ok: boolean, error?: string) => {
        await ctx.runMutation(internal.webhooks.settleRecovery, { guid, ok, error });
      },
      finish: async (finished: FinishRecoveryRun) => {
        await ctx.runMutation(internal.webhooks.finishRecoveryRun, finished);
      },
    });

    return { listed: result.listed, missing: result.missing, requested: result.requested };
  },
});
