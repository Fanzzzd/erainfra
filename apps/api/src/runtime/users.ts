// Real user accounts with password login (the Dokploy/Portainer model): the FIRST account is
// created through a one-time setup flow and owns the instance; more users can be added later.
// Passwords are scrypt-hashed (node:crypto, OWASP params) with a per-user salt and verified in
// constant time; the store never holds a plaintext or reversible password. Rows live in the
// control-plane SQLite DB (src/db.ts).
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { db } from '../db.ts';
import type { Role } from '../rbac.ts';

export interface User {
  id: string;
  email: string;
  name: string;
  roles: Role[];
  passwordHash: string; // "scrypt$N$r$p$<salt b64>$<hash b64>"
  createdAt: string;
}

export type PublicUser = Omit<User, 'passwordHash'>;

// OWASP-recommended interactive scrypt parameters. Encoded into the hash string so they can be
// raised later without invalidating existing accounts.
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 64 };

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 128 * SCRYPT.N * SCRYPT.r * 2 });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, N, r, p, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: 128 * Number(N) * Number(r) * 2,
  });
  return timingSafeEqual(actual, expected);
}

interface Row {
  id: string;
  email: string;
  name: string;
  roles: string;
  password_hash: string;
  created_at: string;
}

const toUser = (r: Row): User => ({ id: r.id, email: r.email, name: r.name, roles: JSON.parse(r.roles) as Role[], passwordHash: r.password_hash, createdAt: r.created_at });
const publicView = ({ passwordHash: _ph, ...u }: User): PublicUser => u;

export class UserStore {
  private d: DatabaseSync;

  constructor(d: DatabaseSync = db) {
    this.d = d;
  }

  count(): number {
    return Number((this.d.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n);
  }

  list(): PublicUser[] {
    return (this.d.prepare('SELECT * FROM users ORDER BY created_at').all() as unknown as Row[]).map((r) => publicView(toUser(r)));
  }

  get(id: string): PublicUser | undefined {
    const r = this.d.prepare('SELECT * FROM users WHERE id = ?').get(id) as Row | undefined;
    return r && publicView(toUser(r));
  }

  findByEmail(email: string): User | undefined {
    const r = this.d.prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase()) as Row | undefined;
    return r && toUser(r);
  }

  create(input: { email: string; password: string; name?: string; roles: Role[] }): { ok: true; user: PublicUser } | { ok: false; error: string } {
    const email = input.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: 'not a valid email address' };
    if (input.password.length < 8) return { ok: false, error: 'password must be at least 8 characters' };
    if (this.findByEmail(email)) return { ok: false, error: 'an account with this email already exists' };
    const user: User = {
      id: randomUUID(),
      email,
      name: input.name?.trim() || email.split('@')[0],
      roles: input.roles,
      passwordHash: hashPassword(input.password),
      createdAt: new Date().toISOString(),
    };
    this.d.prepare('INSERT INTO users (id, email, name, roles, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(user.id, user.email, user.name, JSON.stringify(user.roles), user.passwordHash, user.createdAt);
    return { ok: true, user: publicView(user) };
  }

  // Returns the user on a correct email+password pair; null otherwise (indistinguishable whether
  // the email exists — a dummy verify keeps timing flat for unknown emails).
  verify(email: string, password: string): PublicUser | null {
    const u = this.findByEmail(email);
    if (!u) {
      verifyPassword(password, DUMMY_HASH);
      return null;
    }
    return verifyPassword(password, u.passwordHash) ? publicView(u) : null;
  }

  // Everything references users by id (sessions, tokens, audit), so an email change is just this
  // record — nothing else to rewrite.
  updateEmail(id: string, newEmail: string): { ok: true; user: PublicUser } | { ok: false; error: string } {
    const r = this.d.prepare('SELECT * FROM users WHERE id = ?').get(id) as Row | undefined;
    if (!r) return { ok: false, error: 'no such user' };
    const email = newEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: 'not a valid email address' };
    const existing = this.findByEmail(email);
    if (existing && existing.id !== id) return { ok: false, error: 'an account with this email already exists' };
    this.d.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, id);
    return { ok: true, user: publicView(toUser({ ...r, email })) };
  }

  setPassword(id: string, newPassword: string): { ok: true } | { ok: false; error: string } {
    if (newPassword.length < 8) return { ok: false, error: 'password must be at least 8 characters' };
    const changed = this.d.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), id).changes;
    return changed ? { ok: true } : { ok: false, error: 'no such user' };
  }

  remove(id: string): { ok: true } | { ok: false; error: string } {
    const r = this.d.prepare('SELECT * FROM users WHERE id = ?').get(id) as Row | undefined;
    if (!r) return { ok: false, error: 'no such user' };
    const u = toUser(r);
    // Never delete the last owner — that would brick the instance.
    if (u.roles.includes('owner')) {
      const owners = (this.d.prepare('SELECT roles FROM users').all() as unknown as Array<{ roles: string }>)
        .filter((x) => (JSON.parse(x.roles) as Role[]).includes('owner')).length;
      if (owners === 1) return { ok: false, error: 'cannot remove the last owner account' };
    }
    this.d.prepare('DELETE FROM users WHERE id = ?').run(id);
    return { ok: true };
  }
}

const DUMMY_HASH = hashPassword('dummy-timing-equalizer');

export const userStore = new UserStore();
