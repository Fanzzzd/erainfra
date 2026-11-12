import { isNodeLive } from "@erainfra/backend/infraPolicy";

import type { Tone } from "@/components/status";

// Infrastructure-management views (convex/infra/operator.ts) carry timestamps, and the dashboard
// judges liveness against its own clock. A Convex query re-runs when a Node heartbeats, not when a
// Node goes quiet, so a liveness flag computed in the query would stay "online" after the Node
// stopped. The rule is the backend's own (isNodeLive), so the two cannot disagree.

export function nodeOnline(lastSeenAt: number | null, now: number) {
  return isNodeLive(lastSeenAt ?? undefined, now);
}

/** Node name → last heartbeat, for pages that list Apps or links by Node name. */
export function heartbeatsByName(nodes: readonly { name: string; lastSeenAt: number | null }[]) {
  return new Map(nodes.map((node) => [node.name, node.lastSeenAt]));
}

export type AppStatus = "deploying" | "running" | "node-offline";

/**
 * The server's status, with `running` re-judged against the current time: a Node that stopped
 * heartbeating after the query last ran makes its Apps `node-offline`.
 */
export function appStatus(
  app: { status: AppStatus; services: readonly { node: string | null }[] },
  heartbeats: Map<string, number | null>,
  now: number,
): AppStatus {
  if (app.status !== "running") return app.status;
  const offline = app.services.some(
    (service) => service.node === null || !nodeOnline(heartbeats.get(service.node) ?? null, now),
  );
  return offline ? "node-offline" : "running";
}

export const APP_STATUS: Record<AppStatus, { label: string; tone: Tone }> = {
  deploying: { label: "Deploying", tone: "info" },
  running: { label: "Running", tone: "success" },
  "node-offline": { label: "Node offline", tone: "destructive" },
};

export type LinkState = "active" | "degraded" | "pending";

/** Same re-judgement for a link on the mesh: an end that stopped heartbeating degrades it. */
export function linkState(
  link: {
    state: LinkState;
    reason: string | null;
    provider: string | null;
    consumer: string | null;
  },
  heartbeats: Map<string, number | null>,
  now: number,
): { state: LinkState; reason: string | null } {
  if (link.state === "pending") return { state: link.state, reason: link.reason };
  const silent = [link.provider, link.consumer].filter(
    (name) => name === null || !nodeOnline(heartbeats.get(name) ?? null, now),
  );
  if (silent.length === 0) return { state: "active", reason: null };
  return {
    state: "degraded",
    reason: `${silent.map((name) => name ?? "a removed Node").join(" and ")} stopped heartbeating`,
  };
}

export const DEPLOY_STAGE_TONE: Record<string, Tone> = {
  queued: "muted",
  "reading-spec": "info",
  planning: "info",
  building: "info",
  deploying: "info",
  linking: "info",
  done: "success",
  failed: "destructive",
};
