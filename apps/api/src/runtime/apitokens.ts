// API tokens: long-lived bearer credentials for the CLI, agents (node enrollment), and CI. Shown
// ONCE at creation ("plt_" prefix), stored hashed, revocable individually.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { db } from '../db.ts';
import type { Role } from '../rbac.ts';

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

interface Row {
  hash: string;
  id: string;
  name: string;
  prefix: string;
  roles: string;
  created_by: string;
  created_at: string;
  last_used_at: string | null;
}

const toToken = (r: Row): ApiToken => ({ id: r.id, name: r.name, hash: r.hash, prefix: r.prefix, roles: JSON.parse(r.roles) as Role[], createdBy: r.created_by, createdAt: r.created_at, lastUsedAt: r.last_used_at ?? undefined });

export class ApiTokenStore {
  private d: DatabaseSync;

  constructor(d: DatabaseSync = db) {
    this.d = d;
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
    this.d.prepare('INSERT INTO api_tokens (hash, id, name, prefix, roles, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(record.hash, record.id, record.name, record.prefix, JSON.stringify(record.roles), record.createdBy, record.createdAt);
    const { hash: _h, ...pub } = record;
    return { token, record: pub };
  }

  // Resolve a presented bearer token. lastUsedAt is written at most once a minute so agent traffic
  // doesn't turn every request into an UPDATE.
  resolve(token: string | undefined): ApiToken | null {
    if (!token?.startsWith('plt_')) return null;
    const r = this.d.prepare('SELECT * FROM api_tokens WHERE hash = ?').get(sha256(token)) as Row | undefined;
    if (!r) return null;
    const t = toToken(r);
    const now = Date.now();
    if (!t.lastUsedAt || now - Date.parse(t.lastUsedAt) > 60_000) {
      t.lastUsedAt = new Date(now).toISOString();
      this.d.prepare('UPDATE api_tokens SET last_used_at = ? WHERE hash = ?').run(t.lastUsedAt, t.hash);
    }
    return t;
  }

  revoke(id: string): boolean {
    return this.d.prepare('DELETE FROM api_tokens WHERE id = ?').run(id).changes > 0;
  }

  list(): PublicApiToken[] {
    return (this.d.prepare('SELECT * FROM api_tokens ORDER BY created_at').all() as unknown as Row[])
      .map((r) => { const { hash: _h, ...t } = toToken(r); return t; });
  }
}

export const apiTokenStore = new ApiTokenStore();
