// THE control-plane database: one SQLite file (node:sqlite — built into Node, zero deps) holding
// users, sessions, tokens, routes, apps, ports, secrets, git bindings, deploy history, and the
// audit trail. WAL mode; single hub process is the single writer. Chosen over per-store JSON files
// once filtering/history mattered (hundreds of apps, deploy + audit queries), and over MySQL/
// Postgres because there's nothing here that needs a network DB server — a file on the /data
// volume is the whole backup story.
//
// Tests get ':memory:' (hermetic, one fresh DB per process; unit tests can create their own via
// createDb). On first boot against real state, the previous generation's JSON stores are imported
// and the files renamed *.imported — a one-way, idempotent migration.
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { renamedEnv, renamedPath } from "./env.ts";

const TEST = process.execArgv.includes("--test") || !!process.env.NODE_TEST_CONTEXT;

// One state dir for everything durable (the DB, the secrets key). Under the hub container
// TMPDIR=/data, so this lands on the persistent volume.
//
// Dual-READ, never dual-create (ADR 0004 Stage 1): a Hub that invented the new directory because
// the old one was merely absent would come up with no accounts, apps, routes or tokens and report
// success — the same silent-empty failure CONTEXT.md rule 4 freezes the portless-data volume over.
// So the new name wins only when it is already there, and a fresh boot still lands on the old one.
export const stateDir = (): string =>
  renamedPath(join(tmpdir(), "erainfra-runtime"), join(tmpdir(), "portless-runtime"));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  roles TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, user_agent TEXT);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS api_tokens (
  hash TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, prefix TEXT NOT NULL,
  roles TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT);
CREATE TABLE IF NOT EXISTS routes (
  app TEXT PRIMARY KEY, node TEXT NOT NULL, image TEXT NOT NULL, port INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS apps (app TEXT PRIMARY KEY, node TEXT NOT NULL, doc TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS links (name TEXT PRIMARY KEY, doc TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ports (
  node TEXT NOT NULL, key TEXT NOT NULL, port INTEGER NOT NULL, PRIMARY KEY (node, key));
CREATE TABLE IF NOT EXISTS secrets (
  app TEXT NOT NULL, key TEXT NOT NULL, blob TEXT NOT NULL, PRIMARY KEY (app, key));
CREATE TABLE IF NOT EXISTS git_bindings (id TEXT PRIMARY KEY, doc TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY, app TEXT NOT NULL, stage TEXT NOT NULL, detail TEXT NOT NULL,
  urls TEXT NOT NULL, error TEXT, started_at TEXT NOT NULL, finished_at TEXT);
CREATE INDEX IF NOT EXISTS deployments_app ON deployments(app, started_at DESC);
CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, host TEXT NOT NULL, project TEXT,
  title TEXT, started_at TEXT, updated_at TEXT, message_count INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS chat_sessions_updated ON chat_sessions(updated_at DESC);
CREATE TABLE IF NOT EXISTS chat_messages (
  session_id TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL,
  model TEXT, at TEXT, text TEXT NOT NULL, PRIMARY KEY (session_id, seq));
CREATE VIRTUAL TABLE IF NOT EXISTS chat_fts USING fts5(text, session_id UNINDEXED, seq UNINDEXED, tokenize='trigram');
CREATE TABLE IF NOT EXISTS audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL,
  action TEXT NOT NULL, target TEXT, outcome TEXT NOT NULL, dry_run INTEGER, meta TEXT);
CREATE INDEX IF NOT EXISTS audit_at ON audit(at DESC);
`;

export function createDb(
  file: string = TEST
    ? ":memory:"
    : (renamedEnv("ERAINFRA_DB_FILE", "PORTLESS_DB_FILE") ??
      renamedPath(join(stateDir(), "erainfra.db"), join(stateDir(), "portless.db"))),
): DatabaseSync {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const d = new DatabaseSync(file);
  if (file !== ":memory:") {
    d.exec("PRAGMA journal_mode = WAL");
    d.exec("PRAGMA busy_timeout = 5000");
    d.exec("PRAGMA synchronous = NORMAL");
  }
  d.exec(SCHEMA);
  // chat_fts needs the trigram tokenizer (substring + CJK search — unicode61 can't tokenize
  // Chinese at all). Rebuild the index once if an older definition exists; source of truth is
  // chat_messages, so this is cheap and lossless.
  const ftsSql =
    (
      d.prepare("SELECT sql FROM sqlite_master WHERE name = 'chat_fts'").get() as
        | { sql: string }
        | undefined
    )?.sql ?? "";
  if (!ftsSql.includes("trigram")) {
    d.exec("DROP TABLE IF EXISTS chat_fts");
    d.exec(
      "CREATE VIRTUAL TABLE chat_fts USING fts5(text, session_id UNINDEXED, seq UNINDEXED, tokenize='trigram')",
    );
    d.exec(
      "INSERT INTO chat_fts (text, session_id, seq) SELECT text, session_id, seq FROM chat_messages",
    );
  }
  if (file !== ":memory:") importLegacyJson(d, dirname(file));
  return d;
}

// Import the pre-SQLite JSON stores (one file per store, same directory) exactly once, then rename
// them *.imported so they can't be double-imported and remain as a manual fallback.
function importLegacyJson(d: DatabaseSync, dir: string): void {
  if (d.prepare("SELECT v FROM meta WHERE k = 'legacy_imported'").get()) return;

  const readJson = (name: string): unknown => {
    const f = join(dir, name);
    if (!existsSync(f)) return undefined;
    try {
      return JSON.parse(readFileSync(f, "utf8"));
    } catch (e) {
      console.error(`[db] skipping unreadable legacy ${name}:`, (e as Error).message);
      return undefined;
    }
  };
  const finish = (name: string) => {
    const f = join(dir, name);
    if (existsSync(f)) {
      try {
        renameSync(f, `${f}.imported`);
      } catch {
        /* leave it; meta guard prevents re-import */
      }
    }
  };

  d.exec("BEGIN");
  try {
    const users =
      (readJson("users.json") as { users?: Array<Record<string, unknown>> } | undefined)?.users ??
      [];
    for (const u of users) {
      d.prepare(
        "INSERT OR IGNORE INTO users (id, email, name, roles, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        String(u.id),
        String(u.email),
        String(u.name),
        JSON.stringify(u.roles ?? []),
        String(u.passwordHash),
        String(u.createdAt),
      );
    }
    const sessions =
      (readJson("sessions.json") as { sessions?: Array<Record<string, unknown>> } | undefined)
        ?.sessions ?? [];
    for (const s of sessions) {
      d.prepare(
        "INSERT OR IGNORE INTO sessions (token_hash, id, user_id, created_at, expires_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(
        String(s.tokenHash),
        String(s.id),
        String(s.userId),
        String(s.createdAt),
        String(s.expiresAt),
        String(s.lastSeenAt),
        s.userAgent == null ? null : String(s.userAgent),
      );
    }
    const tokens =
      (readJson("apitokens.json") as { tokens?: Array<Record<string, unknown>> } | undefined)
        ?.tokens ?? [];
    for (const t of tokens) {
      d.prepare(
        "INSERT OR IGNORE INTO api_tokens (hash, id, name, prefix, roles, created_by, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        String(t.hash),
        String(t.id),
        String(t.name),
        String(t.prefix),
        JSON.stringify(t.roles ?? []),
        String(t.createdBy),
        String(t.createdAt),
        t.lastUsedAt == null ? null : String(t.lastUsedAt),
      );
    }
    const routes = (readJson("routes.json") ?? {}) as Record<
      string,
      { node?: unknown; image?: unknown; port?: unknown }
    >;
    for (const [app, r] of Object.entries(routes)) {
      if (r?.node)
        d.prepare("INSERT OR IGNORE INTO routes (app, node, image, port) VALUES (?, ?, ?, ?)").run(
          app,
          String(r.node),
          String(r.image ?? ""),
          Number(r.port ?? 0),
        );
    }
    const apps = (readJson("apps.json") ?? {}) as Record<string, { node?: unknown }>;
    for (const [app, a] of Object.entries(apps)) {
      if (a?.node)
        d.prepare("INSERT OR IGNORE INTO apps (app, node, doc) VALUES (?, ?, ?)").run(
          app,
          String(a.node),
          JSON.stringify(a),
        );
    }
    const ports = (readJson("ports.json") ?? {}) as Record<string, number>;
    for (const [k, port] of Object.entries(ports)) {
      const sep = k.indexOf("|");
      if (sep > 0 && Number.isInteger(port))
        d.prepare("INSERT OR IGNORE INTO ports (node, key, port) VALUES (?, ?, ?)").run(
          k.slice(0, sep),
          k.slice(sep + 1),
          port,
        );
    }
    const secrets = (readJson("secrets.json") ?? {}) as Record<string, Record<string, string>>;
    for (const [app, kv] of Object.entries(secrets)) {
      for (const [key, blob] of Object.entries(kv ?? {}))
        d.prepare("INSERT OR IGNORE INTO secrets (app, key, blob) VALUES (?, ?, ?)").run(
          app,
          key,
          String(blob),
        );
    }
    const bindings =
      (readJson("git-projects.json") as { bindings?: Array<Record<string, unknown>> } | undefined)
        ?.bindings ?? [];
    for (const b of bindings) {
      if (b?.id)
        d.prepare("INSERT OR IGNORE INTO git_bindings (id, doc) VALUES (?, ?)").run(
          String(b.id),
          JSON.stringify(b),
        );
    }
    // Audit trail (JSONL, append-only). Order preserved; the a-<n> ids restart from the new seq.
    const auditFile =
      renamedEnv("ERAINFRA_AUDIT_FILE", "PORTLESS_AUDIT_FILE") ?? join(dir, "audit.jsonl");
    if (existsSync(auditFile)) {
      for (const line of readFileSync(auditFile, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as Record<string, unknown>;
          d.prepare(
            "INSERT INTO audit (at, actor, action, target, outcome, dry_run, meta) VALUES (?, ?, ?, ?, ?, ?, ?)",
          ).run(
            String(e.at),
            String(e.actor),
            String(e.action),
            e.target == null ? null : String(e.target),
            String(e.outcome),
            e.dryRun ? 1 : 0,
            e.meta ? JSON.stringify(e.meta) : null,
          );
        } catch {
          /* skip a corrupt line rather than lose the trail */
        }
      }
    }
    d.prepare("INSERT INTO meta (k, v) VALUES ('legacy_imported', ?)").run(
      new Date().toISOString(),
    );
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    console.error("[db] legacy import failed (starting empty):", (e as Error).message);
    return;
  }
  for (const f of [
    "users.json",
    "sessions.json",
    "apitokens.json",
    "routes.json",
    "apps.json",
    "ports.json",
    "secrets.json",
    "git-projects.json",
    "audit.jsonl",
  ])
    finish(f);
  console.log("[db] legacy JSON state imported into portless.db");
}

export const db = createDb();
