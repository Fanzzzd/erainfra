/**
 * Which Attempt and Experiment states count as active. This module owns the lists: slot counts,
 * reconciliation, routing and fleet observation all import them, so a new state is classified in
 * one place. `tests/attemptStates.test.ts` fails when the schema gains a state this module does
 * not classify, or when a backend module declares its own copy.
 */

/**
 * Active Attempts that already hold a Worker slot. The scheduler reads these per Worker and adds
 * `pending` rows separately, because a pending Attempt is still waiting for placement.
 */
export const ASSIGNED_ATTEMPT_STATES = ["preparing", "ready", "running"] as const;

/** Attempts that are not finished: waiting for a Worker, or holding one. */
export const ACTIVE_ATTEMPT_STATES = ["pending", ...ASSIGNED_ATTEMPT_STATES] as const;
export type ActiveAttemptState = (typeof ACTIVE_ATTEMPT_STATES)[number];

/** Active Attempts whose Runner GitHub has not yet handed a job: every active state but `running`. */
export const IDLE_ATTEMPT_STATES = ["pending", "preparing", "ready"] as const;

export const TERMINAL_ATTEMPT_STATES = ["completed", "cancelled", "failed"] as const;

/** Active Experiments that already hold a Worker slot. `queued` rows are read separately. */
export const ASSIGNED_EXPERIMENT_STATES = ["preparing", "running"] as const;

/** Experiments that are not finished: queued for a Worker, or holding one. */
export const ACTIVE_EXPERIMENT_STATES = ["queued", ...ASSIGNED_EXPERIMENT_STATES] as const;

export const TERMINAL_EXPERIMENT_STATES = ["completed", "cancelled", "failed"] as const;
