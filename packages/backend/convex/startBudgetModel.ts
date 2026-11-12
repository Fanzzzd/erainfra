import { v, type Infer } from "convex/values";

/**
 * A Worker's start budget, as its runtime reports it (apps/runtime/internal/admission).
 *
 * The runtime holds an Attempt's start while too many others are still starting or the host's
 * I/O pressure is over the limit, for at most maxHoldSeconds. A job routed to a Worker over
 * budget therefore waits; the `/runs-on` router sends new jobs to the fallback instead
 * (routing.profileRoute). Attempts already created are placed as before: their jobs are queued
 * on the scale set and have nowhere else to go.
 *
 * testdata/admission-state.golden.json is the shape; the runtime's Go test writes it.
 */
export const startBudgetValidator = v.object({
  maxStarting: v.number(),
  startWindowSeconds: v.number(),
  ioPressureLimit: v.number(),
  maxHoldSeconds: v.number(),
  starting: v.number(),
  held: v.number(),
  ioSomeAvg10: v.number(),
  pressureKnown: v.boolean(),
  overBudget: v.boolean(),
});

export type StartBudgetState = Infer<typeof startBudgetValidator>;

/** As stored on the machine: the heartbeat's state and when it arrived. */
export const storedStartBudgetValidator = v.object({
  ...startBudgetValidator.fields,
  reportedAt: v.number(),
});
