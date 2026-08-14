// Workers heartbeat well inside this window. Two missed minutes is the shared
// cutoff for availability, scheduling, and reconciliation decisions.
export const WORKER_OFFLINE_AFTER_MS = 2 * 60_000;
