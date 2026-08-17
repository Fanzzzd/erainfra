import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renamedEnv, renamedPath, retiredName, resetRenameWarnings } from "../src/env.ts";
import { readSessionCookie, SESSION_COOKIE, SESSION_COOKIE_NEXT } from "../src/auth.ts";
import { createApiServer } from "../src/server.ts";

// Stage 1 of retiring the "Portless" name (ADR 0004; CONTEXT.md rule 4). The property this whole
// release rests on is negative — a customer's box that has never heard of the new names must behave
// EXACTLY as it did, plus a warning — so most of what follows asserts that nothing happened.
//
// Four cases per class, because the fourth is the one that breaks things silently:
//   new only     → used, no warning
//   old only     → used, warning
//   both set     → new wins
//   neither set  → the pre-existing default, and still no warning

// Capture console.warn without swallowing a real failure's output.
function withWarnings<T>(fn: () => T): { value: T; warnings: string[] } {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
  resetRenameWarnings();
  try {
    return { value: fn(), warnings };
  } finally {
    console.warn = original;
    resetRenameWarnings();
  }
}

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ---------- class: environment variables ------------------------------------------------------

test("a renamed variable: new name only → used, and nothing is printed", () => {
  const { value, warnings } = withWarnings(() =>
    withEnv({ ERAINFRA_BIND: "0.0.0.0", PORTLESS_BIND: undefined }, () =>
      renamedEnv("ERAINFRA_BIND", "PORTLESS_BIND"),
    ),
  );
  assert.equal(value, "0.0.0.0");
  assert.deepEqual(warnings, [], "the new name is the supported one; it must be silent");
});

test("a renamed variable: old name only → used, and says so exactly once", () => {
  const { value, warnings } = withWarnings(() =>
    withEnv({ ERAINFRA_BIND: undefined, PORTLESS_BIND: "0.0.0.0" }, () => {
      const first = renamedEnv("ERAINFRA_BIND", "PORTLESS_BIND");
      const second = renamedEnv("ERAINFRA_BIND", "PORTLESS_BIND");
      assert.equal(first, second, "reading twice must not change the answer");
      return first;
    }),
  );
  assert.equal(value, "0.0.0.0", "the old name still works — this is the whole point of stage 1");
  assert.equal(warnings.length, 1, "once per name per process, not once per read");
  assert.match(warnings[0]!, /PORTLESS_BIND/);
  assert.match(warnings[0]!, /ERAINFRA_BIND/);
});

test("a renamed variable: both set → the new name wins", () => {
  const { value, warnings } = withWarnings(() =>
    withEnv({ ERAINFRA_BIND: "127.0.0.1", PORTLESS_BIND: "0.0.0.0" }, () =>
      renamedEnv("ERAINFRA_BIND", "PORTLESS_BIND"),
    ),
  );
  assert.equal(value, "127.0.0.1");
  assert.deepEqual(warnings, [], "the operator already moved; do not nag about a leftover");
});

test("a renamed variable: neither set → undefined, so the call site's own default survives", () => {
  // This is the case that breaks a box silently. `renamedEnv(…) ?? "127.0.0.1"` only keeps its
  // default if this returns undefined — a helper that returned "" would bind the Hub to the empty
  // string and nothing would throw.
  const { value, warnings } = withWarnings(() =>
    withEnv({ ERAINFRA_BIND: undefined, PORTLESS_BIND: undefined }, () => ({
      raw: renamedEnv("ERAINFRA_BIND", "PORTLESS_BIND"),
      withDefault: renamedEnv("ERAINFRA_BIND", "PORTLESS_BIND") ?? "127.0.0.1",
    })),
  );
  assert.equal(value.raw, undefined);
  assert.equal(value.withDefault, "127.0.0.1");
  assert.deepEqual(warnings, [], "nothing retired was found, so there is nothing to warn about");
});

test("a renamed variable set to the empty string is set, not absent", () => {
  // `PORTLESS_TOKEN=` means the empty string. Skipping past it to the other name would change what
  // a box does rather than only what it prints, which is exactly what this release must not do.
  const { value } = withWarnings(() =>
    withEnv({ ERAINFRA_BIND: "", PORTLESS_BIND: "0.0.0.0" }, () =>
      renamedEnv("ERAINFRA_BIND", "PORTLESS_BIND"),
    ),
  );
  assert.equal(value, "", "the new name was set — to empty — so it still wins");
});

// ---------- class: renamed paths --------------------------------------------------------------

test("a renamed path: prefers the new location only when it already exists, never creates it", () => {
  const root = mkdtempSync(join(tmpdir(), "rename-path-"));
  const current = join(root, "erainfra-runtime");
  const retired = join(root, "portless-runtime");
  try {
    // neither exists → the OLD path, so whoever creates it creates it where it lives today
    let out = withWarnings(() => renamedPath(current, retired));
    assert.equal(out.value, retired, "a fresh box must not invent the renamed directory");
    assert.deepEqual(out.warnings, []);

    // old only → the old path, with a warning
    mkdirSync(retired);
    out = withWarnings(() => renamedPath(current, retired));
    assert.equal(out.value, retired);
    assert.equal(out.warnings.length, 1);
    assert.match(out.warnings[0]!, /portless-runtime/);

    // both → the new one wins
    mkdirSync(current);
    out = withWarnings(() => renamedPath(current, retired));
    assert.equal(out.value, current);
    assert.deepEqual(out.warnings, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------- class: the session cookie ---------------------------------------------------------

test("the session cookie is read under both names, new first", () => {
  const cases: Array<[string | undefined, string | undefined, string | undefined, number]> = [
    ["new-token", undefined, "new-token", 0],
    [undefined, "old-token", "old-token", 1],
    ["new-token", "old-token", "new-token", 0],
    [undefined, undefined, undefined, 0],
  ];
  for (const [current, retired, want, warns] of cases) {
    const parts = [
      current === undefined ? undefined : `${SESSION_COOKIE_NEXT}=${current}`,
      retired === undefined ? undefined : `${SESSION_COOKIE}=${retired}`,
    ].filter(Boolean);
    const out = withWarnings(() => readSessionCookie(parts.length ? parts.join("; ") : undefined));
    assert.equal(out.value, want, `cookie header: ${parts.join("; ") || "(none)"}`);
    assert.equal(out.warnings.length, warns);
  }
});

test("the retired-name warning fires once per name, not once per request", () => {
  const { warnings } = withWarnings(() => {
    for (let i = 0; i < 5; i++) retiredName("portless_session", "erainfra_session", "note");
  });
  assert.equal(warnings.length, 1);
});

// ---------- class: the /agent-bin download path -----------------------------------------------

test("the Hub serves the agent binary under BOTH names, from the one file on disk", async () => {
  // The serving side must ship before any installer asks. build-agents.sh still writes the frozen
  // filename and must keep doing so, so the renamed route has to resolve to that same file.
  const binDir = mkdtempSync(join(tmpdir(), "agent-bin-"));
  writeFileSync(join(binDir, "portless-agent-linux-amd64"), "ELF-ish bytes");
  const app = await withEnv({ ERAINFRA_AGENT_BIN_DIR: binDir }, async () => {
    const server = createApiServer();
    for (const name of ["portless-agent-linux-amd64", "erainfra-agent-linux-amd64"]) {
      const res = await server.inject({ method: "GET", url: `/agent-bin/${name}` });
      assert.equal(res.statusCode, 200, `GET /agent-bin/${name} → ${res.statusCode}`);
      assert.equal(res.body, "ELF-ish bytes", `/agent-bin/${name} served different bytes`);
    }
    // Neither name loosens the allowlist that keeps this route from being an arbitrary-file read.
    const bad = await server.inject({ method: "GET", url: "/agent-bin/hub.sh" });
    assert.equal(bad.statusCode, 400);
    const almost = await server.inject({
      method: "GET",
      url: "/agent-bin/erainfra-agent-plan9-amd64",
    });
    assert.equal(almost.statusCode, 400);
    return server;
  });
  await app.close();
  rmSync(binDir, { recursive: true, force: true });
});

test("the Hub serves the CLI under both routes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-file-"));
  const file = join(dir, "portless.mjs");
  writeFileSync(file, "#!/usr/bin/env node\n");
  const app = await withEnv({ ERAINFRA_CLI_FILE: file }, async () => {
    const server = createApiServer();
    for (const route of ["/cli/portless.mjs", "/cli/erainfra.mjs"]) {
      const res = await server.inject({ method: "GET", url: route });
      assert.equal(res.statusCode, 200, `GET ${route} → ${res.statusCode}`);
      assert.equal(res.body, "#!/usr/bin/env node\n");
    }
    return server;
  });
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---------- THE test: the old name alone is sufficient, for every consumer --------------------

// Every `PORTLESS_*` name the shipped Hub reads, paired with the renamed name it now also accepts.
// This list is what makes the PR safe to deploy: a customer's box sets only the left column, and
// every one of them must still reach the code that reads it. Adding a read site without adding a
// row here is the mistake this table exists to catch — the count is asserted below.
const HUB_VARIABLES: Array<[old: string, next: string]> = [
  ["PORTLESS_AGENT_BIN_DIR", "ERAINFRA_AGENT_BIN_DIR"],
  ["PORTLESS_APP_DOMAIN", "ERAINFRA_APP_DOMAIN"],
  ["PORTLESS_AUDIT_FILE", "ERAINFRA_AUDIT_FILE"],
  ["PORTLESS_BACKUP_INTERVAL_MIN", "ERAINFRA_BACKUP_INTERVAL_MIN"],
  ["PORTLESS_BACKUP_S3_ACCESS_KEY", "ERAINFRA_BACKUP_S3_ACCESS_KEY"],
  ["PORTLESS_BACKUP_S3_BUCKET", "ERAINFRA_BACKUP_S3_BUCKET"],
  ["PORTLESS_BACKUP_S3_ENDPOINT", "ERAINFRA_BACKUP_S3_ENDPOINT"],
  ["PORTLESS_BACKUP_S3_PREFIX", "ERAINFRA_BACKUP_S3_PREFIX"],
  ["PORTLESS_BACKUP_S3_REGION", "ERAINFRA_BACKUP_S3_REGION"],
  ["PORTLESS_BACKUP_S3_SECRET_KEY", "ERAINFRA_BACKUP_S3_SECRET_KEY"],
  ["PORTLESS_BIND", "ERAINFRA_BIND"],
  ["PORTLESS_BUILDS_DIR", "ERAINFRA_BUILDS_DIR"],
  ["PORTLESS_CLI_FILE", "ERAINFRA_CLI_FILE"],
  ["PORTLESS_DB_FILE", "ERAINFRA_DB_FILE"],
  ["PORTLESS_DEPLOY_DIR", "ERAINFRA_DEPLOY_DIR"],
  ["PORTLESS_DEV_AUTH", "ERAINFRA_DEV_AUTH"],
  ["PORTLESS_DEV_TOKENS", "ERAINFRA_DEV_TOKENS"],
  ["PORTLESS_FAILOVER", "ERAINFRA_FAILOVER"],
  ["PORTLESS_FAILOVER_GRACE_MS", "ERAINFRA_FAILOVER_GRACE_MS"],
  ["PORTLESS_GH_APP_ID", "ERAINFRA_GH_APP_ID"],
  ["PORTLESS_GH_APP_KEY", "ERAINFRA_GH_APP_KEY"],
  ["PORTLESS_GH_APP_KEY_FILE", "ERAINFRA_GH_APP_KEY_FILE"],
  ["PORTLESS_GH_WEBHOOK_SECRET", "ERAINFRA_GH_WEBHOOK_SECRET"],
  ["PORTLESS_HUB_BASE", "ERAINFRA_HUB_BASE"],
  ["PORTLESS_HUB_HOST", "ERAINFRA_HUB_HOST"],
  ["PORTLESS_PORT", "ERAINFRA_PORT"],
  ["PORTLESS_REGISTRY", "ERAINFRA_REGISTRY"],
  ["PORTLESS_REGISTRY_NODE", "ERAINFRA_REGISTRY_NODE"],
  ["PORTLESS_SECRET_KEY", "ERAINFRA_SECRET_KEY"],
  ["PORTLESS_SECRET_KEY_FILE", "ERAINFRA_SECRET_KEY_FILE"],
  ["PORTLESS_WEB_DIR", "ERAINFRA_WEB_DIR"],
];

test("THE property: the old name alone is still sufficient for every variable the Hub reads", () => {
  for (const [old, next] of HUB_VARIABLES) {
    const marker = `only-the-old-name-was-set:${old}`;
    const { value, warnings } = withWarnings(() =>
      withEnv({ [old]: marker, [next]: undefined }, () => renamedEnv(next, old)),
    );
    assert.equal(
      value,
      marker,
      `${old} alone no longer reaches its consumer — this PR would break every box in the field`,
    );
    assert.equal(warnings.length, 1, `${old} was accepted without saying it is retired`);
  }
});

test("every PORTLESS_* name the shipped Hub reads is covered by the table above", async () => {
  // The table is only a safety property if it is complete. Read the sources rather than trusting
  // it: a new `renamedEnv("ERAINFRA_X", "PORTLESS_X")` added anywhere under src/ must show up here, or
  // the test above silently stops covering it.
  const { readdirSync, readFileSync } = await import("node:fs");
  const srcRoot = join(import.meta.dirname, "../src");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) files.push(full);
    }
  };
  walk(srcRoot);

  const found = new Set<string>();
  for (const file of files) {
    // env.ts documents the pattern in prose; it reads nothing itself.
    if (file.endsWith("/env.ts")) continue;
    for (const m of readFileSync(file, "utf8").matchAll(
      /renamedEnv\(\s*"(ERAINFRA_[A-Z0-9_]+)"\s*,\s*"(PORTLESS_[A-Z0-9_]+)"\s*\)/g,
    )) {
      assert.equal(
        m[1],
        m[2]!.replace(/^PORTLESS_/, "ERAINFRA_"),
        `${file}: ${m[2]} is paired with ${m[1]}, which is not its prefix-swapped name`,
      );
      found.add(m[2]!);
    }
  }

  const listed = new Set(HUB_VARIABLES.map(([old]) => old));
  const missing = [...found].filter((v) => !listed.has(v)).toSorted();
  const stale = [...listed].filter((v) => !found.has(v)).toSorted();
  assert.deepEqual(missing, [], "read sites the sufficiency test above does not cover");
  assert.deepEqual(stale, [], "table rows with no read site left in src/");
});
