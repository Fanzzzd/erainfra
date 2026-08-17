// Browser sessions: an opaque 256-bit token in an HttpOnly cookie, stored HASHED at rest (a leaked
// database must not be a bag of valid cookies). Sliding 30-day expiry, revocable per session.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { db } from "../db.ts";

const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export interface Session {
  id: string;
  tokenHash: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  userAgent?: string;
}

interface Row {
  token_hash: string;
  id: string;
  user_id: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
  user_agent: string | null;
}

const toSession = (r: Row): Session => ({
  id: r.id,
  tokenHash: r.token_hash,
  userId: r.user_id,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  lastSeenAt: r.last_seen_at,
  userAgent: r.user_agent ?? undefined,
});

export class SessionStore {
  private d: DatabaseSync;

  constructor(d: DatabaseSync = db) {
    this.d = d;
  }

  create(userId: string, userAgent?: string): { token: string; session: Session } {
    this.d.prepare("DELETE FROM sessions WHERE expires_at < ?").run(new Date().toISOString()); // prune expired
    const token = randomBytes(32).toString("base64url");
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
    this.d
      .prepare(
        "INSERT INTO sessions (token_hash, id, user_id, created_at, expires_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        session.tokenHash,
        session.id,
        session.userId,
        session.createdAt,
        session.expiresAt,
        session.lastSeenAt,
        session.userAgent ?? null,
      );
    return { token, session };
  }

  // Resolve a cookie token to its session, sliding the expiry forward (written at most once a
  // minute per session, so a busy dashboard doesn't rewrite the row on every request).
  resolve(token: string | undefined): Session | null {
    if (!token) return null;
    const r = this.d.prepare("SELECT * FROM sessions WHERE token_hash = ?").get(sha256(token)) as
      | Row
      | undefined;
    if (!r) return null;
    const s = toSession(r);
    const now = Date.now();
    if (now > Date.parse(s.expiresAt)) {
      this.d.prepare("DELETE FROM sessions WHERE token_hash = ?").run(s.tokenHash);
      return null;
    }
    if (now - Date.parse(s.lastSeenAt) > 60_000) {
      s.lastSeenAt = new Date(now).toISOString();
      s.expiresAt = new Date(now + TTL_MS).toISOString();
      this.d
        .prepare("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?")
        .run(s.lastSeenAt, s.expiresAt, s.tokenHash);
    }
    return s;
  }

  revokeByToken(token: string): boolean {
    return (
      this.d.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token)).changes > 0
    );
  }

  revokeById(id: string): boolean {
    return this.d.prepare("DELETE FROM sessions WHERE id = ?").run(id).changes > 0;
  }

  revokeAllForUser(userId: string): number {
    return Number(this.d.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId).changes);
  }

  listForUser(userId: string): Array<Omit<Session, "tokenHash">> {
    return (
      this.d
        .prepare("SELECT * FROM sessions WHERE user_id = ? ORDER BY created_at")
        .all(userId) as unknown as Row[]
    ).map((r) => {
      const { tokenHash: _t, ...s } = toSession(r);
      return s;
    });
  }
}

export const sessionStore = new SessionStore();
