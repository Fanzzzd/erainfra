// Whether a Profile's controller is alive, from the heartbeats its controllers send. Pure and free
// of Convex bindings, so the dashboard computes the same answer against its own ticking clock (a
// reactive query is not re-run when time passes, only when data changes, and a dead controller
// changes no data), and /metrics and the alert evaluator compute it at read time.
//
// The rule for controllers older than the heartbeat:
//
//   A Profile with no heartbeat row has never been served by a controller that reports. Its
//   liveness is `unknown`, not `offline`: it is never alerted on and has no up or age series in
//   /metrics. The first heartbeat ever received for the Profile starts tracking it, and from then
//   on silence is an outage. Upgrading a controller therefore cannot page anyone, and a Profile
//   whose controller is gone for good stops paging when it is retired (paused).
//
// Several controllers may report for one Profile, one row per host. The lease (ADR 0014) lets one
// of them serve and the others report `standby`; GitHub's one-session rule backs it up, so at most
// one is listening and a new holder whose predecessor's session lingers waits in `conflict`.

/** Three missed 30-second reports. One slow request and one lost one do not flip the status. */
export const CONTROLLER_OFFLINE_AFTER_MS = 90_000;

export type ControllerSessionState = "starting" | "standby" | "listening" | "conflict" | "stopped";

/** The fields of one controller's newest report that liveness is computed from. */
export type ControllerHeartbeatRow = {
  hostname: string;
  version: string;
  sessionState: ControllerSessionState;
  receivedAt: number;
  firstSeenAt: number;
  lastListeningAt?: number;
  lastMessageAt?: number;
  assignedJobs: number;
  runningJobs: number;
  lastError?: string;
  tokenSlot: "current" | "next" | "machine";
  leaseRole?: "holder" | "standby";
  leaseEpoch?: number;
};

/**
 * - `unknown`: no controller has ever reported for the Profile.
 * - `online`: a controller reported within the cutoff and holds the GitHub session.
 * - `waiting`: controllers are reporting, but none holds the session (starting, standing by for
 *   the lease, or refused the session because another one exists).
 * - `offline`: no controller has reported within the cutoff, or the only recent report is a stop.
 */
export type ControllerStatus = "unknown" | "online" | "waiting" | "offline";

export type ControllerLiveness = {
  status: ControllerStatus;
  /** The controller to show: the listening one, else the one that reported last. */
  primary?: ControllerHeartbeatRow;
  /** Newest report from any of the Profile's controllers. */
  lastHeartbeatAt?: number;
  /** Newest report in which any of them held the session. */
  lastListeningAt?: number;
  /** When the first of them ever reported. */
  firstSeenAt?: number;
  /** Controllers that reported within the cutoff and are not stopping. */
  live: number;
  /** Every controller that has reported for the Profile, newest report first. */
  controllers: ControllerHeartbeatRow[];
};

function isLive(row: ControllerHeartbeatRow, now: number) {
  return row.sessionState !== "stopped" && now - row.receivedAt < CONTROLLER_OFFLINE_AFTER_MS;
}

export function controllerLiveness(
  rows: readonly ControllerHeartbeatRow[],
  now: number,
): ControllerLiveness {
  if (rows.length === 0) return { status: "unknown", live: 0, controllers: [] };
  const newestFirst = rows.toSorted((left, right) => right.receivedAt - left.receivedAt);
  const live = newestFirst.filter((row) => isLive(row, now));
  const listening = live.find((row) => row.sessionState === "listening");
  const listenedAt = rows.flatMap((row) =>
    row.lastListeningAt === undefined ? [] : [row.lastListeningAt],
  );
  return {
    status: listening !== undefined ? "online" : live.length > 0 ? "waiting" : "offline",
    primary: listening ?? live[0] ?? newestFirst[0],
    lastHeartbeatAt: newestFirst[0]?.receivedAt,
    ...(listenedAt.length === 0 ? {} : { lastListeningAt: Math.max(...listenedAt) }),
    firstSeenAt: Math.min(...rows.map((row) => row.firstSeenAt)),
    live: live.length,
    controllers: newestFirst,
  };
}

/**
 * How long the Profile has had no listening controller, or undefined while one is listening or
 * when liveness is unknown. Counted from the last report in which a controller held the session,
 * or, for controllers that never got it, from when the first of them reported.
 */
export function controllerSilentForMs(liveness: ControllerLiveness, now: number) {
  if (liveness.status === "online" || liveness.status === "unknown") return undefined;
  const since = liveness.lastListeningAt ?? liveness.firstSeenAt;
  return since === undefined ? undefined : Math.max(0, now - since);
}
