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

  // Credentials produced by the GitHub App Manifest flow. Convex environment
  // variables are read-only at runtime, so the callback cannot write back to
  // `convex env` and stores the App here instead. At most one row exists, and
  // only internal functions read `privateKey` / `webhookSecret`.
  githubApp: defineTable({
    appId: v.number(),
    clientId: v.string(),
    slug: v.string(),
    name: v.string(),
    privateKey: v.string(),
    webhookSecret: v.string(),
    htmlUrl: v.string(),
    createdAt: v.number(),
  }),

  // Single-use CSRF state for the Manifest flow. GitHub redirects to an
  // unauthenticated HTTP route, so this token is what ties the callback back to
  // the dashboard session that asked for it.
  githubAppSetups: defineTable({
    state: v.string(),
    createdAt: v.number(),
    usedAt: v.optional(v.number()),
  }).index("by_state", ["state"]),

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
  })
    .index("by_status", ["status"])
    .index("by_ghJobId", ["ghJobId"]),

  commands: defineTable({
    machineId: v.id("machines"),
    jobId: v.id("jobs"),
    jitConfig: v.optional(v.string()),
    image: v.optional(v.string()),
    runnerName: v.string(),
    status: v.union(v.literal("pending"), v.literal("claimed"), v.literal("finished")),
    exitCode: v.optional(v.number()),
  }).index("by_machine_status", ["machineId", "status"]),
});
