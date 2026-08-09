// Pure decision logic for dashboard account bootstrap. Kept free of Convex
// bindings so the rules can be unit tested directly, the same way policy.ts is.

/**
 * A shorter secret than this is refused outright. 32 characters is the width of
 * the `openssl rand -hex 16` the docs recommend, and well past what an attacker
 * could work through under the lockout schedule below.
 */
export const MIN_BOOTSTRAP_SECRET_LENGTH = 32;

/** A grant is meant to be redeemed by the operator who just asked for it. */
export const GRANT_TTL_MS = 10 * 60 * 1_000;

/** Consecutive failures tolerated before the lockout schedule starts. */
export const FAILURE_ALLOWANCE = 5;

export const BASE_LOCKOUT_MS = 30 * 1_000;
export const MAX_LOCKOUT_MS = 15 * 60 * 1_000;

export type BootstrapSecretConfig =
  | { configured: true; secret: string }
  | { configured: false; reason: string };

/**
 * Fail closed: an unset or too-short BOOTSTRAP_SECRET means no account can be
 * created at all, rather than falling back to an open sign-up.
 */
export function readBootstrapSecret(
  env: Record<string, string | undefined>,
): BootstrapSecretConfig {
  const raw = env.BOOTSTRAP_SECRET;
  if (raw === undefined || raw.trim().length === 0) {
    return {
      configured: false,
      reason: "BOOTSTRAP_SECRET is not set on this deployment, so no account can be created.",
    };
  }
  const secret = raw.trim();
  if (secret.length < MIN_BOOTSTRAP_SECRET_LENGTH) {
    return {
      configured: false,
      reason: `BOOTSTRAP_SECRET must be at least ${MIN_BOOTSTRAP_SECRET_LENGTH} characters.`,
    };
  }
  return { configured: true, secret };
}

export type ThrottleRow = {
  failures: number;
  lockedUntil: number;
};

export function throttleState(row: ThrottleRow | null, now: number) {
  if (row === null || row.lockedUntil <= now) {
    return { locked: false as const, retryAfterMs: 0 };
  }
  return { locked: true as const, retryAfterMs: row.lockedUntil - now };
}

/**
 * Doubling lockout once the allowance is spent, capped so a wrong secret typed
 * by the operator does not brick setup for the rest of the day.
 */
export function nextThrottleAfterFailure(row: ThrottleRow | null, now: number): ThrottleRow {
  const failures = (row?.failures ?? 0) + 1;
  const over = failures - FAILURE_ALLOWANCE;
  if (over <= 0) {
    return { failures, lockedUntil: 0 };
  }
  const lockout = Math.min(BASE_LOCKOUT_MS * 2 ** (over - 1), MAX_LOCKOUT_MS);
  return { failures, lockedUntil: now + lockout };
}

/**
 * Byte comparison whose running time does not depend on where the first
 * difference is. Callers pass digests, so the lengths always match and the
 * early length check leaks nothing about the secret.
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) {
    return false;
  }
  let difference = 0;
  for (const [index, byte] of a.entries()) {
    difference |= byte ^ b[index]!;
  }
  return difference === 0;
}

export type GrantValidity = "valid" | "expired" | "used";

export function grantValidity(
  grant: { expiresAt: number; usedAt?: number | undefined },
  now: number,
): GrantValidity {
  if (grant.usedAt !== undefined) {
    return "used";
  }
  return grant.expiresAt <= now ? "expired" : "valid";
}
