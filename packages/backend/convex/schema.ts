import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { attemptMetricSummaryFields, attemptMetricsFields } from "./attemptMetricsModel";
import {
  benchmarkSummaryValidator,
  fitPolicyValidator,
  storedBenchmarkValidator,
} from "./benchmark";
import { alertConditionValidator } from "./alertRules";

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

  // Bearer credentials for the operator API (/api/v1/*) and `GET /metrics`,
  // minted by a signed-in operator in the dashboard. `scope` decides which
  // (apiTokenPolicy.ts). Only the SHA-256 of a token is stored, like
  // signupGrants, so a database export holds nothing a client could present;
  // `hint` is its first characters so the dashboard can tell tokens apart.
  // Several may be live at once, so a token is rotated without a gap. A revoked
  // row is kept, not deleted, so the dashboard still shows what was revoked and
  // when.
  apiTokens: defineTable({
    name: v.string(),
    scope: v.union(v.literal("read"), v.literal("admin"), v.literal("metrics")),
    tokenHash: v.string(),
    hint: v.string(),
    createdBy: v.optional(v.id("users")),
    createdAt: v.number(),
    lastUsedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
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
    configuredSlots: v.optional(v.number()),
    resourceRecommendedSlots: v.optional(v.number()),
    recommendedSlots: v.optional(v.number()),
    // No migration: the next benchmark report writes the compact summary and
    // its evidence row. The legacy full report remains accepted for one Agent
    // refresh cycle so a mixed deployment keeps validating throughout rollout.
    benchmark: v.optional(v.union(benchmarkSummaryValidator, storedBenchmarkValidator)),
    maxSlots: v.number(),
    usedSlots: v.number(),
    lastSeen: v.number(),
    token: v.string(),
  })
    .index("by_name", ["name"])
    .index("by_token", ["token"])
    .index("by_lastSeen", ["lastSeen"])
    .index("by_usedSlots", ["usedSlots"]),

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
    warmPool: v.optional(v.number()),
    fitPolicy: v.optional(fitPolicyValidator),
    minRunners: v.number(),
    maxRunners: v.number(),
    state: v.union(v.literal("active"), v.literal("paused")),
    updatedAt: v.number(),
  })
    .index("by_name", ["name"])
    .index("by_state", ["state"]),

  registrationTokens: defineTable({
    token: v.string(),
    createdAt: v.number(),
    usedAt: v.optional(v.number()),
  })
    .index("by_token", ["token"])
    .index("by_createdAt", ["createdAt"])
    .index("by_usedAt", ["usedAt"]),

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
    .index("by_status", ["status"])
    .index("by_status_receivedAt", ["status", "receivedAt"]),

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
    .index("by_state", ["state"])
    .index("by_state_lastRequestedAt", ["state", "lastRequestedAt"]),

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
    .index("by_status_queuedAt", ["status", "queuedAt"])
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
    .index("by_status", ["status"])
    .index("by_jobId", ["jobId"])
    .index("by_runnerName", ["runnerName"]),

  // Scale-set-native execution records. Unlike the legacy `jobs` table, an
  // Attempt exists before GitHub assigns a concrete job: the official listener
  // asks for capacity, EraInfra prepares one ephemeral runner, and a later
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
    selectionReason: v.optional(v.string()),
    // Legacy-cycle compatibility only. New Attempts put this single-use value
    // in attemptSecrets; claim/terminal paths still tolerate and erase an
    // inline value written immediately before this schema reaches an Agent.
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
    // Set when EraInfra settles an Attempt without a GitHub JobCompleted
    // event. Its owning controller retries idempotent runner deletion, then
    // acknowledges this tombstone.
    runnerCleanupPending: v.optional(v.boolean()),
  })
    .index("by_runnerName", ["runnerName"])
    .index("by_profile", ["profile"])
    .index("by_profile_state", ["profile", "state"])
    .index("by_profile_cleanupPending", ["profile", "runnerCleanupPending"])
    .index("by_state", ["state"])
    .index("by_state_cleanupPending_finishedAt", ["state", "runnerCleanupPending", "finishedAt"])
    // The finishedAt column exists for the Worker poll: it bounds the
    // completed range to the executor-drain window instead of the machine's
    // whole history. Live-state lookups use the (machineId, state) prefix.
    .index("by_machine_state_finishedAt", ["machineId", "state", "finishedAt"]),

  // One bounded resource series per Attempt (at most 360 points per column), replaced whole by
  // every upload from the Worker that ran it. Read only by the Attempt page.
  attemptMetrics: defineTable(attemptMetricsFields).index("by_attempt", ["attemptId"]),

  // The series' summary and upload bookkeeping, small enough for the Runs page to read one per
  // listed Attempt. by_updatedAt drives the 14-day retention purge.
  attemptMetricSummaries: defineTable(attemptMetricSummaryFields)
    .index("by_attempt", ["attemptId"])
    .index("by_updatedAt", ["updatedAt"]),

  // Credentials are deliberately absent from every scheduler/reconcile scan.
  // A Worker point-reads this row exactly once while claiming its Attempt.
  attemptSecrets: defineTable({
    attemptId: v.id("attempts"),
    jitConfig: v.string(),
    createdAt: v.number(),
  })
    .index("by_attempt", ["attemptId"])
    .index("by_createdAt", ["createdAt"]),

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
    selectionReason: v.optional(v.string()),
    createdBy: v.string(),
    createdAt: v.number(),
    claimedAt: v.optional(v.number()),
    startedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
    exitCode: v.optional(v.number()),
    lastError: v.optional(v.string()),
  })
    .index("by_state", ["state"])
    .index("by_state_finishedAt", ["state", "finishedAt"])
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
    vcpus: v.optional(v.number()),
    memoryMiB: v.optional(v.number()),
    state: v.union(
      v.literal("preparing"),
      v.literal("ready"),
      v.literal("degraded"),
      v.literal("failed"),
    ),
    checkedAt: v.number(),
    preparedAt: v.optional(v.number()),
    warmPool: v.optional(v.object({ target: v.number(), parked: v.number(), claimed: v.number() })),
    // No migration: these optional evidence fields stay in the validator for
    // one Agent refresh cycle. reportReadiness writes the new evidence row and
    // removes them from this hot row on the Worker's next report.
    statusDetail: v.optional(v.string()),
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
        poolName: v.optional(v.string()),
        poolTotalMiB: v.optional(v.number()),
        poolFreeMiB: v.optional(v.number()),
      }),
    ),
    network: v.optional(
      v.object({
        policyName: v.optional(v.string()),
        policyHash: v.optional(v.string()),
        subnet: v.optional(v.string()),
        egressMode: v.optional(v.string()),
      }),
    ),
  })
    .index("by_machine_profile", ["machineId", "profile"])
    .index("by_profile_state", ["profile", "state"]),

  readinessEvidence: defineTable({
    machineId: v.id("machines"),
    profile: v.string(),
    executor: v.union(
      v.literal("docker"),
      v.literal("firecracker"),
      v.literal("tart"),
      v.literal("hyperv"),
    ),
    imageRelease: v.string(),
    vcpus: v.optional(v.number()),
    memoryMiB: v.optional(v.number()),
    checkedAt: v.number(),
    warmPool: v.optional(v.object({ target: v.number(), parked: v.number(), claimed: v.number() })),
    statusDetail: v.optional(v.string()),
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
        poolName: v.optional(v.string()),
        poolTotalMiB: v.optional(v.number()),
        poolFreeMiB: v.optional(v.number()),
      }),
    ),
    network: v.optional(
      v.object({
        policyName: v.optional(v.string()),
        policyHash: v.optional(v.string()),
        subnet: v.optional(v.string()),
        egressMode: v.optional(v.string()),
      }),
    ),
  }).index("by_machine_profile", ["machineId", "profile"]),

  benchmarkEvidence: defineTable({
    machineId: v.id("machines"),
    benchmark: storedBenchmarkValidator,
  }).index("by_machine", ["machineId"]),

  // Where alert notifications go. The URL and signing secret are write-only: dashboard queries
  // return `urlHint`, never `url` or `signingSecret`. A Slack incoming-webhook URL is itself the
  // credential, which is why the URL is treated as a secret for every destination kind.
  alertDestinations: defineTable({
    name: v.string(),
    kind: v.union(v.literal("webhook"), v.literal("slack")),
    url: v.string(),
    urlHint: v.string(),
    // HMAC-SHA256 key for generic webhooks, generated here and shown once. Stored raw because
    // signing needs it; only the delivery action reads it.
    signingSecret: v.optional(v.string()),
    enabled: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }),

  // Operator-authored alert rules, evaluated every minute by the alert cron.
  alertRules: defineTable({
    name: v.string(),
    condition: alertConditionValidator,
    // Limit the rule to one Profile. Absent means every Profile (and every Worker, for
    // worker-offline).
    profile: v.optional(v.string()),
    // How long the condition must hold before the incident fires, like Prometheus `for:`.
    forMinutes: v.number(),
    // Minimum gap between firing notifications for the same rule and subject.
    cooldownMinutes: v.number(),
    mutedUntil: v.optional(v.number()),
    destinationIds: v.array(v.id("alertDestinations")),
    enabled: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_enabled", ["enabled"]),

  // One row per time a rule's condition held for a subject (a Worker, a Profile, or a
  // Profile/Worker pair). At most one pending or firing row exists per rule and subject; that is
  // the dedup key. Resolved rows are kept for 30 days so cooldown and history can read them.
  alertIncidents: defineTable({
    ruleId: v.id("alertRules"),
    subject: v.string(),
    status: v.union(v.literal("pending"), v.literal("firing"), v.literal("resolved")),
    summary: v.string(),
    // When the condition was first observed for this incident.
    since: v.number(),
    firedAt: v.optional(v.number()),
    resolvedAt: v.optional(v.number()),
    // Set when a firing notification was enqueued. Absent while muted or cooling down; a resolve
    // is only announced for an incident whose firing was.
    firingNotifiedAt: v.optional(v.number()),
    lastEvaluatedAt: v.number(),
  })
    .index("by_rule_status", ["ruleId", "status"])
    .index("by_rule_subject", ["ruleId", "subject"])
    .index("by_status_resolvedAt", ["status", "resolvedAt"]),

  // Outbound notifications. The evaluator only inserts a row and schedules the delivery action,
  // so a slow or failing receiver never holds up a mutation. `body` is built once, so every retry
  // sends the same bytes; the signature is computed per attempt because it covers a timestamp.
  alertDeliveries: defineTable({
    destinationId: v.id("alertDestinations"),
    incidentId: v.optional(v.id("alertIncidents")),
    event: v.union(v.literal("firing"), v.literal("resolved"), v.literal("test")),
    body: v.string(),
    status: v.union(v.literal("pending"), v.literal("delivered"), v.literal("failed")),
    attempts: v.number(),
    createdAt: v.number(),
    nextAttemptAt: v.optional(v.number()),
    deliveredAt: v.optional(v.number()),
    lastStatusCode: v.optional(v.number()),
    lastError: v.optional(v.string()),
  })
    .index("by_destination", ["destinationId"])
    .index("by_status_createdAt", ["status", "createdAt"]),

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
