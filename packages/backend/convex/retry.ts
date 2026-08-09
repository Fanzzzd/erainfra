// Bounded provisioning retries.
//
// Without a cap a job whose host can never provision it (missing Docker, a
// missing parent image, a GitHub permission error) bounces between "queued" and
// "assigned" forever, minting a throwaway JIT runner registration on GitHub
// every time round. Attempts are counted when the scheduler hands the job to a
// machine, and every failure widens the gap before the next one.

export const MAX_PROVISION_ATTEMPTS = 3;

const BACKOFF_SCHEDULE_MS = [15_000, 60_000, 300_000] as const;

export function backoffMs(attempts: number) {
  if (attempts <= 0) {
    return 0;
  }
  const index = Math.min(attempts, BACKOFF_SCHEDULE_MS.length) - 1;
  return BACKOFF_SCHEDULE_MS[index] ?? 0;
}

export type AttemptOutcome =
  | { kind: "retry"; attempts: number; nextAttemptAt: number; lastError: string }
  | { kind: "exhausted"; attempts: number; lastError: string };

/**
 * Decide what happens to a job whose provisioning attempt just failed.
 * `attempts` is the number of attempts already made, including this one.
 */
export function decideAttemptOutcome(attempts: number, now: number, error: string): AttemptOutcome {
  const lastError = summarizeError(error);
  if (attempts >= MAX_PROVISION_ATTEMPTS) {
    return { kind: "exhausted", attempts, lastError };
  }
  return {
    kind: "retry",
    attempts,
    nextAttemptAt: now + backoffMs(attempts),
    lastError,
  };
}

const MAX_ERROR_LENGTH = 500;

/** Keep the operator-facing message short, single-line and free of stack noise. */
export function summarizeError(error: string) {
  const collapsed = error.replace(/\s+/g, " ").trim();
  const message = collapsed.length === 0 ? "Unknown error" : collapsed;
  return message.length <= MAX_ERROR_LENGTH
    ? message
    : `${message.slice(0, MAX_ERROR_LENGTH - 1)}…`;
}
