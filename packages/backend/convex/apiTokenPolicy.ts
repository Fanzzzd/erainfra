// Pure rules for operator API tokens, kept free of Convex bindings so they can
// be unit tested directly, the same way authPolicy.ts and bootstrapPolicy.ts are.

/**
 * A token reads the fleet (`read`) or also performs the actions the dashboard
 * offers (`admin`). Two scopes rather than per-route grants: the API exposes a
 * handful of reads and one action, and a finer split would be a permission
 * system nobody asked for. Blacksmith draws the same line between a user token
 * and an org token.
 */
export type ApiTokenScope = "read" | "admin";

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
 * on every request would turn each read into a write on a hot row; a minute is
 * finer than anyone reads a "last used" column at.
 */
export const LAST_USED_RESOLUTION_MS = 60_000;

export const MAX_API_TOKEN_NAME_LENGTH = 64;

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

export function scopeAllows(granted: ApiTokenScope, needed: ApiTokenScope) {
  return needed === "read" || granted === "admin";
}

export function shouldTouchLastUsed(lastUsedAt: number | undefined, now: number) {
  return lastUsedAt === undefined || now - lastUsedAt >= LAST_USED_RESOLUTION_MS;
}
