import { v } from "convex/values";

/**
 * The states of a `workerReadiness` row. This module owns the list: the schema, the validators
 * that carry a readiness state, the scheduler and fleet observation all import it, so a new state
 * is added in one place. `tests/readinessStates.test.ts` fails when the schema's states differ
 * from this list, or when a backend module declares its own copy.
 */
export const READINESS_STATES = ["preparing", "ready", "degraded", "failed"] as const;
export type ReadinessState = (typeof READINESS_STATES)[number];

export const readinessStateValidator = v.union(
  ...READINESS_STATES.map((state) => v.literal(state)),
);
