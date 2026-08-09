import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  ...authTables,
  machines: defineTable({
    name: v.string(),
    os: v.union(v.literal("linux"), v.literal("mac"), v.literal("win")),
    labels: v.array(v.string()),
    maxSlots: v.number(),
    usedSlots: v.number(),
    lastSeen: v.number(),
    token: v.string(),
  }).index("by_token", ["token"]),

  registrationTokens: defineTable({
    token: v.string(),
    createdAt: v.number(),
    usedAt: v.optional(v.number()),
  }).index("by_token", ["token"]),

  // Durable webhook intake. The HTTP route verifies the signature, records the
  // delivery keyed by X-GitHub-Delivery and returns 2xx immediately; a
  // scheduled mutation does the real work. GitHub never retries a failed
  // delivery, so the row is the only thing standing between a transient error
  // and a permanently lost job.
  webhookDeliveries: defineTable({
    deliveryId: v.string(),
    event: v.string(),
    receivedAt: v.number(),
    status: v.union(
      v.literal("pending"),
      v.literal("processed"),
      v.literal("rejected"),
      v.literal("failed"),
    ),
    // The narrowed workflow_job event, not the raw payload: everything the
    // processor needs, nothing else retained.
    workflowJob: v.optional(
      v.object({
        action: v.union(v.literal("queued"), v.literal("in_progress"), v.literal("completed")),
        ghJobId: v.number(),
        githubInstallationId: v.optional(v.number()),
        repo: v.string(),
        repoIsPublic: v.boolean(),
        workflowName: v.string(),
        labels: v.array(v.string()),
        conclusion: v.optional(v.string()),
      }),
    ),
    attempts: v.number(),
    lastError: v.optional(v.string()),
    settledAt: v.optional(v.number()),
  })
    .index("by_deliveryId", ["deliveryId"])
    .index("by_status", ["status"]),

  jobs: defineTable({
    ghJobId: v.number(),
    githubInstallationId: v.optional(v.number()),
    repo: v.string(),
    workflowName: v.string(),
    labels: v.array(v.string()),
    status: v.union(
      v.literal("queued"),
      v.literal("assigned"),
      v.literal("running"),
      v.literal("done"),
      v.literal("failed"),
    ),
    machineId: v.optional(v.id("machines")),
    runnerName: v.optional(v.string()),
    queuedAt: v.number(),
    startedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
    conclusion: v.optional(v.string()),
    // Provisioning attempt bookkeeping. Optional so rows written by an earlier
    // deployment keep validating; absent means "zero attempts so far".
    attempts: v.optional(v.number()),
    lastError: v.optional(v.string()),
    // Backoff gate: the scheduler skips a queued job until this passes.
    nextAttemptAt: v.optional(v.number()),
    // The machine whose last attempt failed, so a retry prefers another host.
    lastFailedMachineId: v.optional(v.id("machines")),
  })
    .index("by_status", ["status"])
    .index("by_ghJobId", ["ghJobId"]),

  commands: defineTable({
    machineId: v.id("machines"),
    jobId: v.id("jobs"),
    jitConfig: v.optional(v.string()),
    image: v.optional(v.string()),
    runnerName: v.string(),
    // GitHub's id for the JIT runner registration, kept so an abandoned
    // registration can be deleted instead of lingering as an offline runner.
    runnerId: v.optional(v.number()),
    status: v.union(
      v.literal("pending"),
      v.literal("claimed"),
      v.literal("cancelled"),
      v.literal("finished"),
    ),
    claimedAt: v.optional(v.number()),
    cancelledAt: v.optional(v.number()),
    exitCode: v.optional(v.number()),
  })
    .index("by_machine_status", ["machineId", "status"])
    .index("by_jobId", ["jobId"]),

  // Work queue for deleting JIT runner registrations that were created on
  // GitHub but never consumed. Mutations cannot call GitHub, so they enqueue
  // here and an action drains it.
  runnerDeletions: defineTable({
    repo: v.string(),
    githubInstallationId: v.optional(v.number()),
    runnerId: v.number(),
    runnerName: v.string(),
    createdAt: v.number(),
    attempts: v.number(),
    lastError: v.optional(v.string()),
  }).index("by_createdAt", ["createdAt"]),
});
