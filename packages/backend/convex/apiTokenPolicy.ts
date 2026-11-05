// Pure rules for the control plane's API tokens, kept free of Convex bindings so
// they can be unit tested directly, the same way authPolicy.ts and
// bootstrapPolicy.ts are.

/**
 * One token system for every machine credential an operator mints in the
 * dashboard, told apart by scope:
 *
 * - `metrics` scrapes `GET /metrics` and nothing else. It lives in a Prometheus
 *   config file, the most widely copied place a token ends up, so it reads no
 *   per-job detail.
 * - `read` reads the operator API (`/api/v1`) and may also scrape.
 * - `admin` adds the actions the dashboard offers through the API.
 *
 * GitLab's personal access tokens and Grafana's service-account tokens draw the
 * same lines: one table, one surface, a scope per token.
 */
export const API_TOKEN_SCOPES = ["read", "admin", "metrics"] as const;
export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

/**
 * Every token starts with this, so a leaked one is recognisable in a log line or
 * a paste, and secret scanners can match it. The 64 hex characters after it are
 * 256 bits from crypto.getRandomValues.
 */
export const API_TOKEN_PREFIX = "erainfra_";
const TOKEN_PATTERN = /^erainfra_[0-9a-f]{64}$/;

/** How many leading characters of a token the dashboard shows to tell tokens apart. */
export const API_TOKEN_HINT_LENGTH = API_TOKEN_PREFIX.length + 8;

/**
 * `lastUsedAt` is written at most once per this interval per token. Writing it
 * on every request would turn each read, and each 15-second scrape, into a
 * write on the token's row.
 */
export const LAST_USED_RESOLUTION_MS = 5 * 60_000;

export const MAX_API_TOKEN_NAME_LENGTH = 100;

export function newApiToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `${API_TOKEN_PREFIX}${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function isWellFormedApiToken(token: string) {
  return TOKEN_PATTERN.test(token);
}

/**
 * Only this digest is stored. The token carries 256 random bits, so a plain
 * SHA-256 is enough: a slow password hash protects low-entropy secrets, and
 * there is nothing here for it to stretch.
 */
export async function hashApiToken(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The token from an `Authorization: Bearer <token>` header, or null when the
 * header is absent or is not a bearer credential. The scheme is matched
 * case-insensitively, as RFC 9110 requires.
 */
export function bearerToken(header: string | null) {
  if (header === null) return null;
  const match = /^Bearer[ ]+(\S+)[ ]*$/i.exec(header);
  return match === null ? null : match[1];
}

export function normalizeApiTokenName(name: string) {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_API_TOKEN_NAME_LENGTH) {
    return null;
  }
  return trimmed;
}

/** Whether a token of scope `granted` may use a route that needs `needed`. */
export function scopeAllows(granted: ApiTokenScope, needed: ApiTokenScope) {
  switch (needed) {
    case "metrics":
      return true;
    case "read":
      return granted === "read" || granted === "admin";
    case "admin":
      return granted === "admin";
  }
}

export function shouldTouchLastUsed(lastUsedAt: number | undefined, now: number) {
  return lastUsedAt === undefined || now - lastUsedAt >= LAST_USED_RESOLUTION_MS;
}
