import { defineTable } from "convex/server";
import { ConvexError, v } from "convex/values";

// The Go agent repeats this allowlist at the execution boundary (agent.Resolve). No raw argv,
// scripts, build-source URLs or caller-provided environment can cross this API. A spec or build
// command names only its deployment (and service); the claimant's payload carries the source,
// built server-side from the deployment row.
export const nodeOperation = v.object({ name: v.string(), args: v.record(v.string(), v.string()) });
export const nodeCommand = v.union(
  v.object({ kind: v.literal("operate"), operation: nodeOperation }),
  // Deploys use the stored App specification; payload/secrets are fetched only by the claimant.
  v.object({
    kind: v.literal("deploy"),
    deploymentId: v.id("appDeployments"),
    operation: v.optional(v.union(v.literal("deploy"), v.literal("failover"))),
  }),
  // Pipeline-only (infra/pipeline.ts): read the spec file out of the deployment's source.
  v.object({ kind: v.literal("spec"), deploymentId: v.id("appDeployments") }),
  // Pipeline-only: build one service of the deployment and push its image.
  v.object({
    kind: v.literal("build"),
    deploymentId: v.id("appDeployments"),
    service: v.string(),
  }),
);
export const commandOutcome = v.union(
  v.literal("success"),
  v.literal("failure"),
  v.literal("unknown"),
);
export const commandStatus = v.union(
  v.literal("pending"),
  v.literal("running"),
  v.literal("success"),
  v.literal("failure"),
  v.literal("unknown"),
  v.literal("cancelled"),
);
export const meshAddress = v.object({
  id: v.string(),
  relay_urls: v.array(v.string()),
  direct_addrs: v.array(v.string()),
});
export const COMMAND_TTL_MS = 60_000;
export const MAX_BODY_BYTES = 256 * 1024;
export const nodeTransportTables = {
  nodeCommands: defineTable({
    nodeId: v.id("nodes"),
    idempotencyKey: v.string(),
    command: nodeCommand,
    app: v.optional(v.string()),
    appEpoch: v.optional(v.number()),
    createdAt: v.number(),
    status: commandStatus,
    unsettled: v.boolean(),
    epoch: v.number(),
    owner: v.optional(v.string()),
    leaseUntil: v.optional(v.number()),
    // Outcomes only. Never stdout, stderr, environment or exception text: those can hold secrets.
    outcome: v.optional(commandOutcome),
    finishedAt: v.optional(v.number()),
    // The pipeline run this command is a step of, so the run finds its steps by index.
    deploymentId: v.optional(v.id("appDeployments")),
    // A spec command's one result: the spec file's text, which comes from the repository and is
    // not secret. Absent with a success outcome means the source has no spec file.
    specText: v.optional(v.string()),
  })
    .index("by_node", ["nodeId"])
    .index("by_deployment", ["deploymentId"])
    .index("by_node_unsettled", ["nodeId", "unsettled"])
    .index("by_node_key", ["nodeId", "idempotencyKey"])
    .index("by_node_status", ["nodeId", "status"]),
  nodeEndpointChallenges: defineTable({
    nodeId: v.id("nodes"),
    credentialId: v.id("nodeCredentials"),
    address: meshAddress,
    message: v.string(),
    expiresAt: v.number(),
  }).index("by_node", ["nodeId"]),
};

export function validateOperation(op: { name: string; args: Record<string, string> }) {
  const specs: Record<string, string[]> = {
    "systemctl.restart": ["unit"],
    "systemctl.start": ["unit"],
    "systemctl.stop": ["unit"],
    "systemctl.status": ["unit"],
    "service.logs": ["unit", "lines"],
    "disk.usage": [],
    "system.hostname": [],
    "container.logs": ["name", "lines"],
    "container.remove": ["name"],
    "container.network.remove": ["name"],
  };
  const allowed = Object.hasOwn(specs, op.name) ? specs[op.name] : undefined;
  if (!allowed) throw new ConvexError("Operation is not allowlisted");
  for (const [key, value] of Object.entries(op.args)) {
    if (!allowed.includes(key) || !value || value.length > 128 || /[;&|<>$`\n\r\\]/.test(value)) {
      throw new ConvexError("Invalid operation argument");
    }
  }
  if (
    allowed.includes("unit") &&
    !/^(portless|erainfra)-[a-z0-9-]+(\.service)?$/.test(op.args.unit ?? "")
  ) {
    throw new ConvexError("Unit is not platform-owned");
  }
  if (allowed.includes("name")) {
    const pattern =
      op.name === "container.network.remove"
        ? /^[a-z0-9][a-z0-9-]{0,62}-net$/
        : /^[a-z0-9][a-z0-9_.-]{0,126}$/;
    if (!pattern.test(op.args.name ?? "")) throw new ConvexError("Invalid container/network name");
  }
  if (op.args.lines !== undefined) {
    const n = Number(op.args.lines);
    const max = op.name === "service.logs" ? 10000 : 1000;
    if (!/^\d+$/.test(op.args.lines) || !Number.isInteger(n) || n < 1 || n > max)
      throw new ConvexError("Invalid line count");
  }
}
