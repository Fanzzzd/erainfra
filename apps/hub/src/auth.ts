import type { Role } from "./rbac.ts";
import { userStore, type UserStore } from "./runtime/users.ts";
import { sessionStore, type SessionStore } from "./runtime/sessions.ts";
import { apiTokenStore, type ApiTokenStore } from "./runtime/apitokens.ts";

export interface Principal {
  id: string;
  name: string;
  roles: Role[];
}

export interface TokenStore {
  resolve(token: string | undefined): Principal | null;
}

// Static bearer-token table. Still the seam tests inject through, and the PORTLESS_DEV_TOKENS
// escape hatch for bootstrap/dev — but real deployments now authenticate with user sessions and
// revocable API tokens (see resolveRequestAuth below).
export class StaticTokenStore implements TokenStore {
  private readonly tokens: Map<string, Principal>;
  constructor(entries: Record<string, Principal>) {
    this.tokens = new Map(Object.entries(entries));
  }
  resolve(token: string | undefined): Principal | null {
    if (!token) return null;
    return this.tokens.get(token) ?? null;
  }
}

// Default dev tokens. Override in real deployments via PORTLESS_DEV_TOKENS (JSON: token -> principal).
export function devTokenStore(): StaticTokenStore {
  const fromEnv = process.env.PORTLESS_DEV_TOKENS;
  if (fromEnv) return new StaticTokenStore(JSON.parse(fromEnv));
  return new StaticTokenStore({
    "owner-dev-token": { id: "u-owner", name: "Dev Owner", roles: ["owner"] },
    "viewer-dev-token": { id: "u-viewer", name: "Dev Viewer", roles: ["viewer"] },
  });
}

// Fail closed: the bundled owner/viewer dev tokens must NOT be accepted in production (they
// would let anyone reaching the API perform real deploy mutations). In production, dev tokens
// exist only when explicitly supplied via PORTLESS_DEV_TOKENS or opted into with PORTLESS_DEV_AUTH=1.
// Local dev (NODE_ENV unset) keeps them so the dashboard works out of the box.
export function defaultTokenStore(): TokenStore {
  if (process.env.PORTLESS_DEV_TOKENS)
    return new StaticTokenStore(JSON.parse(process.env.PORTLESS_DEV_TOKENS));
  if (process.env.NODE_ENV === "production" && process.env.PORTLESS_DEV_AUTH !== "1") {
    return new StaticTokenStore({});
  }
  return devTokenStore();
}

export const SESSION_COOKIE = "portless_session";

export interface AuthStores {
  users: Pick<UserStore, "get">;
  sessions: Pick<SessionStore, "resolve">;
  apiTokens: Pick<ApiTokenStore, "resolve">;
  legacy: TokenStore;
}

export const defaultAuthStores = (legacy: TokenStore): AuthStores => ({
  users: userStore,
  sessions: sessionStore,
  apiTokens: apiTokenStore,
  legacy,
});

// THE authentication decision for every request, in order:
//   1. session cookie (the dashboard) → the logged-in user's identity
//   2. "plt_" bearer token (CLI / agents / CI) → the token's identity + roles
//   3. legacy static bearer token (dev / bootstrap only)
export function resolveRequestAuth(
  req: { headers: { authorization?: string | string[]; cookie?: string } },
  stores: AuthStores,
): Principal | null {
  const cookie = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (cookie) {
    const session = stores.sessions.resolve(cookie);
    if (session) {
      const user = stores.users.get(session.userId);
      if (user) return { id: user.id, name: user.name, roles: user.roles };
    }
  }
  const bearer = bearerToken(req.headers.authorization);
  if (bearer) {
    const t = stores.apiTokens.resolve(bearer);
    if (t) return { id: `token:${t.id}`, name: t.name, roles: t.roles };
    return stores.legacy.resolve(bearer);
  }
  return null;
}

export function bearerToken(authorization: string | string[] | undefined): string | undefined {
  const header = Array.isArray(authorization) ? authorization[0] : authorization;
  return header?.startsWith("Bearer ") ? header.slice(7) : undefined;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

// Login throttle: 5 failures per identity+IP in 15 minutes, then 429. In-memory — a hub restart
// resets it, which is fine (the cost of a restart dwarfs a brute-force benefit).
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 5;

export class LoginRateLimiter {
  private fails = new Map<string, { count: number; firstAt: number }>();

  check(key: string): { allowed: boolean; retryAfterSec: number } {
    const f = this.fails.get(key);
    if (!f) return { allowed: true, retryAfterSec: 0 };
    if (Date.now() - f.firstAt > WINDOW_MS) {
      this.fails.delete(key);
      return { allowed: true, retryAfterSec: 0 };
    }
    if (f.count < MAX_FAILS) return { allowed: true, retryAfterSec: 0 };
    return {
      allowed: false,
      retryAfterSec: Math.ceil((f.firstAt + WINDOW_MS - Date.now()) / 1000),
    };
  }

  fail(key: string): void {
    const f = this.fails.get(key);
    if (!f || Date.now() - f.firstAt > WINDOW_MS)
      this.fails.set(key, { count: 1, firstAt: Date.now() });
    else f.count++;
  }

  clear(key: string): void {
    this.fails.delete(key);
  }
}
