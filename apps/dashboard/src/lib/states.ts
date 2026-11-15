import { defineStatusStates, machineStates, runStates } from "@/components/status";

/**
 * The dashboard's own states, keyed by the word the backend uses, with the label, tone, dot and
 * pulse each one shows. Render one with `<Status states={attemptStates} state={attempt.state} />`.
 * Every state the dashboard shows is defined here, so one state never looks two ways on two pages.
 */

export const attemptStates = defineStatusStates({
  pending: runStates.pending,
  preparing: runStates.preparing,
  ready: { label: "Ready", tone: "warning", pulse: true },
  running: runStates.running,
  completed: { label: "Completed", tone: "success" },
  cancelled: runStates.cancelled,
  failed: runStates.failed,
});

export type AttemptState = keyof typeof attemptStates;

export const experimentStates = defineStatusStates({
  queued: runStates.queued,
  preparing: runStates.preparing,
  running: runStates.running,
  completed: { label: "Completed", tone: "success" },
  cancelled: runStates.cancelled,
  failed: runStates.failed,
});

export type ExperimentState = keyof typeof experimentStates;

/** A Machine or Node by heartbeat. */
export const onlineStates = defineStatusStates({
  online: machineStates.online,
  offline: machineStates.offline,
});

export function onlineState(online: boolean): keyof typeof onlineStates {
  return online ? "online" : "offline";
}

/** A Profile's scale-set controller, judged from its sessions. */
export const controllerStates = defineStatusStates({
  online: machineStates.online,
  waiting: { label: "Waiting for session", tone: "warning", pulse: true },
  offline: { label: "Offline", tone: "danger" },
  paused: { label: "Paused", tone: "neutral", hollow: true },
});

export const appStates = defineStatusStates({
  deploying: { label: "Deploying", tone: "product", pulse: true },
  running: runStates.running,
  "node-offline": { label: "Node offline", tone: "danger" },
});

export type AppStatus = keyof typeof appStates;

export const linkStates = defineStatusStates({
  active: { label: "Active", tone: "success" },
  degraded: { label: "Degraded", tone: "warning" },
  pending: runStates.pending,
});

export type LinkState = keyof typeof linkStates;

/** A deployment run's stage. A stage missing here shows as a neutral state with its own name. */
export const deployStageStates = defineStatusStates({
  queued: runStates.queued,
  "reading-spec": { label: "Reading spec", tone: "warning", pulse: true },
  planning: { label: "Planning", tone: "warning", pulse: true },
  building: { label: "Building", tone: "warning", pulse: true },
  deploying: { label: "Deploying", tone: "product", pulse: true },
  linking: { label: "Linking", tone: "warning", pulse: true },
  done: { label: "Done", tone: "success" },
  failed: runStates.failed,
});

export type DeployStage = keyof typeof deployStageStates;

export function isDeployStage(stage: string): stage is DeployStage {
  return Object.hasOwn(deployStageStates, stage);
}

export const incidentStates = defineStatusStates({
  firing: { label: "Firing", tone: "danger", pulse: true },
  pending: { label: "Pending", tone: "warning" },
  resolved: { label: "Resolved", tone: "success" },
});

export const deliveryStates = defineStatusStates({
  pending: { label: "Pending", tone: "warning", pulse: true },
  delivered: { label: "Delivered", tone: "success" },
  failed: runStates.failed,
});
