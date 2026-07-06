// Real user accounts with password login (the Dokploy/Portainer model): the FIRST account is
// created through a one-time setup flow and owns the instance; more users can be added later.
// Passwords are scrypt-hashed (node:crypto, OWASP params) with a per-user salt and verified in
// constant time; the store never holds a plaintext or reversible password.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Role } from '../rbac.ts';

function persistDefault(envVar: string | undefined): string | undefined {
  return (process.execArgv.includes('--test') || !!process.env.NODE_TEST_CONTEXT) ? undefined : (envVar ?? join(tmpdir(), 'portless-runtime', 'users.json'));
}

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

const publicView = ({ passwordHash: _ph, ...u }: User): PublicUser => u;

export class UserStore {
  private byId = new Map<string, User>();
  private persistPath?: string;

  constructor(persistPath: string | undefined = persistDefault(process.env.PORTLESS_USERS_FILE)) {
    this.persistPath = persistPath;
    this.load();
  }

  private load(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.persistPath, 'utf8')) as { users?: User[] };
      for (const u of raw.users ?? []) this.byId.set(u.id, u);
    } catch (e) {
      console.error('[users] failed to load:', (e as Error).message);
    }
  }

  private save(): void {
    if (!this.persistPath) return;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      const tmp = `${this.persistPath}.tmp`;
      writeFileSync(tmp, JSON.stringify({ users: [...this.byId.values()] }, null, 2), { mode: 0o600 });
      renameSync(tmp, this.persistPath);
    } catch (e) {
      console.error('[users] failed to persist:', (e as Error).message);
    }
  }

  count(): number {
    return this.byId.size;
  }

  list(): PublicUser[] {
    return [...this.byId.values()].map(publicView);
  }

  get(id: string): PublicUser | undefined {
    const u = this.byId.get(id);
    return u && publicView(u);
  }

  findByEmail(email: string): User | undefined {
    const e = email.trim().toLowerCase();
    return [...this.byId.values()].find((u) => u.email === e);
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
    this.byId.set(user.id, user);
    this.save();
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
    const u = this.byId.get(id);
    if (!u) return { ok: false, error: 'no such user' };
    const email = newEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: 'not a valid email address' };
    const existing = this.findByEmail(email);
    if (existing && existing.id !== id) return { ok: false, error: 'an account with this email already exists' };
    u.email = email;
    this.save();
    return { ok: true, user: publicView(u) };
  }

  setPassword(id: string, newPassword: string): { ok: true } | { ok: false; error: string } {
    const u = this.byId.get(id);
    if (!u) return { ok: false, error: 'no such user' };
    if (newPassword.length < 8) return { ok: false, error: 'password must be at least 8 characters' };
    u.passwordHash = hashPassword(newPassword);
    this.save();
    return { ok: true };
  }

  remove(id: string): { ok: true } | { ok: false; error: string } {
    const u = this.byId.get(id);
    if (!u) return { ok: false, error: 'no such user' };
    // Never delete the last owner — that would brick the instance.
    if (u.roles.includes('owner') && [...this.byId.values()].filter((x) => x.roles.includes('owner')).length === 1) {
      return { ok: false, error: 'cannot remove the last owner account' };
    }
    this.byId.delete(id);
    this.save();
    return { ok: true };
  }
}

const DUMMY_HASH = hashPassword('dummy-timing-equalizer');

export const userStore = new UserStore();
