// Per-app environment variables / secrets, encrypted at rest (AES-256-GCM). Injected into the
// container on deploy as `-e KEY=VALUE`. Self-hosted: the encryption key is yours (PORTLESS_SECRET_KEY
// or a generated 0600 key file), nothing leaves the hub. Ciphertext blobs live in the SQLite DB;
// the KEY deliberately lives in a separate file so a copied database alone can't be decrypted.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { db, stateDir } from "../db.ts";
import { renamedEnv } from "../env.ts";

// 32-byte key: PORTLESS_SECRET_KEY (64 hex) wins; else a generated key persisted 0600; ephemeral
// under --test so tests never touch disk.
function loadKey(): Buffer {
  const hex = renamedEnv("ERAINFRA_SECRET_KEY", "PORTLESS_SECRET_KEY");
  if (hex && /^[0-9a-fA-F]{64}$/.test(hex)) return Buffer.from(hex, "hex");
  if (process.execArgv.includes("--test") || !!process.env.NODE_TEST_CONTEXT)
    return randomBytes(32);
  const keyPath =
    renamedEnv("ERAINFRA_SECRET_KEY_FILE", "PORTLESS_SECRET_KEY_FILE") ??
    join(stateDir(), "secret.key");
  try {
    if (existsSync(keyPath)) return Buffer.from(readFileSync(keyPath, "utf8").trim(), "hex");
    mkdirSync(dirname(keyPath), { recursive: true });
    const key = randomBytes(32);
    writeFileSync(keyPath, key.toString("hex"), { mode: 0o600 });
    chmodSync(keyPath, 0o600);
    return key;
  } catch {
    return randomBytes(32); // last resort: ephemeral (values won't survive restart, but never crash)
  }
}

// blob = ivHex:tagHex:ctHex. Fresh 12-byte nonce per encryption (GCM nonce reuse would be fatal).
function enc(key: Buffer, plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `${iv.toString("hex")}:${c.getAuthTag().toString("hex")}:${ct.toString("hex")}`;
}
function dec(key: Buffer, blob: string): string {
  const [ivh, tagh, cth] = blob.split(":");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(ivh, "hex"));
  d.setAuthTag(Buffer.from(tagh, "hex"));
  return Buffer.concat([d.update(Buffer.from(cth, "hex")), d.final()]).toString("utf8");
}

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/; // valid env var name

export class SecretStore {
  private key = loadKey();

  private d: DatabaseSync;

  constructor(d: DatabaseSync = db) {
    this.d = d;
  }

  // Set/overwrite multiple vars for an app. Validates ALL names first — an invalid one applies nothing.
  setMany(app: string, vars: Record<string, string>): void {
    for (const k of Object.keys(vars)) {
      if (!KEY_RE.test(k)) throw new Error(`invalid env var name: ${k}`);
    }
    for (const [k, v] of Object.entries(vars)) {
      this.d
        .prepare(
          "INSERT INTO secrets (app, key, blob) VALUES (?, ?, ?) ON CONFLICT(app, key) DO UPDATE SET blob = excluded.blob",
        )
        .run(app, k, enc(this.key, v));
    }
  }

  unset(app: string, key: string): boolean {
    return (
      this.d.prepare("DELETE FROM secrets WHERE app = ? AND key = ?").run(app, key).changes > 0
    );
  }

  // Decrypted vars for injection at deploy time.
  get(app: string): Record<string, string> {
    const rows = this.d
      .prepare("SELECT key, blob FROM secrets WHERE app = ?")
      .all(app) as unknown as Array<{ key: string; blob: string }>;
    return Object.fromEntries(rows.map((r) => [r.key, dec(this.key, r.blob)]));
  }

  // Masked view for the dashboard/API — never returns plaintext (secrets.read could be broad).
  list(app: string): Array<{ key: string; preview: string }> {
    return (
      this.d
        .prepare("SELECT key FROM secrets WHERE app = ? ORDER BY key")
        .all(app) as unknown as Array<{ key: string }>
    ).map((r) => ({ key: r.key, preview: "••••••" }));
  }
}

export const secretStore = new SecretStore();
