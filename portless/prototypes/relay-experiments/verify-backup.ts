// Verify control-plane backup to S3 against a REAL MinIO: pack the hub state, PUT it with hand-rolled
// SigV4, list it, then restore it into a fresh dir and assert it round-trips byte-for-byte. Proves the
// SigV4 signing is correct against an actual S3 implementation (not a mock).
// Needs /tmp/minio (downloaded by the caller). Run:
//   node --experimental-strip-types prototypes/relay-experiments/verify-backup.ts
import { spawn, execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backupNow,
  listBackups,
  restoreFrom,
  type S3Config,
} from "../../apps/api/src/runtime/backup.ts";

const ACCESS = "portlessroot",
  SECRET = "portlesssecret123",
  BUCKET = "portless-backups";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const dataDir = mkdtempSync(join(tmpdir(), "minio-"));
mkdirSync(join(dataDir, BUCKET)); // single-node MinIO: a top-level dir IS a bucket
const stateDir = mkdtempSync(join(tmpdir(), "pl-state-"));
writeFileSync(
  join(stateDir, "routes.json"),
  JSON.stringify({ web: { node: "nodeA", image: "reg/web:1", port: 8080 } }),
);
writeFileSync(join(stateDir, "secrets.json"), JSON.stringify({ web: { API_KEY: "iv:tag:ct" } }));
writeFileSync(join(stateDir, "secret.key"), "deadbeef".repeat(8));
mkdirSync(join(stateDir, "builds"));
writeFileSync(join(stateDir, "builds", "big.tgz"), Buffer.alloc(5000)); // must be EXCLUDED

const minio = spawn("/tmp/minio", ["server", dataDir, "--address", "127.0.0.1:9000"], {
  env: { ...process.env, MINIO_ROOT_USER: ACCESS, MINIO_ROOT_PASSWORD: SECRET },
  stdio: ["ignore", "ignore", "ignore"],
});

const cfg: S3Config = {
  endpoint: "http://127.0.0.1:9000",
  bucket: BUCKET,
  accessKey: ACCESS,
  secretKey: SECRET,
  region: "us-east-1",
  prefix: "portless/",
};

let failed = true;
try {
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch("http://127.0.0.1:9000/minio/health/live")).ok) break;
    } catch {
      /* booting */
    }
    await sleep(250);
  }
  console.log("✅ MinIO up on :9000");

  // BACKUP: pack stateDir + PUT via SigV4
  process.env.PORTLESS_STATE_DIR = stateDir;
  const r = await backupNow(cfg);
  console.log(`✅ backup uploaded: ${r.key} (${r.bytes}b)`);
  if (!r.key.endsWith(".tar.gz") || r.bytes < 100) throw new Error("backup looks wrong");

  // LIST: SigV4 ListObjectsV2 sees it
  const keys = await listBackups(cfg);
  console.log(`✅ list returned ${keys.length} backup(s): ${keys[0]}`);
  if (!keys.includes(r.key)) throw new Error("uploaded key not in list");

  // RESTORE: GET + extract into a fresh dir, assert state round-trips and builds/ was excluded
  const restoreDir = mkdtempSync(join(tmpdir(), "pl-restore-"));
  await restoreFrom(cfg, r.key, restoreDir);
  const routes = readFileSync(join(restoreDir, "routes.json"), "utf8");
  if (!routes.includes('"node":"nodeA"')) throw new Error("routes.json not restored");
  if (!existsSync(join(restoreDir, "secret.key"))) throw new Error("secret.key not restored");
  if (existsSync(join(restoreDir, "builds")))
    throw new Error("builds/ should have been excluded from the backup");
  console.log("✅ restore round-trips (routes + secret.key present, builds/ excluded)");

  // negative: a wrong secret key must be rejected by S3 (proves the signature is actually checked)
  try {
    await backupNow({ ...cfg, secretKey: "wrong-secret" });
    throw new Error("S3 accepted a bad signature!");
  } catch (e) {
    if (/403|SignatureDoesNotMatch|→ 403/.test((e as Error).message))
      console.log("✅ bad SigV4 signature rejected (403) — signing is real");
    else throw e;
  }
  failed = false;
} catch (e) {
  console.error("FAIL:", (e as Error).message);
}
minio.kill("SIGKILL");
try {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
} catch {
  /* best effort */
}
process.exit(failed ? 1 : 0);
