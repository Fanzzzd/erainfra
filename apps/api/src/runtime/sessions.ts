// Browser sessions: an opaque 256-bit token in an HttpOnly cookie, stored HASHED at rest (a leaked
// sessions.json must not be a bag of valid cookies). Sliding 30-day expiry, revocable per session.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

function persistDefault(envVar: string | undefined): string | undefined {
  return (process.execArgv.includes('--test') || !!process.env.NODE_TEST_CONTEXT) ? undefined : (envVar ?? join(tmpdir(), 'portless-runtime', 'sessions.json'));
}

const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export interface Session {
  id: string;
  tokenHash: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  userAgent?: string;
}

export class SessionStore {
  private byHash = new Map<string, Session>();
  private persistPath?: string;

  constructor(persistPath: string | undefined = persistDefault(process.env.PORTLESS_SESSIONS_FILE)) {
    this.persistPath = persistPath;
    this.load();
  }

  private load(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.persistPath, 'utf8')) as { sessions?: Session[] };
      for (const s of raw.sessions ?? []) this.byHash.set(s.tokenHash, s);
    } catch (e) {
      console.error('[sessions] failed to load:', (e as Error).message);
    }
  }

  private save(): void {
    if (!this.persistPath) return;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      const tmp = `${this.persistPath}.tmp`;
      writeFileSync(tmp, JSON.stringify({ sessions: [...this.byHash.values()] }, null, 2), { mode: 0o600 });
      renameSync(tmp, this.persistPath);
    } catch (e) {
      console.error('[sessions] failed to persist:', (e as Error).message);
    }
  }

  create(userId: string, userAgent?: string): { token: string; session: Session } {
    this.prune();
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    const session: Session = {
      id: randomUUID(),
      tokenHash: sha256(token),
      userId,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + TTL_MS).toISOString(),
      lastSeenAt: now.toISOString(),
      userAgent: userAgent?.slice(0, 256),
    };
    this.byHash.set(session.tokenHash, session);
    this.save();
    return { token, session };
  }

  // Resolve a cookie token to its session, sliding the expiry forward (persisted lazily: at most
  // once a minute per session, so a busy dashboard doesn't rewrite the file on every request).
  resolve(token: string | undefined): Session | null {
    if (!token) return null;
    const s = this.byHash.get(sha256(token));
    if (!s) return null;
    const now = Date.now();
    if (now > Date.parse(s.expiresAt)) {
      this.byHash.delete(s.tokenHash);
      this.save();
      return null;
    }
    if (now - Date.parse(s.lastSeenAt) > 60_000) {
      s.lastSeenAt = new Date(now).toISOString();
      s.expiresAt = new Date(now + TTL_MS).toISOString();
      this.save();
    }
    return s;
  }

  revokeByToken(token: string): boolean {
    const ok = this.byHash.delete(sha256(token));
    if (ok) this.save();
    return ok;
  }

  revokeById(id: string): boolean {
    for (const [h, s] of this.byHash) {
      if (s.id === id) {
        this.byHash.delete(h);
        this.save();
        return true;
      }
    }
    return false;
  }

  revokeAllForUser(userId: string): number {
    let n = 0;
    for (const [h, s] of this.byHash) if (s.userId === userId) { this.byHash.delete(h); n++; }
    if (n) this.save();
    return n;
  }

  listForUser(userId: string): Array<Omit<Session, 'tokenHash'>> {
    return [...this.byHash.values()].filter((s) => s.userId === userId).map(({ tokenHash: _t, ...s }) => s);
  }

  private prune(): void {
    const now = Date.now();
    let changed = false;
    for (const [h, s] of this.byHash) if (now > Date.parse(s.expiresAt)) { this.byHash.delete(h); changed = true; }
    if (changed) this.save();
  }
}

export const sessionStore = new SessionStore();
