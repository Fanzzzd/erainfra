import { describe, expect, it } from "vitest";
import {
  CONTROLLER_OFFLINE_AFTER_MS,
  controllerLiveness,
  controllerSilentForMs,
  type ControllerHeartbeatRow,
} from "../convex/controllerLiveness";

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const SECOND = 1_000;

function row(
  hostname: string,
  sessionState: ControllerHeartbeatRow["sessionState"],
  secondsAgo: number,
  fields: Partial<ControllerHeartbeatRow> = {},
): ControllerHeartbeatRow {
  const receivedAt = NOW - secondsAgo * SECOND;
  return {
    hostname,
    version: "0.2.0-rc.11",
    sessionState,
    receivedAt,
    firstSeenAt: NOW - 3_600 * SECOND,
    ...(sessionState === "listening" ? { lastListeningAt: receivedAt } : {}),
    assignedJobs: 0,
    runningJobs: 0,
    tokenSlot: "current",
    ...fields,
  };
}

describe("controllerLiveness", () => {
  it("is unknown until a controller first reports", () => {
    const liveness = controllerLiveness([], NOW);
    expect(liveness).toEqual({ status: "unknown", live: 0, controllers: [] });
    expect(controllerSilentForMs(liveness, NOW)).toBeUndefined();
  });

  it("is online while a listening controller reported inside the cutoff, offline at it", () => {
    const cutoff = CONTROLLER_OFFLINE_AFTER_MS / SECOND;
    expect(controllerLiveness([row("a", "listening", cutoff - 1)], NOW).status).toBe("online");
    expect(controllerLiveness([row("a", "listening", cutoff)], NOW).status).toBe("offline");
  });

  it("is offline at once after a clean stop, without waiting for the cutoff", () => {
    const liveness = controllerLiveness([row("a", "stopped", 1)], NOW);
    expect(liveness.status).toBe("offline");
    expect(liveness.live).toBe(0);
  });

  it("is waiting while controllers report but none holds the session", () => {
    const liveness = controllerLiveness([row("a", "conflict", 5), row("b", "starting", 10)], NOW);
    expect(liveness.status).toBe("waiting");
    expect(liveness.live).toBe(2);
    expect(liveness.primary?.hostname).toBe("a");
  });

  it("shows the listening controller, whichever reported last", () => {
    const liveness = controllerLiveness(
      [row("standby", "conflict", 1), row("primary", "listening", 20), row("gone", "stopped", 900)],
      NOW,
    );
    expect(liveness.status).toBe("online");
    expect(liveness.primary?.hostname).toBe("primary");
    expect(liveness.lastHeartbeatAt).toBe(NOW - 1 * SECOND);
    expect(liveness.firstSeenAt).toBe(NOW - 3_600 * SECOND);
  });

  it("shows the newest report when nothing is live", () => {
    const liveness = controllerLiveness(
      [row("old", "listening", 900), row("newer", "stopped", 300)],
      NOW,
    );
    expect(liveness.primary?.hostname).toBe("newer");
    expect(liveness.lastListeningAt).toBe(NOW - 900 * SECOND);
  });
});

describe("controllerSilentForMs", () => {
  it("counts from the last report that held the session", () => {
    const liveness = controllerLiveness(
      [row("a", "conflict", 1, { lastListeningAt: NOW - 400 * SECOND })],
      NOW,
    );
    expect(controllerSilentForMs(liveness, NOW)).toBe(400 * SECOND);
  });

  it("counts from the first report when no controller ever held the session", () => {
    const liveness = controllerLiveness(
      [row("a", "conflict", 1, { firstSeenAt: NOW - 200 * SECOND })],
      NOW,
    );
    expect(controllerSilentForMs(liveness, NOW)).toBe(200 * SECOND);
  });

  it("is undefined while a controller listens", () => {
    expect(controllerSilentForMs(controllerLiveness([row("a", "listening", 5)], NOW), NOW)).toBe(
      undefined,
    );
  });
});
