import type { Doc } from "./_generated/dataModel";

/**
 * How long a reported state counts. The Agent heartbeats every 30 seconds, so this spans three
 * heartbeats; an older state says nothing about the Worker now and routes as if under budget.
 */
export const START_BUDGET_FRESH_MS = 90_000;

/** Whether a job routed to this Worker now would wait for its start budget. */
export function isOverStartBudget(machine: Doc<"machines"> | undefined, now: number) {
  const state = machine?.startBudget;
  return state !== undefined && state.overBudget && now - state.reportedAt <= START_BUDGET_FRESH_MS;
}
