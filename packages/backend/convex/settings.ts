import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireDashboardAuth } from "./dashboardAuth";
import { parseRepositoryPolicy, summarizeRepositoryPolicy } from "./policy";

/**
 * Whether this deployment will accept any work at all.
 *
 * Intake fails closed, so an unset ALLOWED_REPOS silently rejects every
 * workflow_job — the failure looks exactly like "GitHub never delivered
 * anything". The dashboard needs to be able to say so before an operator
 * installs the App and waits for jobs that will never arrive.
 *
 * The allowed patterns are configuration, not credentials, and this query is
 * behind the dashboard login: showing them is the point, because a typo in an
 * owner name is the failure a bare "configured: true" cannot catch.
 */
export const repositoryPolicy = query({
  args: {},
  returns: v.object({
    configured: v.boolean(),
    allowedRepos: v.array(v.string()),
    allowsAllRepos: v.boolean(),
    allowPublicRepos: v.boolean(),
  }),
  handler: async (ctx) => {
    await requireDashboardAuth(ctx);
    return summarizeRepositoryPolicy(parseRepositoryPolicy(process.env));
  },
});
