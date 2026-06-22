// Secret storage with rotation + backup/restore (M10).
// Secrets are stored as ciphertext only. The Cipher is a seam: the dev cipher is
// reversible obfuscation (NOT secure) — wire it to KMS / age / sops in production.

export interface Cipher {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
}

// ponytail: base64 is obfuscation, not encryption. Swap for a real Cipher (KMS/age) in prod.
export class DevCipher implements Cipher {
  encrypt(plaintext: string): string {
    return Buffer.from(plaintext, 'utf8').toString('base64');
  }
  decrypt(ciphertext: string): string {
    return Buffer.from(ciphertext, 'base64').toString('utf8');
  }
}

export interface SecretVersion {
  version: number;
  ciphertext: string;
  createdAt: string;
}

interface SecretRecord {
  current: number;
  versions: SecretVersion[];
}

export type SecretBackup = Record<string, SecretRecord>;

export class SecretStore {
  private records = new Map<string, SecretRecord>();
  private cipher: Cipher;
  constructor(cipher: Cipher = new DevCipher()) {
    this.cipher = cipher;
  }

  set(name: string, plaintext: string): SecretVersion {
    // Re-setting an existing secret appends a version (never silently drops history).
    if (this.records.has(name)) return this.rotate(name, plaintext);
    const version: SecretVersion = { version: 1, ciphertext: this.cipher.encrypt(plaintext), createdAt: new Date().toISOString() };
    this.records.set(name, { current: 1, versions: [version] });
    return version;
  }

  // Rotate keeps old versions so a bad rotation can be rolled back.
  rotate(name: string, newPlaintext: string): SecretVersion {
    const rec = this.records.get(name);
    if (!rec) return this.set(name, newPlaintext);
    const next = rec.versions[rec.versions.length - 1].version + 1;
    const version: SecretVersion = { version: next, ciphertext: this.cipher.encrypt(newPlaintext), createdAt: new Date().toISOString() };
    rec.versions.push(version);
    rec.current = next;
    return version;
  }

  get(name: string): string {
    const rec = this.records.get(name);
    if (!rec) throw new Error(`unknown secret: ${name}`);
    const v = rec.versions.find((x) => x.version === rec.current)!;
    return this.cipher.decrypt(v.ciphertext);
  }

  versions(name: string): SecretVersion[] {
    // Clone so callers can't mutate internal history.
    return structuredClone(this.records.get(name)?.versions ?? []);
  }

  rollback(name: string, version: number): void {
    const rec = this.records.get(name);
    if (!rec || !rec.versions.some((v) => v.version === version)) throw new Error(`no version ${version} for ${name}`);
    rec.current = version;
  }

  // --- backup/restore: ciphertext-only snapshot, safe to store off-box ---
  export(): SecretBackup {
    return Object.fromEntries([...this.records.entries()].map(([k, v]) => [k, structuredClone(v)]));
  }

  static restore(backup: SecretBackup, cipher: Cipher = new DevCipher()): SecretStore {
    const store = new SecretStore(cipher);
    for (const [name, rec] of Object.entries(backup)) store.records.set(name, structuredClone(rec));
    return store;
  }
}
