import { execa } from "execa";

import { childEnvironment, runtimeBinary } from "./dual-env.ts";

/**
 * The Worker's start budget, as `runner-center-runtime admission` prints it.
 *
 * The runtime holds an Attempt's start while too many others are still starting or the host's
 * I/O pressure is over the limit (apps/runtime/internal/admission). The agent forwards this
 * state in its heartbeat so `/runs-on` can send new jobs elsewhere while the Worker is over
 * budget. testdata/admission-state.golden.json is the shape; the Go test writes it.
 */
export type AdmissionState = {
  maxStarting: number;
  startWindowSeconds: number;
  ioPressureLimit: number;
  maxHoldSeconds: number;
  starting: number;
  held: number;
  ioSomeAvg10: number;
  pressureKnown: boolean;
  overBudget: boolean;
};

const numberFields = [
  "maxStarting",
  "startWindowSeconds",
  "ioPressureLimit",
  "maxHoldSeconds",
  "starting",
  "held",
  "ioSomeAvg10",
] as const;
const booleanFields = ["pressureKnown", "overBudget"] as const;

/** Parses the runtime's output, or returns undefined when it is not exactly that shape. */
export function parseAdmissionState(text: string): AdmissionState | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const state: Record<string, number | boolean> = {};
  for (const field of numberFields) {
    const fieldValue = record[field];
    if (typeof fieldValue !== "number" || !Number.isFinite(fieldValue) || fieldValue < 0) {
      return undefined;
    }
    state[field] = fieldValue;
  }
  for (const field of booleanFields) {
    const fieldValue = record[field];
    if (typeof fieldValue !== "boolean") return undefined;
    state[field] = fieldValue;
  }
  return state as AdmissionState;
}

export type RunAdmission = () => Promise<{ exitCode?: number; stdout: string }>;

const runAdmission: RunAdmission = () =>
  execa(runtimeBinary(), ["admission"], {
    env: childEnvironment({}),
    timeout: 5_000,
    reject: false,
  });

/**
 * Reads the start budget from the runtime. Any failure returns undefined: a heartbeat without
 * the state routes as before, and the runtime still holds starts on its own.
 */
export async function readAdmissionState(run: RunAdmission = runAdmission) {
  try {
    const result = await run();
    if (result.exitCode !== 0) return undefined;
    return parseAdmissionState(result.stdout);
  } catch {
    return undefined;
  }
}
