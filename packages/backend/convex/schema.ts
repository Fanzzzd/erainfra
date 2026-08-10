import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  ...authTables,

  // Single-use permission to create exactly one dashboard account. Sign-up is
  // closed unless the caller presents a live grant: `bootstrap` grants are
  // minted by presenting BOOTSTRAP_SECRET while the instance has no users,
  // `invite` grants by an already-authenticated admin. Only the SHA-256 of the
  // token is stored, so the database never holds a usable credential.
  signupGrants: defineTable({
    kind: v.union(v.literal("bootstrap"), v.literal("invite")),
    tokenHash: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
    usedAt: v.optional(v.number()),
    // Which admin issued an invite. Absent for bootstrap grants, which by
    // definition predate every account.
    invitedBy: v.optional(v.id("users")),
  }).index("by_tokenHash", ["tokenHash"]),

  // Failed-bootstrap throttle. At most one row: bootstrap is a single
  // instance-wide event, and Convex mutations cannot see a client address, so
  // the counter is deliberately global rather than per-caller.
  bootstrapThrottle: defineTable({
    failures: v.number(),
    lockedUntil: v.number(),
    updatedAt: v.number(),
  }),

  machines: defineTable({
    name: v.string(),
    os: v.union(v.literal("linux"), v.literal("mac"), v.literal("win")),
    labels: v.array(v.string()),
    arch: v.optional(v.string()),
    cpus: v.optional(v.number()),
    memoryMiB: v.optional(v.number()),
    slotPolicy: v.optional(v.union(v.literal("auto"), v.literal("fixed"))),
    recommendedSlots: v.optional(v.number()),
    maxSlots: v.number(),
    usedSlots: v.number(),
    lastSeen: v.number(),
    token: v.string(),
  }).index("by_token", ["token"]),

  // A Profile is the stable `runs-on` contract workflows target. Controllers
  // publish the exact executor, immutable image, and resource envelope; Workers
  // discover compatible Profiles from here and only advertise them after the
  // image is prepared locally.
  profiles: defineTable({
    name: v.string(),
    scaleSetName: v.string(),
    executor: v.union(
      v.literal("docker"),
      v.literal("firecracker"),
      v.literal("tart"),
      v.literal("hyperv"),
    ),
    imageRelease: v.string(),
    vcpus: v.number(),
    memoryMiB: v.number(),
    minRunners: v.number(),
    maxRunners: v.number(),
    state: v.union(v.literal("active"), v.literal("paused")),
    updatedAt: v.number(),
  }).index("by_name", ["name"]),

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
        runnerName: v.optional(v.string()),
        conclusion: v.optional(v.string()),
      }),
    ),
    attempts: v.number(),
    lastError: v.optional(v.string()),
    settledAt: v.optional(v.number()),
  })
    .index("by_deliveryId", ["deliveryId"])
    .index("by_status", ["status"]),

  // One row per delivery GUID we have asked GitHub to redeliver. Some
  // deliveries can never be accepted — a payload parseWorkflowJob rejects, a
  // signature from a retired secret — and without this row they would be
  // re-requested on every run for the whole window GitHub keeps them.
  //
  // `guid` is GitHub's delivery GUID, which is what it sends as
  // X-GitHub-Delivery and therefore what `webhookDeliveries.deliveryId` holds
  // once a delivery finally lands.
  webhookRecovery: defineTable({
    guid: v.string(),
    // GitHub's numeric id for the failed attempt we asked it to repeat.
    githubDeliveryId: v.number(),
    event: v.string(),
    deliveredAt: v.number(),
    // The status GitHub recorded for that attempt, so an operator can tell a
    // rotated secret (401) from a cold deployment (0 or 5xx).
    statusCode: v.number(),
    // Redelivery requests we made, capped by recovery.MAX_RECOVERY_ATTEMPTS.
    attempts: v.number(),
    firstRequestedAt: v.number(),
    lastRequestedAt: v.number(),
    nextAttemptAt: v.number(),
    state: v.union(v.literal("requested"), v.literal("recovered"), v.literal("abandoned")),
    // Status-code text only; a GitHub response body never reaches this field.
    lastError: v.optional(v.string()),
  })
    .index("by_guid", ["guid"])
    .index("by_state", ["state"]),

  // Singleton run record for the recovery cron: the watermark it scans from and
  // the circuit breaker that stops it from hammering GitHub — or its own
  // deployment — every five minutes when something is broken.
  webhookRecoveryState: defineTable({
    scannedThrough: v.number(),
    lastRunAt: v.number(),
    lastSuccessAt: v.optional(v.number()),
    nextRunAt: v.number(),
    consecutiveFailures: v.number(),
    lastOutcome: v.union(
      v.literal("pending"),
      v.literal("ok"),
      v.literal("skipped-no-app"),
      v.literal("skipped-backoff"),
      v.literal("error"),
    ),
    lastError: v.optional(v.string()),
    // Counters from the most recent completed scan.
    listed: v.number(),
    missing: v.number(),
    requested: v.number(),
  }),

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
    .index("by_jobId", ["jobId"])
    .index("by_runnerName", ["runnerName"]),

  // Scale-set-native execution records. Unlike the legacy `jobs` table, an
  // Attempt exists before GitHub assigns a concrete job: the official listener
  // asks for capacity, Runner Center prepares one ephemeral runner, and a later
  // JobStarted message binds the GitHub metadata to it by runnerName.
  attempts: defineTable({
    profile: v.string(),
    executor: v.union(
      v.literal("docker"),
      v.literal("firecracker"),
      v.literal("tart"),
      v.literal("hyperv"),
    ),
    imageRelease: v.string(),
    vcpus: v.number(),
    memoryMiB: v.number(),
    runnerName: v.string(),
    runnerId: v.number(),
    state: v.union(
      v.literal("pending"),
      v.literal("preparing"),
      v.literal("ready"),
      v.literal("running"),
      v.literal("completed"),
      v.literal("cancelled"),
      v.literal("failed"),
    ),
    machineId: v.optional(v.id("machines")),
    // Single-use secret. It is removed atomically when a Worker claims the
    // Attempt and is never returned by dashboard or controller queries.
    jitConfig: v.optional(v.string()),
    createdAt: v.number(),
    claimedAt: v.optional(v.number()),
    readyAt: v.optional(v.number()),
    startedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
    executorFinishedAt: v.optional(v.number()),
    executorExitCode: v.optional(v.number()),
    // The official client exposes this opaque int64 as zero when GitHub omits
    // it. Persist present values as decimal text so no int64 is rounded by JS.
    runnerRequestId: v.optional(v.union(v.string(), v.number())),
    repo: v.optional(v.string()),
    owner: v.optional(v.string()),
    jobId: v.optional(v.string()),
    workflowRef: v.optional(v.string()),
    displayName: v.optional(v.string()),
    workflowRunId: v.optional(v.number()),
    eventName: v.optional(v.string()),
    queueTime: v.optional(v.number()),
    assignedAt: v.optional(v.number()),
    runnerAssignedAt: v.optional(v.number()),
    result: v.optional(v.string()),
    lastError: v.optional(v.string()),
    cancelReason: v.optional(v.string()),
    // Set when Runner Center settles an Attempt without a GitHub JobCompleted
    // event. Its owning controller retries idempotent runner deletion, then
    // acknowledges this tombstone.
    runnerCleanupPending: v.optional(v.boolean()),
  })
    .index("by_runnerName", ["runnerName"])
    .index("by_profile", ["profile"])
    .index("by_machine_state", ["machineId", "state"]),

  // Operator-authored, non-interactive workloads executed through the same
  // Profile, isolation, readiness and capacity contract as CI Attempts.
  experiments: defineTable({
    name: v.string(),
    profile: v.string(),
    executor: v.literal("firecracker"),
    imageRelease: v.string(),
    vcpus: v.number(),
    memoryMiB: v.number(),
    command: v.array(v.string()),
    timeoutSeconds: v.number(),
    state: v.union(
      v.literal("queued"),
      v.literal("preparing"),
      v.literal("running"),
      v.literal("completed"),
      v.literal("cancelled"),
      v.literal("failed"),
    ),
    machineId: v.optional(v.id("machines")),
    createdBy: v.string(),
    createdAt: v.number(),
    claimedAt: v.optional(v.number()),
    startedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
    exitCode: v.optional(v.number()),
    lastError: v.optional(v.string()),
  })
    .index("by_state", ["state"])
    .index("by_machine_state", ["machineId", "state"]),

  // A Worker is eligible for a Profile only after it has proved the exact
  // executor and immutable Image Release locally. Online heartbeats alone are
  // never enough to advertise capacity.
  //
  // The fields below `lastError` describe what the Worker actually proved:
  // which isolation boundary it enforces, which named prerequisite failed, what
  // hardware and storage it measured, and what — if anything — survives between
  // Jobs. They are optional because rows written by an earlier deployment must
  // keep validating; `boundary` being absent means "not yet reported", which
  // readiness treats as unproven rather than as a guest kernel.
  workerReadiness: defineTable({
    machineId: v.id("machines"),
    profile: v.string(),
    executor: v.union(
      v.literal("docker"),
      v.literal("firecracker"),
      v.literal("tart"),
      v.literal("hyperv"),
    ),
    imageRelease: v.string(),
    state: v.union(v.literal("preparing"), v.literal("ready"), v.literal("failed")),
    checkedAt: v.number(),
    preparedAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    isolation: v.optional(v.string()),
    boundary: v.optional(v.union(v.literal("guest-kernel"), v.literal("shared-kernel"))),
    checks: v.optional(
      v.array(
        v.object({
          name: v.string(),
          passed: v.boolean(),
          detail: v.optional(v.string()),
        }),
      ),
    ),
    // The sharing domain of anything that outlives a Job, and whether two Jobs
    // can write to it. A Profile that promises isolation must report false.
    cacheScope: v.optional(v.string()),
    cacheSharedWritable: v.optional(v.boolean()),
    hardware: v.optional(
      v.object({
        arch: v.optional(v.string()),
        cpus: v.optional(v.number()),
        memoryMiB: v.optional(v.number()),
        cpuModel: v.optional(v.string()),
        virtualization: v.optional(v.string()),
        kvm: v.optional(v.boolean()),
      }),
    ),
    storage: v.optional(
      v.object({
        snapshotter: v.optional(v.string()),
        poolTotalMiB: v.optional(v.number()),
        poolFreeMiB: v.optional(v.number()),
      }),
    ),
    network: v.optional(
      v.object({
        policyName: v.optional(v.string()),
        subnet: v.optional(v.string()),
        egressMode: v.optional(v.string()),
      }),
    ),
  })
    .index("by_machine_profile", ["machineId", "profile"])
    .index("by_profile_state", ["profile", "state"]),

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
