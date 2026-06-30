// Per-app environment variables / secrets, encrypted at rest (AES-256-GCM). Injected into the
// container on deploy as `-e KEY=VALUE`. Self-hosted: the encryption key is yours (PORTLESS_SECRET_KEY
// or a generated 0600 key file), nothing leaves the hub.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const stateDir = () => join(tmpdir(), 'portless-runtime');
function persistDefault(envVar: string | undefined): string | undefined {
  return (process.execArgv.includes('--test') || !!process.env.NODE_TEST_CONTEXT) ? undefined : envVar; // hermetic under the test runner
}

// 32-byte key: PORTLESS_SECRET_KEY (64 hex) wins; else a generated key persisted 0600; ephemeral
// under --test so tests never touch disk.
function loadKey(): Buffer {
  const hex = process.env.PORTLESS_SECRET_KEY;
  if (hex && /^[0-9a-fA-F]{64}$/.test(hex)) return Buffer.from(hex, 'hex');
  if ((process.execArgv.includes('--test') || !!process.env.NODE_TEST_CONTEXT)) return randomBytes(32);
  const keyPath = process.env.PORTLESS_SECRET_KEY_FILE ?? join(stateDir(), 'secret.key');
  try {
    if (existsSync(keyPath)) return Buffer.from(readFileSync(keyPath, 'utf8').trim(), 'hex');
    mkdirSync(dirname(keyPath), { recursive: true });
    const key = randomBytes(32);
    writeFileSync(keyPath, key.toString('hex'), { mode: 0o600 });
    chmodSync(keyPath, 0o600);
    return key;
  } catch {
    return randomBytes(32); // last resort: ephemeral (values won't survive restart, but never crash)
  }
}

// blob = ivHex:tagHex:ctHex. Fresh 12-byte nonce per encryption (GCM nonce reuse would be fatal).
function enc(key: Buffer, plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `${iv.toString('hex')}:${c.getAuthTag().toString('hex')}:${ct.toString('hex')}`;
}
function dec(key: Buffer, blob: string): string {
  const [ivh, tagh, cth] = blob.split(':');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(ivh, 'hex'));
  d.setAuthTag(Buffer.from(tagh, 'hex'));
  return Buffer.concat([d.update(Buffer.from(cth, 'hex')), d.final()]).toString('utf8');
}

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/; // valid env var name

export class SecretStore {
  private key = loadKey();
  private byApp = new Map<string, Map<string, string>>(); // app -> key -> encrypted blob
  private persistPath?: string;

  constructor(persistPath: string | undefined = persistDefault(process.env.PORTLESS_SECRETS_FILE ?? join(stateDir(), 'secrets.json'))) {
    this.persistPath = persistPath;
    this.load();
  }

  private load(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.persistPath, 'utf8')) as Record<string, Record<string, string>>;
      for (const [app, kv] of Object.entries(raw)) this.byApp.set(app, new Map(Object.entries(kv)));
    } catch (e) {
      console.error('[secrets] failed to load:', (e as Error).message);
    }
  }

  private save(): void {
    if (!this.persistPath) return;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      const obj: Record<string, Record<string, string>> = {};
      for (const [app, kv] of this.byApp) obj[app] = Object.fromEntries(kv);
      const tmp = `${this.persistPath}.tmp`;
      writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
      renameSync(tmp, this.persistPath);
    } catch (e) {
      console.error('[secrets] failed to persist:', (e as Error).message);
    }
  }

  // Set/overwrite multiple vars for an app. Throws on an invalid key name.
  setMany(app: string, vars: Record<string, string>): void {
    const m = this.byApp.get(app) ?? new Map<string, string>();
    for (const [k, v] of Object.entries(vars)) {
      if (!KEY_RE.test(k)) throw new Error(`invalid env var name: ${k}`);
      m.set(k, enc(this.key, v));
    }
    this.byApp.set(app, m);
    this.save();
  }

  unset(app: string, key: string): boolean {
    const m = this.byApp.get(app);
    const ok = m?.delete(key) ?? false;
    if (ok) this.save();
    return ok;
  }

  // Decrypted vars for injection at deploy time.
  get(app: string): Record<string, string> {
    const m = this.byApp.get(app);
    if (!m) return {};
    return Object.fromEntries([...m].map(([k, blob]) => [k, dec(this.key, blob)]));
  }

  // Masked view for the dashboard/API — never returns plaintext (secrets.read could be broad).
  list(app: string): Array<{ key: string; preview: string }> {
    const m = this.byApp.get(app);
    if (!m) return [];
    return [...m.keys()].sort().map((key) => ({ key, preview: '••••••' }));
  }

}

export const secretStore = new SecretStore();
