import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { packState, backupConfig } from "../src/runtime/backup.ts";

test("packState makes a gzip tar of state, excluding builds/ and logs", () => {
  const dir = mkdtempSync(join(tmpdir(), "bk-"));
  try {
    writeFileSync(join(dir, "routes.json"), '{"web":{}}');
    writeFileSync(join(dir, "server.log"), "noise");
    mkdirSync(join(dir, "builds"));
    writeFileSync(join(dir, "builds", "src.tgz"), "big");

    const tar = packState(dir);
    assert.equal(tar[0], 0x1f, "gzip magic byte 0"); // gzip header
    assert.equal(tar[1], 0x8b, "gzip magic byte 1");

    // extract and inspect the contents
    const out = mkdtempSync(join(tmpdir(), "bk-out-"));
    execFileSync("tar", ["-xzf", "-", "-C", out], { input: tar });
    assert.equal(readFileSync(join(out, "routes.json"), "utf8"), '{"web":{}}'); // state included
    const listing = execFileSync("tar", ["-tzf", "-"], { input: tar }).toString();
    assert.ok(!/builds/.test(listing), "builds/ excluded"); // bulky uploads not in the backup
    assert.ok(!/server\.log/.test(listing), "logs excluded");
    rmSync(out, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("backupConfig is null unless all S3 settings are present", () => {
  const saved = { ...process.env };
  for (const k of [
    "PORTLESS_BACKUP_S3_ENDPOINT",
    "PORTLESS_BACKUP_S3_BUCKET",
    "PORTLESS_BACKUP_S3_ACCESS_KEY",
    "PORTLESS_BACKUP_S3_SECRET_KEY",
  ])
    delete process.env[k];
  assert.equal(backupConfig(), null);
  process.env.PORTLESS_BACKUP_S3_ENDPOINT = "http://127.0.0.1:9000/";
  process.env.PORTLESS_BACKUP_S3_BUCKET = "b";
  process.env.PORTLESS_BACKUP_S3_ACCESS_KEY = "a";
  process.env.PORTLESS_BACKUP_S3_SECRET_KEY = "s";
  const cfg = backupConfig();
  assert.ok(cfg);
  assert.equal(cfg.endpoint, "http://127.0.0.1:9000"); // trailing slash trimmed
  assert.equal(cfg.region, "us-east-1"); // default
  Object.assign(process.env, saved);
  for (const k of [
    "PORTLESS_BACKUP_S3_ENDPOINT",
    "PORTLESS_BACKUP_S3_BUCKET",
    "PORTLESS_BACKUP_S3_ACCESS_KEY",
    "PORTLESS_BACKUP_S3_SECRET_KEY",
  ])
    if (!(k in saved)) delete process.env[k];
});
