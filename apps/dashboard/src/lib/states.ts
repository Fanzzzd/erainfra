import type { StatusState } from "@/components/status";

/**
 * How the dashboard shows one of its own states through the registry's state map
 * (`components/status.tsx`). `state` picks the dot, tone and pulse; `label` is the dashboard's
 * word when it differs from the registry's. Render it with
 * `<Status state={view.state}>{view.label}</Status>`.
 *
 * Every product state the dashboard shows maps here, so one state never looks two ways on two
 * pages. A state the registry lacks borrows the closest registry state and keeps its own label.
 */
export type StateView = { state: StatusState; label?: string };

export type AttemptState =
  | "pending"
  | "preparing"
  | "ready"
  | "running"
  | "completed"
  | "cancelled"
  | "failed";

const ATTEMPT: Record<AttemptState, StateView> = {
  pending: { state: "pending" },
  preparing: { state: "preparing" },
  ready: { state: "preparing", label: "Ready" },
  running: { state: "running" },
  completed: { state: "succeeded", label: "Completed" },
  cancelled: { state: "cancelled" },
  failed: { state: "failed" },
};

export function attemptView(state: AttemptState): StateView {
  return ATTEMPT[state];
}

export type ExperimentState =
  | "queued"
  | "preparing"
  | "running"
  | "completed"
  | "cancelled"
  | "failed";

const EXPERIMENT: Record<ExperimentState, StateView> = {
  queued: { state: "queued" },
  preparing: { state: "preparing" },
  running: { state: "running" },
  completed: { state: "succeeded", label: "Completed" },
  cancelled: { state: "cancelled" },
  failed: { state: "failed" },
};

export function experimentView(state: ExperimentState): StateView {
  return EXPERIMENT[state];
}

/** A Machine or Node by heartbeat. */
export function onlineView(online: boolean): StateView {
  return { state: online ? "online" : "offline" };
}

export type AppStatus = "deploying" | "running" | "node-offline";

const APP: Record<AppStatus, StateView> = {
  deploying: { state: "preparing", label: "Deploying" },
  running: { state: "running" },
  "node-offline": { state: "unhealthy", label: "Node offline" },
};

export function appView(status: AppStatus): StateView {
  return APP[status];
}

export type LinkState = "active" | "degraded" | "pending";

const LINK: Record<LinkState, StateView> = {
  active: { state: "healthy", label: "Active" },
  degraded: { state: "degraded" },
  pending: { state: "pending" },
};

export function linkView(state: LinkState): StateView {
  return LINK[state];
}

const DEPLOY_STAGE: Record<string, StateView> = {
  queued: { state: "queued" },
  "reading-spec": { state: "preparing", label: "Reading spec" },
  planning: { state: "preparing", label: "Planning" },
  building: { state: "preparing", label: "Building" },
  deploying: { state: "preparing", label: "Deploying" },
  linking: { state: "preparing", label: "Linking" },
  done: { state: "succeeded", label: "Done" },
  failed: { state: "failed" },
};

/** A deployment run's stage. An unknown stage shows as a neutral state with its own name. */
export function deployStageView(stage: string): StateView {
  return DEPLOY_STAGE[stage] ?? { state: "idle", label: stage };
}
