// Envelope encryption for App secrets, on WebCrypto so it runs in Convex's default runtime.
//
// The deployment master key (ERAINFRA_SECRETS_MASTER_KEY, 32 bytes as 64 hex characters) wraps
// one random data key per secret scope; each data key encrypts that scope's values. A database
// export alone therefore decrypts nothing, and rotating the master key means re-wrapping one small
// row per scope rather than re-encrypting every value. This is the layout AWS KMS and Google
// Cloud KMS recommend for application-level encryption.
//
// Everything is AES-256-GCM with a fresh 96-bit nonce per encryption. Associated data binds a
// wrapped data key to its scope and a value to its (scope, name), so swapping rows in the database
// produces a decryption failure, not another App's secret.
//
// A scope is a structured (app, service?) pair, never a joined string: App and service names may
// both contain `-`, so `web` + `api` and `web-api` would otherwise be the same scope. The
// associated data is a JSON array of the fields, which no two distinct scopes can share.

export const MASTER_KEY_ENV = "ERAINFRA_SECRETS_MASTER_KEY";

export type MasterKey = { key: CryptoKey; id: string };

/** Who may read a secret: every service of an App (`service` absent), or one service of it. */
export type SecretScope = { app: string; service?: string };

/** The scope in words, for error messages. */
export function describeScope(scope: SecretScope) {
  return scope.service === undefined
    ? `App "${scope.app}"`
    : `service "${scope.service}" of App "${scope.app}"`;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function hexToBytes(hex: string) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCodePoint(byte);
  return btoa(binary);
}

export function fromBase64(text: string) {
  return Uint8Array.from(atob(text), (char) => char.codePointAt(0)!);
}

/**
 * The master key from the environment, or a reason it is unusable. Fails closed: there is no
 * generated fallback, because a key that silently changed between deploys would make every stored
 * secret unreadable.
 */
export async function readMasterKey(
  env: Record<string, string | undefined>,
): Promise<{ ok: true; master: MasterKey } | { ok: false; reason: string }> {
  const hex = env[MASTER_KEY_ENV]?.trim();
  if (hex === undefined || hex.length === 0) {
    return { ok: false, reason: `${MASTER_KEY_ENV} is not set` };
  }
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    return { ok: false, reason: `${MASTER_KEY_ENV} must be 64 hex characters (32 bytes)` };
  }
  const raw = hexToBytes(hex.toLowerCase());
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  // A fingerprint, not the key: the first 16 hex characters of SHA-256 over a domain label and
  // the key, recorded beside every wrapped data key.
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new Uint8Array([...encoder.encode("erainfra-secrets-master-key:"), ...raw]),
    ),
  );
  return { ok: true, master: { key, id: bytesToHex(digest).slice(0, 16) } };
}

export async function requireMasterKey(env: Record<string, string | undefined>) {
  const result = await readMasterKey(env);
  if (!result.ok) throw new Error(`App secrets are unavailable: ${result.reason}`);
  return result.master;
}

async function seal(key: CryptoKey, plaintext: Uint8Array<ArrayBuffer>, aad: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(aad) },
      key,
      plaintext,
    ),
  );
  return { ciphertext: toBase64(ciphertext), iv: toBase64(iv) };
}

async function open(key: CryptoKey, sealed: { ciphertext: string; iv: string }, aad: string) {
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(sealed.iv), additionalData: encoder.encode(aad) },
      key,
      fromBase64(sealed.ciphertext),
    ),
  );
}

// JSON arrays of strings and null decode to exactly one tuple, so these encodings are injective.
const dataKeyAad = (scope: SecretScope) =>
  JSON.stringify(["erainfra/app-data-key/v2", scope.app, scope.service ?? null]);
const valueAad = (scope: SecretScope, name: string) =>
  JSON.stringify(["erainfra/app-secret/v2", scope.app, scope.service ?? null, name]);

/** A fresh data key for a scope, and its wrapped form for storage. */
export async function newDataKey(master: MasterKey, scope: SecretScope) {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const wrapped = await seal(master.key, raw, dataKeyAad(scope));
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  return { key, wrapped: { wrappedKey: wrapped.ciphertext, iv: wrapped.iv } };
}

export async function unwrapDataKey(
  master: MasterKey,
  scope: SecretScope,
  row: { wrappedKey: string; iv: string; masterKeyId: string },
) {
  if (row.masterKeyId !== master.id) {
    throw new Error(
      `The data key for ${describeScope(scope)} was wrapped by master key ${row.masterKeyId}, but ${MASTER_KEY_ENV} is ${master.id}`,
    );
  }
  const raw = await open(master.key, { ciphertext: row.wrappedKey, iv: row.iv }, dataKeyAad(scope));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptValue(
  dataKey: CryptoKey,
  scope: SecretScope,
  name: string,
  value: string,
) {
  return seal(dataKey, encoder.encode(value), valueAad(scope, name));
}

export async function decryptValue(
  dataKey: CryptoKey,
  scope: SecretScope,
  name: string,
  sealed: { ciphertext: string; iv: string },
) {
  return decoder.decode(await open(dataKey, sealed, valueAad(scope, name)));
}
