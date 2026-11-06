import { describe, expect, it } from "vitest";
import type { Id } from "../convex/_generated/dataModel";
import {
  ALERT_CONDITION_KINDS,
  conditionError,
  evaluateCondition,
  type AlertCondition,
} from "../convex/alertRules";
import {
  classifyResponse,
  deliveryBackoffMs,
  destinationUrlError,
  signWebhook,
  slackBody,
  urlHint,
  webhookBody,
  type NotificationContent,
} from "../convex/alertNotify";
import { controllerLiveness, type ControllerHeartbeatRow } from "../convex/controllerLiveness";
import type {
  FinishedAttempt,
  FleetObservation,
  ObservedMachine,
  ObservedNode,
  ObservedProfile,
} from "../convex/fleetObservation";

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const MINUTE = 60_000;

function machine(name: string, lastSeen: number): ObservedMachine {
  return {
    id: `machine-${name}` as Id<"machines">,
    name,
    os: "linux",
    slotPolicy: "auto",
    maxSlots: 2,
    usedSlots: 0,
    lastSeen,
    online: lastSeen > 0 && NOW - lastSeen < 2 * MINUTE,
  };
}

function profile(name: string, fields: Partial<ObservedProfile> = {}): ObservedProfile {
  return {
    name,
    executor: "firecracker",
    state: "active",
    minRunners: 0,
    maxRunners: 4,
    workerLabels: [],
    labelConflicts: [],
    workers: [],
    liveAttempts: { pending: 0, preparing: 0, ready: 0, running: 0 },
    liveAttemptsTruncated: false,
    running: [],
    recentFinished: [],
    recentTruncated: false,
    controller: { status: "unknown", live: 0, controllers: [] },
    ...fields,
  };
}

function heartbeat(
  hostname: string,
  sessionState: ControllerHeartbeatRow["sessionState"],
  minutesAgo: number,
  fields: Partial<ControllerHeartbeatRow> = {},
): ControllerHeartbeatRow {
  const receivedAt = NOW - minutesAgo * MINUTE;
  return {
    hostname,
    version: "0.2.0-rc.11",
    sessionState,
    receivedAt,
    firstSeenAt: NOW - 24 * 60 * MINUTE,
    ...(sessionState === "listening" ? { lastListeningAt: receivedAt } : {}),
    assignedJobs: 0,
    runningJobs: 0,
    tokenSlot: "current",
    ...fields,
  };
}

function withControllers(
  name: string,
  rows: ControllerHeartbeatRow[],
  fields: Partial<ObservedProfile> = {},
) {
  return profile(name, { controller: controllerLiveness(rows, NOW), ...fields });
}

function worker(
  machineName: string,
  state: ObservedProfile["workers"][number]["state"],
  schedulable = state === "ready",
  detail?: string,
) {
  return {
    machineId: `machine-${machineName}` as Id<"machines">,
    machineName,
    state,
    schedulable,
    ...(detail === undefined ? {} : { detail }),
  };
}

function finished(outcome: FinishedAttempt["outcome"], minutesAgo: number): FinishedAttempt {
  return { outcome, finishedAt: NOW - minutesAgo * MINUTE, queueWaitMs: null, runDurationMs: null };
}

function fleet(
  profiles: ObservedProfile[],
  machines: ObservedMachine[] = [],
  nodes: ObservedNode[] = [],
): FleetObservation {
  return {
    now: NOW,
    recentWindowMs: 24 * 60 * MINUTE,
    profiles,
    machines,
    nodes,
    dimensionsTruncated: false,
  };
}

function node(name: string, fields: Partial<ObservedNode> = {}): ObservedNode {
  return { name, online: true, lastSeenAt: NOW - 10_000, ...fields };
}

function subjects(condition: AlertCondition, observation: FleetObservation, scope?: string) {
  return evaluateCondition(condition, scope, observation).map((breach) => breach.subject);
}

describe("evaluateCondition", () => {
  it("worker-offline: silent past the threshold, never-connected Workers excluded", () => {
    const observation = fleet(
      [profile("a", { workers: [worker("w1", "ready")] })],
      [
        machine("w1", NOW - 11 * MINUTE),
        machine("w2", NOW - 9 * MINUTE),
        machine("w3", NOW - 60 * MINUTE),
        machine("fresh", 0),
      ],
    );
    expect(subjects({ kind: "worker-offline", minutes: 10 }, observation)).toEqual(["w1", "w3"]);
    // Scoped to a Profile, only that Profile's Workers count.
    expect(subjects({ kind: "worker-offline", minutes: 10 }, observation, "a")).toEqual(["w1"]);
    const [breach] = evaluateCondition({ kind: "worker-offline", minutes: 10 }, "a", observation);
    expect(breach?.summary).toBe("Worker w1 has not sent a heartbeat for 11m.");
  });

  it("profile-no-ready-worker: active Profiles only, and only when nothing is schedulable", () => {
    const observation = fleet([
      profile("empty"),
      profile("broken", { workers: [worker("w1", "degraded"), worker("w2", "ready", false)] }),
      profile("fine", { workers: [worker("w3", "ready")] }),
      profile("paused", { state: "paused" }),
    ]);
    expect(subjects({ kind: "profile-no-ready-worker" }, observation)).toEqual(["empty", "broken"]);
    const breaches = evaluateCondition({ kind: "profile-no-ready-worker" }, undefined, observation);
    expect(breaches[1]?.summary).toBe(
      "Profile broken has no schedulable Worker (w1 degraded, w2 ready).",
    );
    expect(subjects({ kind: "profile-no-ready-worker" }, observation, "fine")).toEqual([]);
  });

  it("profile-no-ready-worker: names the pin, and why a ready Worker does not count", () => {
    const lacks = "this Worker lacks the host label gpu the Profile is pinned to";
    const observation = fleet([
      profile("gpu", {
        workerLabels: ["gpu"],
        workers: [worker("w1", "ready", false, lacks), worker("w2", "degraded", false)],
      }),
      profile("gpu-nvme", { workerLabels: ["gpu", "nvme"] }),
    ]);
    const breaches = evaluateCondition({ kind: "profile-no-ready-worker" }, undefined, observation);
    expect(breaches.map((breach) => breach.summary)).toEqual([
      `Profile gpu has no schedulable Worker (w1 ready: ${lacks}; w2 degraded). It is pinned to the host label gpu; only Workers carrying it count.`,
      "Profile gpu-nvme has no Worker reporting readiness for its current Image Release. It is pinned to the host labels gpu, nvme; only Workers carrying every one count.",
    ]);
  });

  it("profile-label-conflict: each active Profile in a conflicting pair", () => {
    const reason =
      "scale-set label plain is Profile plain's name; its jobs could run on this Profile instead (ADR 0017)";
    const observation = fleet([
      profile("gpu", { labelConflicts: [reason] }),
      profile("plain", { labelConflicts: ["Profile gpu's scale set also answers to plain"] }),
      profile("alone"),
    ]);
    expect(subjects({ kind: "profile-label-conflict" }, observation)).toEqual(["gpu", "plain"]);
    expect(subjects({ kind: "profile-label-conflict" }, observation, "alone")).toEqual([]);
    expect(
      evaluateCondition({ kind: "profile-label-conflict" }, "gpu", observation)[0]?.summary,
    ).toBe(
      `Profile gpu shares scale-set labels with another active Profile, so GitHub can run either one's jobs on the other: ${reason}. Give one of them labels that do not include the other's name.`,
    );
  });

  it("profile-readiness-degraded: one subject per Profile and Worker", () => {
    const observation = fleet([
      profile("a", {
        workers: [
          worker("w1", "degraded", false, "thin pool full"),
          worker("w2", "failed", false),
          worker("w3", "ready"),
          worker("w4", "preparing", false),
        ],
      }),
    ]);
    const breaches = evaluateCondition(
      { kind: "profile-readiness-degraded" },
      undefined,
      observation,
    );
    expect(breaches.map((breach) => breach.subject)).toEqual(["a/w1", "a/w2"]);
    expect(breaches[0]?.summary).toBe(
      "Worker w1 reports degraded readiness for Profile a: thin pool full",
    );
  });

  it("queue-backlog: the oldest pending Attempt against the threshold", () => {
    const observation = fleet([
      profile("slow", {
        liveAttempts: { pending: 3, preparing: 0, ready: 0, running: 0 },
        oldestPendingCreatedAt: NOW - 16 * MINUTE,
      }),
      profile("quick", {
        liveAttempts: { pending: 1, preparing: 0, ready: 0, running: 0 },
        oldestPendingCreatedAt: NOW - 2 * MINUTE,
      }),
      profile("idle"),
    ]);
    const breaches = evaluateCondition(
      { kind: "queue-backlog", minutes: 15 },
      undefined,
      observation,
    );
    expect(breaches).toEqual([
      {
        subject: "slow",
        summary: "3 Attempts queued on Profile slow; the oldest has waited 16m.",
      },
    ]);
  });

  it("failure-rate: needs the minimum sample, ignores cancellations and old Attempts", () => {
    const failing = profile("a", {
      recentFinished: [
        finished("failed", 1),
        finished("failed", 2),
        finished("succeeded", 3),
        finished("cancelled", 4),
        finished("cancelled", 5),
        finished("succeeded", 120),
      ],
    });
    const condition = {
      kind: "failure-rate" as const,
      percent: 60,
      windowMinutes: 60,
      minAttempts: 3,
    };
    const [breach] = evaluateCondition(condition, undefined, fleet([failing]));
    expect(breach).toEqual({
      subject: "a",
      summary: "2 of 3 Attempts on Profile a failed in the last 60m (67%).",
    });
    expect(subjects({ ...condition, minAttempts: 4 }, fleet([failing]))).toEqual([]);
    expect(subjects({ ...condition, percent: 70 }, fleet([failing]))).toEqual([]);
    // A two-hour window takes in the older success: 2 of 4 is 50%.
    expect(subjects({ ...condition, windowMinutes: 180 }, fleet([failing]))).toEqual([]);
  });

  it("consecutive-failures: the newest streak, skipping cancellations", () => {
    const streak = profile("a", {
      recentFinished: [
        finished("failed", 1),
        finished("cancelled", 2),
        finished("failed", 3),
        finished("failed", 4),
        finished("succeeded", 5),
        finished("failed", 6),
      ],
    });
    expect(subjects({ kind: "consecutive-failures", count: 3 }, fleet([streak]))).toEqual(["a"]);
    expect(subjects({ kind: "consecutive-failures", count: 4 }, fleet([streak]))).toEqual([]);
    const recovered = profile("a", {
      recentFinished: [finished("succeeded", 1), ...streak.recentFinished],
    });
    expect(subjects({ kind: "consecutive-failures", count: 1 }, fleet([recovered]))).toEqual([]);
  });

  it("failure alerts name why the newest failure failed", () => {
    // Every Attempt of a Profile whose runner GitHub refuses fails the same way; the page says how.
    const refused =
      "GitHub runner exited with code 1 without taking a job: Runner version v2.336.0 is deprecated and cannot receive messages.";
    const failing = profile("a", {
      recentFinished: [
        { ...finished("failed", 1), error: refused },
        { ...finished("failed", 2), error: "Executor exited with code 1" },
        finished("succeeded", 3),
      ],
    });
    const [rate] = evaluateCondition(
      { kind: "failure-rate", percent: 50, windowMinutes: 60, minAttempts: 3 },
      undefined,
      fleet([failing]),
    );
    expect(rate?.summary).toBe(
      `2 of 3 Attempts on Profile a failed in the last 60m (67%). The latest failure: ${refused}`,
    );
    const [streak] = evaluateCondition(
      { kind: "consecutive-failures", count: 2 },
      undefined,
      fleet([failing]),
    );
    expect(streak?.summary).toBe(
      `The last 2 finished Attempts on Profile a all failed. The latest failure: ${refused}`,
    );
  });

  it("attempt-duration: names the longest-running Attempt", () => {
    const observation = fleet([
      profile("a", {
        running: [
          {
            runnerName: "r-old",
            startedAt: NOW - 95 * MINUTE,
            repo: "acme/app",
            displayName: "build",
          },
          { runnerName: "r-mid", startedAt: NOW - 70 * MINUTE },
          { runnerName: "r-new", startedAt: NOW - 5 * MINUTE },
        ],
      }),
    ]);
    expect(
      evaluateCondition({ kind: "attempt-duration", minutes: 60 }, undefined, observation),
    ).toEqual([
      {
        subject: "a",
        summary:
          "2 Attempts on Profile a running longer than 60m; the longest is r-old (acme/app build) at 1h 35m.",
      },
    ]);
    expect(subjects({ kind: "attempt-duration", minutes: 120 }, observation)).toEqual([]);
  });

  it("controller-silent: a Profile whose controller stopped reporting fires after the threshold", () => {
    const condition: AlertCondition = { kind: "controller-silent", minutes: 3 };
    // Silent for 2 minutes: offline already, not yet past the threshold.
    expect(
      subjects(condition, fleet([withControllers("a", [heartbeat("ctl-1", "listening", 2)])])),
    ).toEqual([]);
    const observation = fleet([withControllers("a", [heartbeat("ctl-1", "listening", 7)])]);
    expect(evaluateCondition(condition, undefined, observation)).toEqual([
      {
        subject: "a",
        summary:
          "Profile a has had no listening controller for 7m; the last report came from ctl-1 (0.2.0-rc.11) 7m ago.",
      },
    ]);
  });

  it("controller-silent: resolves as soon as a controller listens again", () => {
    const condition: AlertCondition = { kind: "controller-silent", minutes: 3 };
    const recovered = fleet([
      withControllers("a", [
        heartbeat("ctl-1", "listening", 0.2, { lastListeningAt: NOW - 0.2 * MINUTE }),
      ]),
    ]);
    expect(subjects(condition, recovered)).toEqual([]);
  });

  it("controller-silent: a Profile no controller ever reported for is unknown, never silent", () => {
    // An upgrade window: the Profile is served by a controller that predates the heartbeat.
    expect(subjects({ kind: "controller-silent", minutes: 3 }, fleet([profile("legacy")]))).toEqual(
      [],
    );
  });

  it("controller-silent: a paused (retired) Profile is not alerted on", () => {
    const observation = fleet([
      withControllers("retired", [heartbeat("ctl-1", "stopped", 60)], { state: "paused" }),
    ]);
    expect(subjects({ kind: "controller-silent", minutes: 3 }, observation)).toEqual([]);
  });

  it("controller-silent: reporting without the session counts as silent, and says why", () => {
    const observation = fleet([
      withControllers("a", [
        heartbeat("ctl-2", "conflict", 0.1, {
          lastListeningAt: NOW - 10 * MINUTE,
          lastError: "409 Conflict",
        }),
      ]),
    ]);
    expect(
      evaluateCondition({ kind: "controller-silent", minutes: 3 }, undefined, observation),
    ).toEqual([
      {
        subject: "a",
        summary:
          "Profile a has had no listening controller for 10m; ctl-2 (0.2.0-rc.11) is reporting but GitHub refuses it the session because another one exists: 409 Conflict",
      },
    ]);
  });

  it("controller-silent: one listening controller is enough, whatever the others do", () => {
    const observation = fleet([
      withControllers("a", [
        heartbeat("ctl-1", "listening", 0.3),
        heartbeat("ctl-2", "conflict", 0.1),
        heartbeat("old-host", "stopped", 600),
      ]),
    ]);
    expect(subjects({ kind: "controller-silent", minutes: 3 }, observation)).toEqual([]);
  });

  it("controller-silent: a controller that stopped says so, with its reason", () => {
    const observation = fleet([
      withControllers("a", [
        heartbeat("ctl-1", "stopped", 5, {
          lastListeningAt: NOW - 5 * MINUTE,
          lastError: "run GitHub scale-set listener: connection reset",
        }),
      ]),
    ]);
    expect(
      evaluateCondition({ kind: "controller-silent", minutes: 3 }, undefined, observation),
    ).toEqual([
      {
        subject: "a",
        summary:
          "Profile a has had no listening controller for 5m; ctl-1 (0.2.0-rc.11) stopped 5m ago: run GitHub scale-set listener: connection reset",
      },
    ]);
  });

  it("controller-silent: a controller that never got the session counts from its first report", () => {
    const observation = fleet([
      withControllers("a", [
        heartbeat("ctl-1", "conflict", 0.1, { firstSeenAt: NOW - 4 * MINUTE }),
      ]),
    ]);
    expect(subjects({ kind: "controller-silent", minutes: 3 }, observation)).toEqual(["a"]);
    expect(subjects({ kind: "controller-silent", minutes: 5 }, observation)).toEqual([]);
  });

  it("node-commands-blocked: an online Node blocked past the threshold fires, with its reason and journal", () => {
    const observation = fleet(
      [profile("a")],
      [],
      [
        node("edge-1", {
          commandsBlocked: "journal_full",
          commandsBlockedSince: NOW - 20 * MINUTE,
          journalKeys: 10_000,
          journalKeyLimit: 10_000,
        }),
        node("edge-2", { commandsBlocked: "command_api", commandsBlockedSince: NOW - 2 * MINUTE }),
        node("edge-3"),
        // Went silent 5 minutes into its block: a stale report does not grow into a breach.
        node("edge-4", {
          online: false,
          lastSeenAt: NOW - 30 * MINUTE,
          commandsBlocked: "journal_full",
          commandsBlockedSince: NOW - 35 * MINUTE,
        }),
      ],
    );
    const condition: AlertCondition = { kind: "node-commands-blocked", minutes: 10 };
    expect(subjects(condition, observation)).toEqual(["edge-1"]);
    // A Profile scope does not hide a Node, which belongs to no Profile.
    expect(subjects(condition, observation, "a")).toEqual(["edge-1"]);
    const [breach] = evaluateCondition(condition, undefined, observation);
    expect(breach?.summary).toBe(
      "Node edge-1 has not been able to run commands for 20m: its execution journal is full of commands Convex has not finished or does not know, so new builds, deploys and operations are refused (journal_full). Its journal holds 10000 of 10000 keys.",
    );
    expect(subjects({ kind: "node-commands-blocked", minutes: 1 }, observation)).toEqual([
      "edge-1",
      "edge-2",
      "edge-4",
    ]);
  });

  it("node-commands-blocked: a blocked Node that goes silent stays blocked", () => {
    const blocked = {
      commandsBlocked: "journal_full",
      commandsBlockedSince: NOW - 60 * MINUTE,
      journalKeys: 9_999,
      journalKeyLimit: 10_000,
    };
    const condition: AlertCondition = { kind: "node-commands-blocked", minutes: 10 };
    // Firing while online...
    expect(subjects(condition, fleet([], [], [node("edge-1", blocked)]))).toEqual(["edge-1"]);
    // ...and still breaching once its heartbeats stop, so the open incident does not resolve.
    const silent = fleet(
      [],
      [],
      [node("edge-1", { ...blocked, online: false, lastSeenAt: NOW - 30 * MINUTE })],
    );
    const [breach] = evaluateCondition(condition, undefined, silent);
    expect(breach?.summary).toBe(
      "Node edge-1 could not run commands for 30m before its heartbeats stopped 30m ago: its execution journal is full of commands Convex has not finished or does not know, so new builds, deploys and operations are refused (journal_full). Its journal holds 9999 of 10000 keys.",
    );
    // It resolves when the Node comes back and says it can run commands again.
    expect(subjects(condition, fleet([], [], [node("edge-1")]))).toEqual([]);
  });

  it("node-offline: a Node silent past the threshold fires, with what its last heartbeat said", () => {
    const observation = fleet(
      [profile("a")],
      [],
      [
        node("edge-1", { online: false, lastSeenAt: NOW - 30 * MINUTE }),
        node("edge-2", { online: false, lastSeenAt: NOW - 3 * MINUTE }),
        node("edge-3"),
        node("edge-4", {
          online: false,
          lastSeenAt: NOW - 30 * MINUTE,
          commandsBlocked: "journal_full",
          commandsBlockedSince: NOW - 60 * MINUTE,
        }),
      ],
    );
    const condition: AlertCondition = { kind: "node-offline", minutes: 5 };
    expect(subjects(condition, observation)).toEqual(["edge-1", "edge-4"]);
    // A Profile scope does not hide a Node, which belongs to no Profile.
    expect(subjects(condition, observation, "a")).toEqual(["edge-1", "edge-4"]);
    expect(subjects({ kind: "node-offline", minutes: 2 }, observation)).toEqual([
      "edge-1",
      "edge-2",
      "edge-4",
    ]);
    const breaches = evaluateCondition(condition, undefined, observation);
    expect(breaches.map((b) => b.summary)).toEqual([
      "Node edge-1 has not sent a heartbeat for 30m; its Infra Agent or host is down, or it cannot reach Convex.",
      "Node edge-4 has not sent a heartbeat for 30m; its Infra Agent or host is down, or it cannot reach Convex. Its last heartbeat said it could not run commands: its execution journal is full of commands Convex has not finished or does not know, so new builds, deploys and operations are refused (journal_full).",
    ]);
  });

  // Every rule kind against a connect-convex Node that was blocked and then stopped heartbeating
  // (its agent crashed, or its host went down): the outage must not go unreported.
  it("a blocked Node that stops heartbeating is still alerted on", () => {
    const observation = fleet(
      [],
      [],
      [
        node("edge-1", {
          online: false,
          lastSeenAt: NOW - 30 * MINUTE,
          commandsBlocked: "journal_full",
          commandsBlockedSince: NOW - 60 * MINUTE,
          journalKeys: 9_999,
          journalKeyLimit: 10_000,
        }),
      ],
    );
    const conditions: AlertCondition[] = [
      { kind: "worker-offline", minutes: 5 },
      { kind: "profile-no-ready-worker" },
      { kind: "profile-readiness-degraded" },
      { kind: "profile-label-conflict" },
      { kind: "queue-backlog", minutes: 5 },
      { kind: "failure-rate", percent: 50, windowMinutes: 60, minAttempts: 1 },
      { kind: "consecutive-failures", count: 1 },
      { kind: "attempt-duration", minutes: 5 },
      { kind: "controller-silent", minutes: 3 },
      { kind: "node-commands-blocked", minutes: 10 },
      { kind: "node-offline", minutes: 5 },
      { kind: "runner-release-expiring" },
    ];
    expect(conditions.map((c) => c.kind).toSorted()).toEqual([...ALERT_CONDITION_KINDS].toSorted());
    const fired = conditions.flatMap((c) =>
      evaluateCondition(c, undefined, observation).map((b) => `${c.kind}:${b.subject}`),
    );
    expect(fired).toEqual(["node-commands-blocked:edge-1", "node-offline:edge-1"]);
  });

  it("runner-release-expiring: active Profiles within five days of GitHub's cutoff", () => {
    const DAY = 24 * 60 * MINUTE;
    const observation: FleetObservation = {
      ...fleet([
        profile("expiring", { runnerVersion: "2.337.0" }),
        profile("current", { runnerVersion: "2.338.2" }),
        profile("unknown"),
        profile("paused", { state: "paused", runnerVersion: "2.337.0" }),
      ]),
      runnerReleases: {
        fetchedAt: NOW,
        releases: [
          { version: "2.337.0", publishedAt: NOW - 40 * DAY },
          { version: "2.338.2", publishedAt: NOW - 26 * DAY },
        ],
      },
    };
    const condition: AlertCondition = { kind: "runner-release-expiring" };
    expect(subjects(condition, observation)).toEqual(["expiring"]);
    expect(subjects(condition, observation, "current")).toEqual([]);
    const [breach] = evaluateCondition(condition, undefined, observation);
    expect(breach?.summary).toBe(
      "Profile expiring's image runs actions/runner 2.337.0. GitHub published 2.338.2 on " +
        "2026-10-10, so it stops sending jobs to 2.337.0 on 2026-11-09, in 4d 0h. Rebuild the " +
        "image on actions/runner 2.338.2 and move the Profile to it.",
    );
    // Without a release list there is nothing to compare against: never a guess.
    expect(subjects(condition, fleet(observation.profiles))).toEqual([]);
  });

  it("node-commands-blocked: an unrecognised reason is reported as sent", () => {
    const observation = fleet(
      [],
      [],
      [node("edge-1", { commandsBlocked: "disk_gone", commandsBlockedSince: NOW - 5 * MINUTE })],
    );
    const [breach] = evaluateCondition(
      { kind: "node-commands-blocked", minutes: 5 },
      undefined,
      observation,
    );
    expect(breach?.summary).toBe(
      "Node edge-1 has not been able to run commands for 5m: disk_gone.",
    );
  });
});

describe("conditionError", () => {
  it("refuses thresholds outside their range", () => {
    expect(conditionError({ kind: "worker-offline", minutes: 1 })).toMatch(/2 to 10080/);
    expect(conditionError({ kind: "worker-offline", minutes: 5 })).toBeUndefined();
    expect(conditionError({ kind: "queue-backlog", minutes: 1.5 })).toBeDefined();
    expect(
      conditionError({ kind: "failure-rate", percent: 0, windowMinutes: 60, minAttempts: 3 }),
    ).toBeDefined();
    expect(
      conditionError({ kind: "failure-rate", percent: 50, windowMinutes: 2000, minAttempts: 3 }),
    ).toBeDefined();
    expect(conditionError({ kind: "consecutive-failures", count: 0 })).toBeDefined();
    expect(conditionError({ kind: "profile-no-ready-worker" })).toBeUndefined();
    // Below the 90-second offline cutoff one late report would page.
    expect(conditionError({ kind: "controller-silent", minutes: 1 })).toMatch(/2 to 10080/);
    expect(conditionError({ kind: "controller-silent", minutes: 3 })).toBeUndefined();
    expect(conditionError({ kind: "node-commands-blocked", minutes: 0 })).toBeDefined();
    expect(conditionError({ kind: "node-commands-blocked", minutes: 5 })).toBeUndefined();
    // Below the two-minute missed-heartbeat window one late heartbeat would page.
    expect(conditionError({ kind: "node-offline", minutes: 1 })).toMatch(/2 to 10080/);
    expect(conditionError({ kind: "node-offline", minutes: 2 })).toBeUndefined();
  });
});

const CONTENT: NotificationContent = {
  event: "firing",
  rule: {
    id: "rule-1",
    name: "Queue <backlog> & co",
    kind: "queue-backlog",
    condition: "Oldest queued Attempt older than 15m",
    profile: "rc-linux-js",
  },
  incident: {
    id: "incident-1",
    subject: "rc-linux-js",
    summary: "3 Attempts queued on Profile rc-linux-js; the oldest has waited 16m.",
    since: NOW - 16 * MINUTE,
    firedAt: NOW,
    resolvedAt: null,
  },
  sentAt: NOW,
};

describe("notification bodies", () => {
  it("builds a versioned webhook body with ISO times", () => {
    expect(JSON.parse(webhookBody(CONTENT))).toEqual({
      version: 1,
      event: "alert.firing",
      rule: CONTENT.rule,
      incident: {
        id: "incident-1",
        status: "firing",
        subject: "rc-linux-js",
        summary: CONTENT.incident.summary,
        since: "2026-11-05T11:44:00.000Z",
        firedAt: "2026-11-05T12:00:00.000Z",
        resolvedAt: null,
      },
      sentAt: "2026-11-05T12:00:00.000Z",
    });
  });

  it("builds a Slack message with escaped text", () => {
    const body = JSON.parse(slackBody({ ...CONTENT, event: "resolved" })) as {
      text: string;
      blocks: Array<{ type: string; text: { type: string; text: string } }>;
    };
    expect(body.text).toBe(
      ":white_check_mark: Resolved: Queue &lt;backlog&gt; &amp; co: 3 Attempts queued on Profile rc-linux-js; the oldest has waited 16m.",
    );
    expect(body.blocks).toHaveLength(1);
    expect(body.blocks[0]?.text.type).toBe("mrkdwn");
    expect(body.blocks[0]?.text.text).toContain("Subject `rc-linux-js`");
  });
});

describe("signWebhook", () => {
  it("signs t.body with HMAC-SHA256 in Stripe's header format", async () => {
    // Independent computation of the same MAC, as a receiver would do it.
    const secret = "whsec_test";
    const body = '{"hello":"world"}';
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const header = await signWebhook(secret, 1_700_000_000, body);
    const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
    expect(match?.[1]).toBe("1700000000");
    const mac = Uint8Array.from((match?.[2] ?? "").match(/../g) ?? [], (pair) =>
      Number.parseInt(pair, 16),
    );
    expect(
      await crypto.subtle.verify("HMAC", key, mac, new TextEncoder().encode(`1700000000.${body}`)),
    ).toBe(true);
    // A different timestamp or body yields a different signature.
    expect(await signWebhook(secret, 1_700_000_001, body)).not.toBe(header);
    expect(await signWebhook(secret, 1_700_000_000, `${body} `)).not.toBe(header);
  });

  it("matches a known vector", async () => {
    // printf '%s' '1.{}' | openssl dgst -sha256 -hmac 'key'
    expect(await signWebhook("key", 1, "{}")).toBe(
      "t=1,v1=1ba6b8171186efc613e8bcc0cbdab2748f24984d7c5a84faa2637afa0e40d224",
    );
  });
});

describe("delivery policy", () => {
  it("retries temporary failures and gives up on the rest", () => {
    expect(classifyResponse(204, null)).toEqual({ kind: "delivered", statusCode: 204 });
    expect(classifyResponse(503, null)).toEqual({
      kind: "retry",
      statusCode: 503,
      error: "HTTP 503",
    });
    expect(classifyResponse(429, "120")).toEqual({
      kind: "retry",
      statusCode: 429,
      error: "HTTP 429",
      retryAfterMs: 120_000,
    });
    expect(classifyResponse(408, null).kind).toBe("retry");
    expect(classifyResponse(410, null)).toEqual({
      kind: "permanent",
      statusCode: 410,
      error: "HTTP 410",
    });
    expect(classifyResponse(302, null).kind).toBe("permanent");
  });

  it("backs off exponentially to an hour, with bounded jitter and Retry-After", () => {
    expect([1, 2, 3, 4].map((attempt) => deliveryBackoffMs(attempt, 0))).toEqual([
      30_000, 60_000, 120_000, 240_000,
    ]);
    expect(deliveryBackoffMs(20, 0)).toBe(3_600_000);
    expect(deliveryBackoffMs(1, 1)).toBe(36_000);
    expect(deliveryBackoffMs(1, 0, 90_000)).toBe(90_000);
  });

  it("accepts only https destination URLs and hides their path", () => {
    expect(destinationUrlError("http://hooks.example.com/x")).toMatch(/https/);
    expect(destinationUrlError("not a url")).toBeDefined();
    expect(destinationUrlError("https://user:pw@hooks.example.com/x")).toBeDefined();
    expect(destinationUrlError("https://hooks.slack.com/services/T0/B0/abcdef")).toBeUndefined();
    expect(urlHint("https://hooks.slack.com/services/T0/B0/abcdef")).toBe(
      "https://hooks.slack.com/…cdef",
    );
  });
});
