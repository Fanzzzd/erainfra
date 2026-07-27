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

  jobs: defineTable({
    ghJobId: v.number(),
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
    status: v.union(
      v.literal("pending"),
      v.literal("claimed"),
      v.literal("finished"),
    ),
    exitCode: v.optional(v.number()),
  }).index("by_machine_status", ["machineId", "status"]),
});
