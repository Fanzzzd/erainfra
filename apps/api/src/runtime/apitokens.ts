// API tokens: long-lived bearer credentials for the CLI, agents (node enrollment), and CI. Shown
// ONCE at creation ("plt_" prefix + 32 hex), stored hashed, revocable individually — replaces the
// old shared-secret PORTLESS_DEV_TOKENS env for day-to-day use.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Role } from '../rbac.ts';

function persistDefault(envVar: string | undefined): string | undefined {
  return (process.execArgv.includes('--test') || !!process.env.NODE_TEST_CONTEXT) ? undefined : (envVar ?? join(tmpdir(), 'portless-runtime', 'apitokens.json'));
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export interface ApiToken {
  id: string;
  name: string; // human label: "cli @macbook", "node work-remote"
  hash: string;
  prefix: string; // first 12 chars, for recognizing a token without storing it
  roles: Role[];
  createdBy: string; // user id (or "system" for bootstrap)
  createdAt: string;
  lastUsedAt?: string;
}

export type PublicApiToken = Omit<ApiToken, 'hash'>;

export class ApiTokenStore {
  private byHash = new Map<string, ApiToken>();
  private persistPath?: string;

  constructor(persistPath: string | undefined = persistDefault(process.env.PORTLESS_APITOKENS_FILE)) {
    this.persistPath = persistPath;
    this.load();
  }

  private load(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.persistPath, 'utf8')) as { tokens?: ApiToken[] };
      for (const t of raw.tokens ?? []) this.byHash.set(t.hash, t);
    } catch (e) {
      console.error('[apitokens] failed to load:', (e as Error).message);
    }
  }

  private save(): void {
    if (!this.persistPath) return;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      const tmp = `${this.persistPath}.tmp`;
      writeFileSync(tmp, JSON.stringify({ tokens: [...this.byHash.values()] }, null, 2), { mode: 0o600 });
      renameSync(tmp, this.persistPath);
    } catch (e) {
      console.error('[apitokens] failed to persist:', (e as Error).message);
    }
  }

  create(input: { name: string; roles: Role[]; createdBy: string }): { token: string; record: PublicApiToken } {
    const token = `plt_${randomBytes(24).toString('hex')}`;
    const record: ApiToken = {
      id: randomUUID(),
      name: input.name.slice(0, 64),
      hash: sha256(token),
      prefix: token.slice(0, 12),
      roles: input.roles,
      createdBy: input.createdBy,
      createdAt: new Date().toISOString(),
    };
    this.byHash.set(record.hash, record);
    this.save();
    const { hash: _h, ...pub } = record;
    return { token, record: pub };
  }

  // Resolve a presented bearer token. lastUsedAt is persisted lazily (once a minute) so agent
  // traffic doesn't hammer the file.
  resolve(token: string | undefined): ApiToken | null {
    if (!token?.startsWith('plt_')) return null;
    const t = this.byHash.get(sha256(token));
    if (!t) return null;
    const now = Date.now();
    if (!t.lastUsedAt || now - Date.parse(t.lastUsedAt) > 60_000) {
      t.lastUsedAt = new Date(now).toISOString();
      this.save();
    }
    return t;
  }

  revoke(id: string): boolean {
    for (const [h, t] of this.byHash) {
      if (t.id === id) {
        this.byHash.delete(h);
        this.save();
        return true;
      }
    }
    return false;
  }

  list(): PublicApiToken[] {
    return [...this.byHash.values()].map(({ hash: _h, ...t }) => t);
  }
}

export const apiTokenStore = new ApiTokenStore();
