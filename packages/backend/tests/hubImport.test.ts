// @vitest-environment node
// node:sqlite and node:crypto build the fixture Hub database the way the Hub writes it, which the
// edge runtime the other suites use cannot do.
import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { convexTest, type TestConvex } from "convex-test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { MASTER_KEY_ENV } from "../convex/infra/secretCrypto";
import schema from "../convex/schema";
import { planImportCalls, readHubState } from "../scripts/import-hub-state.ts";

const modules = import.meta.glob("../convex/**/*.ts");
type Harness = TestConvex<typeof schema>;

// The Hub's own schema (apps/hub/src/db.ts), minus the full-text index the import does not read.
const HUB_SCHEMA = `
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  roles TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, user_agent TEXT);
CREATE TABLE api_tokens (
  hash TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, prefix TEXT NOT NULL,
  roles TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT);
CREATE TABLE routes (app TEXT PRIMARY KEY, node TEXT NOT NULL, image TEXT NOT NULL, port INTEGER NOT NULL);
CREATE TABLE apps (app TEXT PRIMARY KEY, node TEXT NOT NULL, doc TEXT NOT NULL);
CREATE TABLE links (name TEXT PRIMARY KEY, doc TEXT NOT NULL);
CREATE TABLE ports (node TEXT NOT NULL, key TEXT NOT NULL, port INTEGER NOT NULL, PRIMARY KEY (node, key));
CREATE TABLE secrets (app TEXT NOT NULL, key TEXT NOT NULL, blob TEXT NOT NULL, PRIMARY KEY (app, key));
CREATE TABLE git_bindings (id TEXT PRIMARY KEY, doc TEXT NOT NULL);
CREATE TABLE deployments (
  id TEXT PRIMARY KEY, app TEXT NOT NULL, stage TEXT NOT NULL, detail TEXT NOT NULL,
  urls TEXT NOT NULL, error TEXT, started_at TEXT NOT NULL, finished_at TEXT);
CREATE TABLE chat_sessions (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, host TEXT NOT NULL, project TEXT,
  title TEXT, started_at TEXT, updated_at TEXT, message_count INTEGER NOT NULL DEFAULT 0);
CREATE TABLE audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL,
  action TEXT NOT NULL, target TEXT, outcome TEXT NOT NULL, dry_run INTEGER, meta TEXT);
`;

const HUB_KEY = randomBytes(32);
const MASTER_KEY = "33".repeat(32);
const OWNER_PASSWORD = "hub-owner-password";

/** apps/hub/src/runtime/users.ts hashPassword, including its production work factor. */
function hubHash(password: string) {
  const salt = randomBytes(16);
  const params = { N: 2 ** 15, r: 8, p: 1 };
  const hash = scryptSync(password, salt, 64, { ...params, maxmem: 128 * params.N * params.r * 2 });
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

/** apps/hub/src/runtime/secrets.ts enc. */
function hubEncrypt(plain: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", HUB_KEY, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${ct.toString("hex")}`;
}

let dir: string;
let dbPath: string;

function buildHubDb() {
  const db = new DatabaseSync(dbPath);
  db.exec(HUB_SCHEMA);
  const run = (sql: string, ...params: Array<string | number | null>) =>
    db.prepare(sql).run(...params);

  run(
    "INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)",
    "u-viewer",
    "viewer@acme.dev",
    "Vi",
    '["viewer"]',
    hubHash("viewer-password"),
    "2026-02-01T00:00:00.000Z",
  );
  run(
    "INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)",
    "u-owner",
    "owner@acme.dev",
    "Ow",
    '["owner"]',
    hubHash(OWNER_PASSWORD),
    "2026-01-01T00:00:00.000Z",
  );
  run(
    "INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)",
    "h",
    "s1",
    "u-owner",
    "2026-01-01T00:00:00.000Z",
    "2026-12-01T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z",
    null,
  );
  run(
    "INSERT INTO api_tokens VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    "hash",
    "t1",
    "node work-remote",
    "plt_abcdefgh",
    '["operator"]',
    "u-owner",
    "2026-01-02T00:00:00.000Z",
    null,
  );
  run("INSERT INTO routes VALUES (?, ?, ?, ?)", "shop", "box-1", "registry/shop@sha256:1", 62001);
  run("INSERT INTO routes VALUES (?, ?, ?, ?)", "solo", "box-2", "registry/solo:1", 62000);
  run(
    "INSERT INTO apps VALUES (?, ?, ?)",
    "shop",
    "box-1",
    JSON.stringify({
      node: "box-1",
      services: [
        {
          name: "web",
          image: "registry/shop@sha256:1",
          args: ["-v", "x:/y"],
          port: 62001,
          route: "shop",
          env: { PORT: "8080" },
        },
        { name: "db", image: "postgres:16", args: [], node: "box-2" },
      ],
      links: [
        {
          name: "shop-db",
          need: "db",
          provider: "box-2",
          providerPort: 62005,
          consumer: "box-1",
          localPort: 62002,
        },
      ],
    }),
  );
  run(
    "INSERT INTO links VALUES (?, ?)",
    "registry",
    JSON.stringify({
      name: "registry",
      provider: "box-2",
      providerPort: 5000,
      consumer: "box-1",
      localPort: 62003,
      createdBy: "deploy",
    }),
  );
  // Port numbers with gaps, which the import must keep exactly.
  for (const [node, key, port] of [
    ["box-1", "shop/web", 62001],
    ["box-1", "shop/link-db", 62002],
    ["box-1", "registry/link", 62003],
    ["box-2", "solo/web", 62000],
    ["box-2", "shop/db", 62005],
  ] as const) {
    run("INSERT INTO ports VALUES (?, ?, ?)", node, key, port);
  }
  run(
    "INSERT INTO secrets VALUES (?, ?, ?)",
    "shop",
    "DATABASE_URL",
    hubEncrypt("postgres://shop:s3cret@db/shop"),
  );
  run("INSERT INTO secrets VALUES (?, ?, ?)", "shop-web", "SESSION_KEY", hubEncrypt("päss wörd ✓"));
  run(
    "INSERT INTO git_bindings VALUES (?, ?)",
    "b-1",
    JSON.stringify({
      id: "b-1",
      repo: "Acme/Shop",
      branch: "main",
      name: "shop",
      deployNode: "box-1",
      lastStatus: { at: "2026-03-01T00:00:00.000Z", sha: "abc", ok: true, stage: "done" },
    }),
  );
  run(
    "INSERT INTO deployments VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    "d-1",
    "shop",
    "done",
    "done",
    '["https://shop.acme.dev"]',
    null,
    "2026-03-01T00:00:00.000Z",
    "2026-03-01T00:01:00.000Z",
  );
  run(
    "INSERT INTO deployments VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    "d-2",
    "shop",
    "building",
    "building web (1/2)",
    "[]",
    null,
    "2026-03-02T00:00:00.000Z",
    null,
  );
  run("INSERT INTO chat_sessions (id, source, host) VALUES (?, ?, ?)", "c1", "claude", "laptop");
  for (const [at, action] of [
    ["2026-01-01T00:00:00.000Z", "account.setup"],
    ["2026-01-01T00:00:01.000Z", "git.bind"],
    ["2026-01-01T00:00:02.000Z", "git.deployNow"],
  ]) {
    run(
      "INSERT INTO audit (at, actor, action, target, outcome, dry_run, meta) VALUES (?, ?, ?, ?, ?, ?, ?)",
      at,
      "u-owner",
      action,
      "acme/shop",
      "success",
      0,
      action === "git.bind" ? '{"branch":"main"}' : null,
    );
  }
  return db;
}

async function importAll(t: Harness) {
  const state = readHubState(dbPath, HUB_KEY);
  // A tiny call size forces several action calls, as a large Hub would need.
  for (const batches of planImportCalls(state.batches, 2_000)) {
    await t.action(internal.infra.hubImport.run, { batches });
  }
  return state;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "hub-import-"));
  dbPath = join(dir, "portless.db");
  buildHubDb().close();

  // What `npx @convex-dev/auth` provisions, so the imported owner can sign in for real.
  const keys = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey));
  const base64 = btoa(String.fromCodePoint(...pkcs8));
  process.env.JWT_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----\n${base64.replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----`;
  process.env.JWKS = JSON.stringify({
    keys: [{ ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), use: "sig" }],
  });
  process.env.SITE_URL = "http://localhost";
  process.env.CONVEX_SITE_URL = "http://localhost";
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  process.env[MASTER_KEY_ENV] = MASTER_KEY;
});

afterEach(() => {
  delete process.env[MASTER_KEY_ENV];
});

describe("Hub importer", () => {
  it("reads every table and reports what it leaves behind", () => {
    const state = readHubState(dbPath, HUB_KEY);
    const rows = Object.fromEntries(state.batches.map((b) => [b.kind, b.rows.length]));
    expect(rows).toEqual({
      users: 2,
      routes: 2,
      apps: 1,
      links: 1,
      ports: 5,
      secrets: 2,
      gitBindings: 1,
      deployments: 2,
      audit: 3,
    });
    expect(state.notImported).toEqual({
      apiTokens: [{ name: "node work-remote", prefix: "plt_abcdefgh", roles: ["operator"] }],
      sessions: 1,
      chatSessions: 1,
    });
  });

  it("round-trips the Hub's state, idempotently", async () => {
    const t = convexTest(schema, modules);
    await importAll(t);
    const first = await snapshot(t);
    await importAll(t);
    expect(await snapshot(t)).toEqual(first);

    const nodeName = (id: string) => first.nodes.find((n) => n._id === id)?.name;

    // Users: roles, ids and creation times kept; the first account created is the Hub owner.
    expect(first.users.map((u) => [u.email, u.role, u.legacyHubId, u.createdAt])).toEqual([
      ["owner@acme.dev", "owner", "u-owner", Date.parse("2026-01-01T00:00:00.000Z")],
      ["viewer@acme.dev", "viewer", "u-viewer", Date.parse("2026-02-01T00:00:00.000Z")],
    ]);

    // Ports: the same numbers on the same Nodes, gaps included.
    expect(first.ports.map((p) => [nodeName(p.nodeId), p.key, p.port]).toSorted()).toEqual(
      [
        ["box-1", "registry/link", 62003],
        ["box-1", "shop/link-db", 62002],
        ["box-1", "shop/web", 62001],
        ["box-2", "shop/db", 62005],
        ["box-2", "solo/web", 62000],
      ].toSorted(),
    );

    // Apps and links reference Nodes by id, resolved from the Hub's names.
    const shop = first.apps.find((a) => a.name === "shop")!;
    expect(nodeName(shop.nodeId)).toBe("box-1");
    expect(
      shop.services.map((s) => [s.name, s.nodeId === undefined ? null : nodeName(s.nodeId), s.env]),
    ).toEqual([
      ["web", null, { PORT: "8080" }],
      ["db", "box-2", undefined],
    ]);
    expect(nodeName(shop.links[0].providerNodeId)).toBe("box-2");
    expect(first.meshLinks.map((l) => [l.name, l.localPort, l.createdBy])).toEqual([
      ["registry", 62003, "deploy"],
    ]);
    expect(first.routes.map((r) => [r.name, nodeName(r.nodeId), r.port]).toSorted()).toEqual([
      ["shop", "box-1", 62001],
      ["solo", "box-2", 62000],
    ]);

    // Audit: Hub order and timestamps kept, numbered from this deployment's sequence.
    expect(first.audit.map((a) => [a.seq, a.hubSeq, a.action, a.at, a.metaJson])).toEqual([
      [1, 1, "account.setup", Date.parse("2026-01-01T00:00:00.000Z"), undefined],
      [2, 2, "git.bind", Date.parse("2026-01-01T00:00:01.000Z"), '{"branch":"main"}'],
      [3, 3, "git.deployNow", Date.parse("2026-01-01T00:00:02.000Z"), undefined],
    ]);

    // Bindings and deployments keep their Hub ids and times.
    expect(
      first.bindings.map((b) => [
        b.legacyId,
        b.repoKey,
        b.branch,
        nodeName(b.deployNodeId!),
        b.lastStatus?.at,
      ]),
    ).toEqual([["b-1", "acme/shop", "main", "box-1", Date.parse("2026-03-01T00:00:00.000Z")]]);
    expect(first.deployments.map((d) => [d.legacyId, d.stage, d.startedAt, d.finishedAt])).toEqual([
      [
        "d-1",
        "done",
        Date.parse("2026-03-01T00:00:00.000Z"),
        Date.parse("2026-03-01T00:01:00.000Z"),
      ],
      ["d-2", "building", Date.parse("2026-03-02T00:00:00.000Z"), undefined],
    ]);

    // Secrets: plaintext preserved through re-encryption, and nothing stored in the clear.
    expect(JSON.stringify(first.secretRows)).not.toContain("s3cret");
    const node = first.nodes.find((n) => n.name === "box-1")!._id;
    const deploymentId = await t.run(async (ctx) => {
      const { createDeployment } = await import("../convex/infra/deployments");
      return await createDeployment(ctx, {
        app: "shop",
        targetNodeIds: [node],
        trigger: { kind: "manual" },
      });
    });
    await t.mutation(internal.infra.deployments.begin, { deploymentId });
    expect(
      await t.query(internal.infra.secrets.forNodeDeploy, { nodeId: node, deploymentId }),
    ).toEqual({
      appWide: { DATABASE_URL: "postgres://shop:s3cret@db/shop" },
      services: { web: { SESSION_KEY: "päss wörd ✓" } },
    });
  });

  it("imports Hub audit rows after the deployment's own, in Hub order", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.infra.audit.append, {
      actor: "a",
      action: "native.first",
      outcome: "success",
    });
    await importAll(t);
    const rows = (await snapshot(t)).audit;
    expect(rows.map((r) => [r.seq, r.hubSeq ?? null, r.action])).toEqual([
      [1, null, "native.first"],
      [2, 1, "account.setup"],
      [3, 2, "git.bind"],
      [4, 3, "git.deployNow"],
    ]);
  });

  it("refuses to change a port a Node already holds", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const node = await ctx.db.insert("nodes", {
        name: "box-2",
        source: "enrolled",
        createdAt: 0,
      });
      await ctx.db.insert("portAllocations", {
        nodeId: node,
        key: "other/web",
        port: 62000,
        allocatedAt: 0,
      });
    });
    await expect(importAll(t)).rejects.toThrow(/62000 on this Node is already held by other\/web/);
  });

  it("lets an imported account sign in with its Hub password", async () => {
    const t = convexTest(schema, modules);
    await importAll(t);
    const signIn = (password: string) =>
      t.action(api.auth.signIn, {
        provider: "password",
        params: { email: "owner@acme.dev", password, flow: "signIn" },
      });
    const result = await signIn(OWNER_PASSWORD);
    expect(result.tokens?.token).toEqual(expect.any(String));
    await expect(signIn("not-the-password")).rejects.toThrow();
  });

  it("links a Hub account to an existing dashboard account with the same email", async () => {
    const t = convexTest(schema, modules);
    const existing = await t.run(
      async (ctx) => await ctx.db.insert("users", { email: "viewer@acme.dev", role: "admin" }),
    );
    await importAll(t);
    const users = (await snapshot(t)).users;
    expect(users).toHaveLength(2);
    expect(users.find((u) => u._id === existing)).toMatchObject({
      role: "admin",
      legacyHubId: "u-viewer",
    });
  });
});

/**
 * A Hub database holding only Apps, single-container routes and secrets, to test how the importer
 * reads the Hub's `<app>-<service>` secret scope strings.
 */
function scopeFixture(
  name: string,
  hub: {
    apps?: Record<string, string[]>;
    routes?: string[];
    secrets: Record<string, Record<string, string>>;
  },
) {
  const path = join(dir, `${name}.db`);
  const db = new DatabaseSync(path);
  db.exec(HUB_SCHEMA);
  for (const [app, services] of Object.entries(hub.apps ?? {})) {
    db.prepare("INSERT INTO apps VALUES (?, ?, ?)").run(
      app,
      "box-1",
      JSON.stringify({
        node: "box-1",
        services: services.map((service) => ({ name: service, image: `r/${app}-${service}:1` })),
        links: [],
      }),
    );
  }
  for (const app of hub.routes ?? []) {
    db.prepare("INSERT INTO routes VALUES (?, ?, ?, ?)").run(app, "box-1", `r/${app}:1`, 62000);
  }
  for (const [scope, values] of Object.entries(hub.secrets)) {
    for (const [key, value] of Object.entries(values)) {
      db.prepare("INSERT INTO secrets VALUES (?, ?, ?)").run(scope, key, hubEncrypt(value));
    }
  }
  db.close();
  return path;
}

const secretRowsOf = (path: string) =>
  readHubState(path, HUB_KEY).batches.flatMap((b) => (b.kind === "secrets" ? b.rows : []));

describe("Hub secret scopes", () => {
  it("reads `x-y` as App x-y's scope when x-y is an App and App x has no service y", () => {
    const path = scopeFixture("app-only", {
      apps: { "web-api": ["main"], web: ["worker"] },
      secrets: { "web-api": { TOKEN: "app" } },
    });
    expect(secretRowsOf(path)).toEqual([{ app: "web-api", values: { TOKEN: "app" } }]);
    // A single-container App known only from `routes` counts as an App too.
    const routed = scopeFixture("route-only", {
      routes: ["web-api"],
      secrets: { "web-api": { TOKEN: "app" } },
    });
    expect(secretRowsOf(routed)).toEqual([{ app: "web-api", values: { TOKEN: "app" } }]);
  });

  it("reads `x-y` as service y of App x when App x has service y and x-y is not an App", () => {
    const path = scopeFixture("service-only", {
      apps: { web: ["api"] },
      secrets: { web: { COMMON: "1" }, "web-api": { TOKEN: "service" } },
    });
    expect(secretRowsOf(path)).toEqual([
      { app: "web", values: { COMMON: "1" } },
      { app: "web", service: "api", values: { TOKEN: "service" } },
    ]);
  });

  it("refuses the import when `x-y` is both an App and a service of App x", async () => {
    const path = scopeFixture("both", {
      apps: { web: ["api"], "web-api": ["main"] },
      secrets: { web: { COMMON: "1" }, "web-api": { TOKEN: "which" } },
    });
    expect(() => readHubState(path, HUB_KEY)).toThrow(
      /Hub secret scope "web-api" is ambiguous: it names App "web-api" and service "api" of App "web"/,
    );
  });

  it("refuses the import when `x-y` names no App and no service", async () => {
    const path = scopeFixture("neither", {
      apps: { web: ["api"] },
      secrets: { "ghost-db": { TOKEN: "orphan" }, "web-worker": { TOKEN: "orphan" } },
    });
    let message = "";
    try {
      readHubState(path, HUB_KEY);
    } catch (error) {
      message = (error as Error).message;
    }
    // Every unresolved scope is named in the one refusal, and no value is echoed.
    expect(message).toMatch(/Hub secret scope "ghost-db" names no App and no service/);
    expect(message).toMatch(/Hub secret scope "web-worker" names no App and no service/);
    expect(message).not.toContain("orphan");
  });

  it("reads a scope with no `-` as an App-wide scope even before the App is deployed", () => {
    const path = scopeFixture("undeployed", { secrets: { later: { TOKEN: "early" } } });
    expect(secretRowsOf(path)).toEqual([{ app: "later", values: { TOKEN: "early" } }]);
  });

  it("splits every `-` position, so `a-b-c` is refused when two splits are services", () => {
    const path = scopeFixture("two-splits", {
      apps: { a: ["b-c"], "a-b": ["c"] },
      secrets: { "a-b-c": { TOKEN: "x" } },
    });
    expect(() => readHubState(path, HUB_KEY)).toThrow(
      /it names service "b-c" of App "a" and service "c" of App "a-b"/,
    );
  });

  it("imports resolved scopes so App web and App web-api deploy with their own values", async () => {
    const t = convexTest(schema, modules);
    const path = scopeFixture("resolved-import", {
      apps: { web: ["api"] },
      routes: ["web-app"],
      secrets: { "web-api": { TOKEN: "service" }, "web-app": { TOKEN: "app" } },
    });
    const state = readHubState(path, HUB_KEY);
    await t.action(internal.infra.hubImport.run, { batches: state.batches });
    const stored = await t.run(async (ctx) =>
      (await ctx.db.query("appSecrets").collect()).map((r) => [r.app, r.service ?? null, r.name]),
    );
    expect(stored.toSorted()).toEqual([
      ["web", "api", "TOKEN"],
      ["web-app", null, "TOKEN"],
    ]);
  });
});

/** Drops the fields a repeat import legitimately rewrites: write times, not content. */
const strip = <T extends { _creationTime: number; updatedAt?: number; allocatedAt?: number }>(
  rows: T[],
) =>
  rows.map(({ _creationTime, updatedAt: _updatedAt, allocatedAt: _allocatedAt, ...rest }) => rest);

async function snapshot(t: Harness) {
  return await t.run(async (ctx) => {
    return {
      users: (await ctx.db.query("users").collect())
        .map(({ _creationTime, ...rest }) => rest)
        .toSorted((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)),
      nodes: (await ctx.db.query("nodes").collect()).map(
        ({ _creationTime, createdAt: _createdAt, ...rest }) => rest,
      ),
      apps: strip(await ctx.db.query("apps").collect()),
      routes: strip(await ctx.db.query("appRoutes").collect()),
      meshLinks: strip(await ctx.db.query("meshLinks").collect()),
      ports: strip(await ctx.db.query("portAllocations").collect()),
      secretRows: (await ctx.db.query("appSecrets").collect()).map(({ app, service, name }) => ({
        app,
        service,
        name,
      })),
      bindings: strip(await ctx.db.query("gitBindings").collect()),
      deployments: strip(await ctx.db.query("appDeployments").withIndex("by_startedAt").collect()),
      audit: strip(await ctx.db.query("auditEvents").withIndex("by_seq").collect()),
    };
  });
}
