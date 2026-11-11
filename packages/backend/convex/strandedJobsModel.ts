// The table behind stranded job recovery (strandedJobs.ts).
//
// An Attempt waiting for a Worker has no repository or workflow run yet: GitHub binds a job to a
// Runner late and names the run only in JobStarted. The controller reports each job it acquires
// (POST /controller/jobs/acquired), and this row keeps that report until the job starts or ends.
// A row without a `stranded` marker is deleted when its job starts or ends. A stranded row stays
// for 30 days, which is how a second stranding of the same run knows it was rerun once already.

import { v } from "convex/values";

export const strandedActionValidator = v.union(v.literal("cancel"), v.literal("rerun"));

export const strandedOutcomeValidator = v.union(
  v.literal("cancelled"),
  v.literal("rerun-requested"),
  v.literal("failed"),
);

export const strandedMarkerValidator = v.object({
  action: strandedActionValidator,
  at: v.number(),
  outcome: v.optional(strandedOutcomeValidator),
  detail: v.optional(v.string()),
});

export const scaleSetJobFields = {
  profile: v.string(),
  // GitHub's runner request id, as a decimal string: it can exceed a JavaScript safe integer.
  runnerRequestId: v.string(),
  repository: v.optional(v.string()),
  owner: v.optional(v.string()),
  jobId: v.optional(v.string()),
  displayName: v.optional(v.string()),
  workflowRunId: v.optional(v.number()),
  queueTime: v.optional(v.number()),
  acquiredAt: v.number(),
  state: v.union(v.literal("waiting"), v.literal("started"), v.literal("completed")),
  stranded: v.optional(strandedMarkerValidator),
};
