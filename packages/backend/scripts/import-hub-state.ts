/**
 * Copies a Hub's state (portless.db and the key that encrypts its secrets) into this Convex
 * deployment, the first step of ADR 0016 phase 2. Safe to repeat: every row is keyed on what the
 * Hub keyed it on, so a second run changes only what changed on the Hub since the first.
 *
 * Usage, on the Hub's host (the state directory is inside the `portless-data` volume):
 *
 *   CONVEX_URL=https://<deployment>.convex.cloud CONVEX_DEPLOY_KEY=<deploy key> \
 *     node packages/backend/scripts/import-hub-state.ts \
 *       --db /path/to/portless.db --secret-key /path/to/secret.key [--dry-run]
 *
 * The secret key may instead come from PORTLESS_SECRET_KEY or ERAINFRA_SECRET_KEY, as on the Hub.
 * The deployment must have ERAINFRA_SECRETS_MASTER_KEY set before secrets can be imported.
 *
 * Secret plaintext is decrypted here and sent to Convex over TLS in the request body, never on a
 * command line, where any local user could read it from the process list.
 */
import { createDecipheriv } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import type { ImportBatch } from "../convex/infra/hubImport.ts";

type Row = Record<string, unknown>;

export type HubState = {
  batches: ImportBatch[];
  /** What the import leaves behind on purpose, for the operator to replace by hand. */
  notImported: {
    apiTokens: Array<{ name: string; prefix: string; roles: string[] }>;
    sessions: number;
    chatSessions: number;
  };
};

const ROWS_PER_BATCH = 200;

const str = (value: unknown) => (value === null || value === undefined ? undefined : String(value));
const num = (value: unknown) => (value === null || value === undefined ? undefined : Number(value));
const ms = (iso: unknown) => {
  const parsed = Date.parse(String(iso));
  if (Number.isNaN(parsed)) throw new Error(`Not a timestamp: ${String(iso)}`);
  return parsed;
};
/** Drop null and undefined values: Convex optional fields accept a missing key, not null. */
function defined<T extends Record<string, unknown>>(object: T) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== null && value !== undefined),
  ) as { [K in keyof T]: Exclude<T[K], null> };
}

/** The Hub's blob format: `<iv hex>:<tag hex>:<ciphertext hex>`, AES-256-GCM. */
export function decryptHubSecret(key: Buffer, blob: string) {
  const [iv, tag, ciphertext] = blob.split(":");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "hex"));
  decipher.setAuthTag(Buffer.from(tag, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "hex")),
    decipher.final(),
  ]).toString("utf8");
}

export function parseHubSecretKey(hex: string) {
  const trimmed = hex.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new Error("The Hub secret key must be 64 hex characters");
  }
  return Buffer.from(trimmed, "hex");
}

function inBatches<K extends ImportBatch["kind"]>(
  kind: K,
  rows: Extract<ImportBatch, { kind: K }>["rows"],
) {
  const out: ImportBatch[] = [];
  for (let start = 0; start < rows.length; start += ROWS_PER_BATCH) {
    out.push({ kind, rows: rows.slice(start, start + ROWS_PER_BATCH) } as ImportBatch);
  }
  return out;
}

const json = <T>(text: unknown, fallback: T): T =>
  text === null || text === undefined ? fallback : (JSON.parse(String(text)) as T);

/** Reads every table the import copies, in the order the import must apply them. */
export function readHubState(dbPath: string, secretKey: Buffer): HubState {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const all = (sql: string) => db.prepare(sql).all() as Row[];
    const has = (table: string) =>
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !==
      undefined;

    const users = all("SELECT * FROM users ORDER BY created_at").map((r) => ({
      legacyId: String(r.id),
      email: String(r.email),
      name: String(r.name),
      roles: json<string[]>(r.roles, []),
      passwordHash: String(r.password_hash),
      createdAt: ms(r.created_at),
    }));

    const routes = all("SELECT * FROM routes ORDER BY app").map((r) => ({
      name: String(r.app),
      node: String(r.node),
      image: String(r.image),
      port: Number(r.port),
    }));

    type HubService = {
      name: string;
      image: string;
      args?: string[];
      port?: number | null;
      route?: string | null;
      node?: string | null;
      env?: Record<string, string> | null;
    };
    type HubLink = {
      name: string;
      need: string;
      provider: string;
      providerPort: number;
      consumer: string;
      localPort: number;
    };
    const apps = all("SELECT app, node, doc FROM apps ORDER BY app").map((r) => {
      const doc = json<{ services?: HubService[]; links?: HubLink[] }>(r.doc, {});
      return {
        name: String(r.app),
        node: String(r.node),
        services: (doc.services ?? []).map((s) =>
          defined({
            name: s.name,
            image: s.image,
            args: s.args ?? [],
            port: s.port,
            route: s.route,
            node: s.node,
            env: s.env,
          }),
        ),
        links: (doc.links ?? []).map((l) => ({
          name: l.name,
          need: l.need,
          provider: l.provider,
          providerPort: l.providerPort,
          consumer: l.consumer,
          localPort: l.localPort,
        })),
      };
    });

    const links = all("SELECT doc FROM links ORDER BY name").map((r) => {
      const l = json<HubLink & { createdBy?: "user" | "deploy" }>(r.doc, {} as never);
      return defined({
        name: l.name,
        provider: l.provider,
        providerPort: l.providerPort,
        consumer: l.consumer,
        localPort: l.localPort,
        createdBy: l.createdBy,
      });
    });

    const ports = all("SELECT node, key, port FROM ports ORDER BY node, port").map((r) => ({
      node: String(r.node),
      key: String(r.key),
      port: Number(r.port),
    }));

    const secretsByApp = new Map<string, Record<string, string>>();
    for (const r of all("SELECT app, key, blob FROM secrets ORDER BY app, key")) {
      const app = String(r.app);
      const values = secretsByApp.get(app) ?? {};
      values[String(r.key)] = decryptHubSecret(secretKey, String(r.blob));
      secretsByApp.set(app, values);
    }
    const secrets = [...secretsByApp].map(([app, values]) => ({ app, values }));

    type HubBinding = {
      id: string;
      repo: string;
      branch: string;
      name: string;
      buildNode?: string;
      deployNode?: string;
      port?: number;
      lastStatus?: { at: string; sha: string; ok: boolean; stage: string; error?: string };
    };
    const gitBindings = all("SELECT doc FROM git_bindings").map((r) => {
      const b = json<HubBinding>(r.doc, {} as never);
      return defined({
        legacyId: b.id,
        repo: b.repo,
        branch: b.branch,
        app: b.name,
        buildNode: b.buildNode,
        deployNode: b.deployNode,
        port: b.port,
        lastStatus:
          b.lastStatus === undefined || b.lastStatus === null
            ? undefined
            : defined({ ...b.lastStatus, at: ms(b.lastStatus.at) }),
      });
    });

    const deployments = all("SELECT * FROM deployments ORDER BY rowid").map((r) =>
      defined({
        legacyId: String(r.id),
        app: String(r.app),
        stage: String(r.stage) as Extract<
          ImportBatch,
          { kind: "deployments" }
        >["rows"][number]["stage"],
        detail: String(r.detail),
        urls: json<string[]>(r.urls, []),
        error: str(r.error),
        startedAt: ms(r.started_at),
        finishedAt: r.finished_at === null ? undefined : ms(r.finished_at),
      }),
    );

    const audit = all("SELECT * FROM audit ORDER BY seq").map((r) =>
      defined({
        hubSeq: Number(r.seq),
        at: ms(r.at),
        actor: String(r.actor),
        action: String(r.action),
        target: str(r.target),
        outcome: String(r.outcome) as Extract<
          ImportBatch,
          { kind: "audit" }
        >["rows"][number]["outcome"],
        dryRun: num(r.dry_run) === 1 ? true : undefined,
        meta: r.meta === null ? undefined : json<Record<string, unknown>>(r.meta, {}),
      }),
    );

    const apiTokens = all("SELECT name, prefix, roles FROM api_tokens ORDER BY created_at").map(
      (r) => ({
        name: String(r.name),
        prefix: String(r.prefix),
        roles: json<string[]>(r.roles, []),
      }),
    );
    const count = (table: string) =>
      has(table) ? Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as Row).n) : 0;

    return {
      batches: [
        ...inBatches("users", users),
        ...inBatches("routes", routes),
        ...inBatches("apps", apps),
        ...inBatches("links", links),
        ...inBatches("ports", ports),
        ...inBatches("secrets", secrets),
        ...inBatches("gitBindings", gitBindings),
        ...inBatches("deployments", deployments),
        ...inBatches("audit", audit),
      ],
      notImported: {
        apiTokens,
        sessions: count("sessions"),
        chatSessions: count("chat_sessions"),
      },
    };
  } finally {
    db.close();
  }
}

/**
 * Groups batches into action calls of at most `maxBytes` of JSON each, keeping their order.
 * Convex caps a function's arguments; 1 MiB stays far below the cap.
 */
export function planImportCalls(batches: ImportBatch[], maxBytes = 1024 * 1024) {
  const calls: ImportBatch[][] = [];
  let current: ImportBatch[] = [];
  let size = 0;
  for (const batch of batches) {
    const bytes = Buffer.byteLength(JSON.stringify(batch));
    if (current.length > 0 && size + bytes > maxBytes) {
      calls.push(current);
      current = [];
      size = 0;
    }
    current.push(batch);
    size += bytes;
  }
  if (current.length > 0) calls.push(current);
  return calls;
}

function summarize(state: HubState) {
  const rows: Record<string, number> = {};
  for (const batch of state.batches) rows[batch.kind] = (rows[batch.kind] ?? 0) + batch.rows.length;
  return rows;
}

async function main() {
  const { values } = parseArgs({
    options: {
      db: { type: "string" },
      "secret-key": { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  if (values.db === undefined) throw new Error("--db <path to portless.db> is required");
  const keyHex =
    values["secret-key"] === undefined
      ? (process.env.ERAINFRA_SECRET_KEY ?? process.env.PORTLESS_SECRET_KEY)
      : readFileSync(values["secret-key"], "utf8");
  if (keyHex === undefined) {
    throw new Error("--secret-key <path to secret.key> (or PORTLESS_SECRET_KEY) is required");
  }

  const state = readHubState(values.db, parseHubSecretKey(keyHex));
  console.log("Rows read from the Hub:", summarize(state));
  console.log(
    `Not imported: ${state.notImported.sessions} sessions (people sign in again), ` +
      `${state.notImported.chatSessions} chat transcripts (stay on the Hub), ` +
      `${state.notImported.apiTokens.length} API tokens (replace each one):`,
  );
  for (const token of state.notImported.apiTokens) {
    console.log(`  ${token.prefix}…  ${token.name}  [${token.roles.join(", ")}]`);
  }
  if (values["dry-run"]) return;

  const url = process.env.CONVEX_URL;
  const adminKey = process.env.CONVEX_DEPLOY_KEY;
  if (url === undefined || adminKey === undefined) {
    throw new Error("Set CONVEX_URL and CONVEX_DEPLOY_KEY to the target deployment");
  }
  // An internal action is callable only with a deployment's admin key. This is how
  // `npx convex run` calls one (convex/dist/esm/cli/lib/run.js); neither method is in the client's
  // published types.
  const client = new ConvexHttpClient(url) as unknown as {
    setAdminAuth(key: string): void;
    function(reference: unknown, componentPath: undefined, args: unknown): Promise<unknown>;
  };
  client.setAdminAuth(adminKey);
  const reference = makeFunctionReference<"action">("infra/hubImport:run");
  const calls = planImportCalls(state.batches);
  for (const [index, call] of calls.entries()) {
    const applied = await client.function(reference, undefined, { batches: call });
    console.log(`Call ${index + 1}/${calls.length} applied:`, applied);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
