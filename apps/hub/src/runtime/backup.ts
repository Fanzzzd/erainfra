// Control-plane backup: tar the hub's durable state (routes, secrets + key, git bindings, projects,
// audit) and upload it to YOUR own S3-compatible storage (MinIO/etc.). Losing the hub means losing
// every secret and route, so this is the backup that matters most for a PaaS control plane. App/DB
// data backup is a separate, node-local concern (needs volume support).
//
// Self-hosted end to end: SigV4 is hand-rolled with Node's crypto (no AWS SDK), the endpoint/bucket/
// keys are yours. ponytail: path-style PutObject/Get/List only, buffered body — fine for state tarballs
// (KBs–MBs); switch to multipart if a hub ever accumulates GB of audit log.
import { createHash, createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { db } from "../db.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface S3Config {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region: string;
  prefix: string;
}

// Reads S3 settings from env. Returns null (backup disabled) unless endpoint+bucket+keys are all set.
export function backupConfig(): S3Config | null {
  const endpoint = process.env.PORTLESS_BACKUP_S3_ENDPOINT;
  const bucket = process.env.PORTLESS_BACKUP_S3_BUCKET;
  const accessKey = process.env.PORTLESS_BACKUP_S3_ACCESS_KEY;
  const secretKey = process.env.PORTLESS_BACKUP_S3_SECRET_KEY;
  if (!endpoint || !bucket || !accessKey || !secretKey) return null;
  return {
    endpoint: endpoint.replace(/\/$/, ""),
    bucket,
    accessKey,
    secretKey,
    region: process.env.PORTLESS_BACKUP_S3_REGION ?? "us-east-1",
    prefix: process.env.PORTLESS_BACKUP_S3_PREFIX ?? "portless/",
  };
}

export function stateDir(): string {
  return join(tmpdir(), "portless-runtime"); // where db.ts and the secrets key live
}

const sha256hex = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const hmac = (key: Buffer | string, data: string) =>
  createHmac("sha256", key).update(data, "utf8").digest();

// AWS Signature V4 for a single S3 request (path-style). Returns the headers to send.
function signV4(
  cfg: S3Config,
  method: string,
  canonicalUri: string,
  query: string,
  body: Buffer,
  now: Date,
  extraHeaders: Record<string, string> = {},
): Record<string, string> {
  const host = new URL(cfg.endpoint).host;
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256hex(body);
  const baseHeaders: Record<string, string> = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...extraHeaders,
  };
  const signedKeys = Object.keys(baseHeaders)
    .map((k) => k.toLowerCase())
    // False positive: map() has already produced a fresh array, so sort() mutates nothing. The
    // rule's toSorted() is ES2023 and this package's tsconfig sets lib: ES2022.
    // oxlint-disable-next-line unicorn/no-array-sort
    .sort();
  const canonicalHeaders = signedKeys
    .map(
      (k) =>
        `${k}:${String(baseHeaders[Object.keys(baseHeaders).find((h) => h.toLowerCase() === k)!]).trim()}\n`,
    )
    .join("");
  const signedHeaders = signedKeys.join(";");
  const canonicalRequest = [
    method,
    canonicalUri,
    query,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonicalRequest)].join("\n");
  const kDate = hmac("AWS4" + cfg.secretKey, dateStamp);
  const signingKey = hmac(hmac(hmac(kDate, cfg.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${cfg.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { ...baseHeaders, Authorization: authorization };
}

// Encode an object key for the canonical URI (each segment encoded, slashes preserved).
const encodeKey = (key: string) =>
  key
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/");

export async function putObject(
  cfg: S3Config,
  key: string,
  body: Buffer,
  now: Date = new Date(),
): Promise<void> {
  const uri = `/${cfg.bucket}/${encodeKey(key)}`;
  const headers = signV4(cfg, "PUT", uri, "", body, now, { "content-type": "application/gzip" });
  const res = await fetch(`${cfg.endpoint}${uri}`, {
    method: "PUT",
    headers,
    body: new Uint8Array(body),
  });
  if (!res.ok) throw new Error(`S3 PUT ${key} → ${res.status} ${(await res.text()).slice(0, 300)}`);
}

export async function getObject(
  cfg: S3Config,
  key: string,
  now: Date = new Date(),
): Promise<Buffer> {
  const uri = `/${cfg.bucket}/${encodeKey(key)}`;
  const headers = signV4(cfg, "GET", uri, "", Buffer.alloc(0), now);
  const res = await fetch(`${cfg.endpoint}${uri}`, { method: "GET", headers });
  if (!res.ok) throw new Error(`S3 GET ${key} → ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ListObjectsV2 under the configured prefix; newest first (keys are timestamped).
export async function listBackups(cfg: S3Config, now: Date = new Date()): Promise<string[]> {
  const query = `list-type=2&prefix=${encodeURIComponent(cfg.prefix)}`;
  const uri = `/${cfg.bucket}`;
  const headers = signV4(cfg, "GET", uri, query, Buffer.alloc(0), now);
  const res = await fetch(`${cfg.endpoint}${uri}?${query}`, { method: "GET", headers });
  if (!res.ok) throw new Error(`S3 LIST → ${res.status}`);
  const xml = await res.text();
  // False positives on both lines below: the array is built fresh by matchAll() + map(), so neither
  // call mutates anything observable. toSorted()/toReversed() are ES2023 and this package's tsconfig
  // sets lib: ES2022, so the suggested rewrite does not typecheck here.
  return (
    [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)]
      .map((m) => m[1])
      // oxlint-disable-next-line unicorn/no-array-sort
      .sort()
      // oxlint-disable-next-line unicorn/no-array-reverse
      .reverse()
  );
}

// tar.gz the state dir (excluding bulky/ephemeral bits). tar is always present on the hub OS.
export function packState(dir: string = stateDir()): Buffer {
  return execFileSync(
    "tar",
    [
      "-czf",
      "-",
      "-C",
      dir,
      "--exclude=builds",
      "--exclude=./builds",
      "--exclude=*.log",
      "--exclude=*.tmp",
      ".",
    ],
    { maxBuffer: 256 * 1024 * 1024 },
  );
}

// Back up now: pack state, upload as <prefix>portless-state-<ISO>.tar.gz. Returns the key + size.
export async function backupNow(
  cfg: S3Config,
  now: Date = new Date(),
): Promise<{ key: string; bytes: number }> {
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    /* backup proceeds; WAL is tarred too */
  }
  const tar = packState();
  const key = `${cfg.prefix}portless-state-${now.toISOString().replace(/[:.]/g, "-")}.tar.gz`;
  await putObject(cfg, key, tar, now);
  return { key, bytes: tar.length };
}

// Restore: download a backup and extract it OVER the state dir. Destructive — used for disaster
// recovery from a script, not the casual API.
export async function restoreFrom(
  cfg: S3Config,
  key: string,
  dir: string = stateDir(),
): Promise<void> {
  const tar = await getObject(cfg, key);
  execFileSync("tar", ["-xzf", "-", "-C", dir], { input: tar });
}
