import type { Role } from './rbac.ts';

export interface Principal {
  id: string;
  name: string;
  roles: Role[];
}

export interface TokenStore {
  resolve(token: string | undefined): Principal | null;
}

// ponytail: static bearer-token table for dev/CI. Swap for sessions + OIDC at the
// Postgres/auth layer (M10) — the TokenStore interface is the seam.
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
    'owner-dev-token': { id: 'u-owner', name: 'Dev Owner', roles: ['owner'] },
    'viewer-dev-token': { id: 'u-viewer', name: 'Dev Viewer', roles: ['viewer'] },
  });
}

// Fail closed: the bundled owner/viewer dev tokens must NOT be accepted in production (they
// would let anyone reaching the API perform real Cloudflare/deploy mutations). In production,
// require real tokens via PORTLESS_DEV_TOKENS, or opt in explicitly with PORTLESS_DEV_AUTH=1.
// Local dev (NODE_ENV unset) keeps the dev tokens so the dashboard works out of the box.
export function defaultTokenStore(): TokenStore {
  if (process.env.PORTLESS_DEV_TOKENS) return new StaticTokenStore(JSON.parse(process.env.PORTLESS_DEV_TOKENS));
  if (process.env.NODE_ENV === 'production' && process.env.PORTLESS_DEV_AUTH !== '1') {
    console.warn('[auth] production mode: bundled dev tokens disabled. Set PORTLESS_DEV_TOKENS or PORTLESS_DEV_AUTH=1.');
    return new StaticTokenStore({});
  }
  return devTokenStore();
}
