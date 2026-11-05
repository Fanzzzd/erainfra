// The infrastructure-management state ADR 0016 moves out of the Hub's portless.db. Each table
// names the Hub table it replaces; where the Hub kept a JSON document per row, the fields are
// typed here so a malformed row is refused at write time rather than at deploy time.
//
// Nodes are referenced by `Id<"nodes">` everywhere, never by name, so a Node's identity can move
// from the Hub's self-declared agent id to its iroh EndpointId without rewriting any other table.
import { defineTable } from "convex/server";
import { v } from "convex/values";

export const permissionRoleValidator = v.union(
  v.literal("owner"),
  v.literal("admin"),
  v.literal("operator"),
  v.literal("viewer"),
);

export const deployStageValidator = v.union(
  v.literal("queued"),
  v.literal("reading-spec"),
  v.literal("planning"),
  v.literal("building"),
  v.literal("deploying"),
  v.literal("linking"),
  v.literal("done"),
  v.literal("failed"),
);

export const auditOutcomeValidator = v.union(
  v.literal("allow"),
  v.literal("deny"),
  v.literal("success"),
  v.literal("failure"),
  v.literal("attempt"),
);

/**
 * Placement roles (CONTEXT.md): which capability a Node carries for the Apps deployed onto it.
 * Only `gateway` changes what Convex sends a Node today (infra/ingress.ts).
 */
export const placementRoleValidator = v.union(
  v.literal("gateway"),
  v.literal("compute"),
  v.literal("database"),
  v.literal("relay"),
);

/** What phase 1's `erainfra-mesh` publishes so peers can dial a Node without n0's discovery. */
export const endpointAddrValidator = v.object({
  relayUrl: v.optional(v.string()),
  directAddresses: v.array(v.string()),
});

export const appServiceValidator = v.object({
  // DNS name on the App's network, e.g. "web" or "db".
  name: v.string(),
  // Registry image reference, so failover redeploys without a rebuild.
  image: v.string(),
  args: v.array(v.string()),
  // Loopback host port for the data plane; set together with `route`.
  port: v.optional(v.number()),
  // External hostname label; absent means internal only.
  route: v.optional(v.string()),
  // Absent means the App's primary Node.
  nodeId: v.optional(v.id("nodes")),
  // Plain environment only (PORT, injected needs, spec env). Secrets live in appSecrets and are
  // never copied here.
  env: v.optional(v.record(v.string(), v.string())),
});

export const appLinkValidator = v.object({
  name: v.string(),
  need: v.string(),
  providerNodeId: v.id("nodes"),
  providerPort: v.number(),
  consumerNodeId: v.id("nodes"),
  localPort: v.number(),
});

/** A validated App spec (infra/spec.ts), stored so failover can re-plan without the source. */
export const specServiceValidator = v.object({
  name: v.string(),
  build: v.optional(v.string()),
  image: v.optional(v.string()),
  port: v.optional(v.number()),
  route: v.optional(v.string()),
  env: v.record(v.string(), v.string()),
  volumes: v.array(v.string()),
  node: v.optional(v.string()),
  needs: v.array(v.string()),
});
export const appSpecValidator = v.object({
  app: v.string(),
  services: v.array(specServiceValidator),
});

/**
 * Where a pipeline run's source comes from. An upload is a Convex file-storage object the operator
 * uploaded through /api/v1, deleted when the run ends. A repository source names the repository,
 * the branch and, for a push, the exact commit.
 */
export const deploySourceValidator = v.union(
  v.object({ kind: v.literal("upload"), storageId: v.id("_storage") }),
  v.object({
    kind: v.literal("git"),
    repo: v.string(),
    ref: v.string(),
    sha: v.optional(v.string()),
  }),
);

/** What the planning step decided: every service with its Node, the links, and what to build. */
export const deployPlanValidator = v.object({
  nodeId: v.id("nodes"),
  services: v.array(appServiceValidator),
  links: v.array(appLinkValidator),
  builds: v.array(v.object({ service: v.string(), dir: v.string(), image: v.string() })),
  // The Nodes whose services this run (re)starts. Failover leaves untouched groups alone.
  deployNodeIds: v.array(v.id("nodes")),
  urls: v.array(v.string()),
});

export const infraTables = {
  // A machine that runs deployed Apps (CONTEXT.md). `name` is the agent id the Hub knew it by;
  // `endpointId` is the iroh key phase 1 gives it, which becomes its identity once registered.
  nodes: defineTable({
    name: v.string(),
    createdAt: v.number(),
    source: v.union(v.literal("enrolled"), v.literal("hub-import")),
    endpointId: v.optional(v.string()),
    endpointAddr: v.optional(endpointAddrValidator),
    endpointUpdatedAt: v.optional(v.number()),
    // Canonical #181 PeerSpec, accepted only after an Ed25519 possession challenge.
    meshAddress: v.optional(
      v.object({
        id: v.string(),
        relay_urls: v.array(v.string()),
        direct_addrs: v.array(v.string()),
      }),
    ),
    endpointProvenAt: v.optional(v.number()),
    lastSeenAt: v.optional(v.number()),
    infraAgentVersion: v.optional(v.string()),
    // Failover bookkeeping (infra/failover.ts). `failoverSuspectAt` is when a check first found the
    // Node silent past the missed-heartbeat window; `failoverHandledSeenAt` is the `lastSeenAt` of
    // the silence a failover already ran for, so one outage fails over once.
    failoverSuspectAt: v.optional(v.number()),
    failoverHandledSeenAt: v.optional(v.number()),
    // Set by an owner or admin (nodes.setPlacementRoles), never by the Node: a gateway is granted
    // a mesh path to every routed App, so a Node must not be able to promote itself.
    placementRoles: v.optional(v.array(placementRoleValidator)),
  })
    .index("by_name", ["name"])
    .index("by_endpointId", ["endpointId"]),

  // Per-Node enrollment credentials, replacing the shared `operator` token every Node held on the
  // Hub. Hashed like apiTokens; several may be live at once so a credential rotates without a gap,
  // and each is bound to exactly one Node.
  nodeCredentials: defineTable({
    nodeId: v.id("nodes"),
    tokenHash: v.string(),
    hint: v.string(),
    createdBy: v.optional(v.id("users")),
    createdAt: v.number(),
    lastUsedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
  })
    .index("by_tokenHash", ["tokenHash"])
    .index("by_node", ["nodeId"]),

  // Hub `apps`: a multi-service App and where it runs.
  apps: defineTable({
    name: v.string(),
    nodeId: v.id("nodes"),
    services: v.array(appServiceValidator),
    links: v.array(appLinkValidator),
    // The spec the last pipeline run deployed. Failover re-plans from it; an App without one (copied
    // from the Hub) must go through the pipeline once before Convex can fail it over.
    spec: v.optional(appSpecValidator),
    updatedAt: v.number(),
  })
    .index("by_name", ["name"])
    .index("by_node", ["nodeId"]),

  // Hub `routes`: a public hostname label and the Node, image and port serving it.
  appRoutes: defineTable({
    name: v.string(),
    nodeId: v.id("nodes"),
    image: v.string(),
    port: v.number(),
    updatedAt: v.number(),
  })
    .index("by_name", ["name"])
    .index("by_node", ["nodeId"]),

  // Hub `links`: a standalone "reach provider:port from consumer" link, independent of any App.
  meshLinks: defineTable({
    name: v.string(),
    providerNodeId: v.id("nodes"),
    providerPort: v.number(),
    consumerNodeId: v.id("nodes"),
    localPort: v.number(),
    createdBy: v.optional(v.union(v.literal("user"), v.literal("deploy"))),
    updatedAt: v.number(),
  }).index("by_name", ["name"]),

  // Hub `ports`. One row per (Node, key), and by construction one row per (Node, port): every
  // insert goes through infra/ports.ts, which checks both indexes in the same transaction.
  portAllocations: defineTable({
    nodeId: v.id("nodes"),
    key: v.string(),
    port: v.number(),
    // The `<app>` prefix of `key`, so removing an App frees its ports on every Node.
    app: v.optional(v.string()),
    allocatedAt: v.number(),
  })
    .index("by_node_key", ["nodeId", "key"])
    .index("by_node_port", ["nodeId", "port"])
    .index("by_app", ["app"]),

  // Envelope encryption for App secrets: one random data key per secret scope, stored wrapped by
  // the deployment master key (ERAINFRA_SECRETS_MASTER_KEY). `masterKeyId` names which master key
  // wrapped it, so a wrong or rotated key fails with a message instead of a GCM error. A scope is
  // (app, service): `service` absent is the App-wide scope every service of the App receives.
  appDataKeys: defineTable({
    app: v.string(),
    service: v.optional(v.string()),
    wrappedKey: v.string(),
    iv: v.string(),
    masterKeyId: v.string(),
    createdAt: v.number(),
  }).index("by_app_service", ["app", "service"]),

  // Hub `secrets`, with the Hub's `<app>-<service>` scope string split into its two names, because
  // both may contain `-` and the joined form named two scopes at once. `ciphertext` is AES-256-GCM
  // under the scope's data key, bound to (app, service, name) as associated data so a row copied
  // onto another name or scope does not decrypt.
  appSecrets: defineTable({
    app: v.string(),
    service: v.optional(v.string()),
    name: v.string(),
    ciphertext: v.string(),
    iv: v.string(),
    updatedAt: v.number(),
  }).index("by_app_service_name", ["app", "service", "name"]),

  // Hub `git_bindings`: push-to-deploy for one repository branch. (repoKey, branch) is unique.
  gitBindings: defineTable({
    repo: v.string(),
    repoKey: v.string(),
    branch: v.string(),
    app: v.string(),
    buildNodeId: v.optional(v.id("nodes")),
    deployNodeId: v.optional(v.id("nodes")),
    port: v.optional(v.number()),
    lastStatus: v.optional(
      v.object({
        at: v.number(),
        sha: v.string(),
        ok: v.boolean(),
        stage: v.string(),
        error: v.optional(v.string()),
      }),
    ),
    createdAt: v.number(),
    legacyId: v.optional(v.string()),
  })
    .index("by_repoKey_branch", ["repoKey", "branch"])
    .index("by_legacyId", ["legacyId"]),

  // Hub `deployments`: progress and history of one deploy pipeline run. The newest
  // DEPLOYMENTS_KEPT are kept.
  appDeployments: defineTable({
    app: v.string(),
    stage: deployStageValidator,
    detail: v.string(),
    urls: v.array(v.string()),
    error: v.optional(v.string()),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
    // The Nodes this run deploys to: the only Nodes that may read the App's secrets for it.
    targetNodeIds: v.array(v.id("nodes")),
    // The App lease epoch this run holds while it is not terminal. Every stage write is fenced on it.
    leaseEpoch: v.optional(v.number()),
    trigger: v.optional(
      v.object({
        kind: v.union(
          v.literal("git"),
          v.literal("upload"),
          v.literal("manual"),
          v.literal("hub-import"),
          v.literal("failover"),
        ),
        sha: v.optional(v.string()),
        deliveryId: v.optional(v.string()),
        actor: v.optional(v.string()),
      }),
    ),
    legacyId: v.optional(v.string()),
    // Pipeline runs (infra/pipeline.ts). A row without `operation` predates the pipeline or was
    // copied from the Hub, and the pipeline never touches it.
    operation: v.optional(v.union(v.literal("deploy"), v.literal("failover"))),
    source: v.optional(deploySourceValidator),
    sourceDeleted: v.optional(v.boolean()),
    buildNodeId: v.optional(v.id("nodes")),
    defaultNodeId: v.optional(v.id("nodes")),
    // Container port for a repository with no spec file.
    port: v.optional(v.number()),
    spec: v.optional(appSpecValidator),
    plan: v.optional(deployPlanValidator),
    // When the current stage began, for its timeout.
    stageStartedAt: v.optional(v.number()),
    gitBindingId: v.optional(v.id("gitBindings")),
    // Failover runs: the Node the App is moving off, and the survivor chosen when it was queued.
    failover: v.optional(v.object({ lostNodeId: v.id("nodes"), toNodeId: v.id("nodes") })),
  })
    .index("by_startedAt", ["startedAt"])
    .index("by_app_startedAt", ["app", "startedAt"])
    .index("by_stage", ["stage"])
    .index("by_legacyId", ["legacyId"]),

  // One lease per App, the ADR 0014 controller pattern applied to deploy/failover coordination.
  // A stale holder's fenced Convex writes are refused. External runtime side effects still need
  // runtime-side epoch checks and stable operation/step idempotency keys (leases.ts).
  appLeases: defineTable({
    app: v.string(),
    holder: v.optional(v.string()),
    operation: v.optional(v.union(v.literal("deploy"), v.literal("failover"))),
    epoch: v.number(),
    expiresAt: v.number(),
    acquiredAt: v.number(),
  }).index("by_app", ["app"]),

  // Hub `audit`. `seq` is a total order taken from the `auditSeq` counter in the same transaction
  // as the insert, so it increases strictly with commit order. `hubSeq` is the row's sequence
  // number on the Hub, for rows the importer copied.
  auditEvents: defineTable({
    seq: v.number(),
    at: v.number(),
    actor: v.string(),
    action: v.string(),
    target: v.optional(v.string()),
    outcome: auditOutcomeValidator,
    dryRun: v.optional(v.boolean()),
    // JSON text: the Hub's meta is free-form, and Convex field names are not.
    metaJson: v.optional(v.string()),
    hubSeq: v.optional(v.number()),
  })
    .index("by_seq", ["seq"])
    .index("by_hubSeq", ["hubSeq"]),

  // Named counters: `auditSeq` (last audit sequence issued), `deployments` (rows retained in
  // appDeployments) and `hubAuditImportedThrough` (highest Hub audit seq imported). One row each,
  // so an audit append and a deploy never contend on the same document.
  infraCounters: defineTable({
    name: v.string(),
    value: v.number(),
  }).index("by_name", ["name"]),
};
