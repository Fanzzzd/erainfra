/**
 * Copies a Hub's state (portless.db and the key that encrypts its secrets) into this Convex
 * deployment, the first step of ADR 0016 phase 2. Safe to repeat: every row is keyed on what the
 * Hub keyed it on, so a second run changes only what changed on the Hub since the first, and never
 * a row Convex has written or deleted since (convex/infra/hubImport.ts). It prints a result for
 * every row that is not unchanged, and exits non-zero when Convex refused any row; the rows Convex
 * did not refuse are applied. Two failures stop more than one row: a Hub state this script refuses
 * (an ambiguous secret scope, a contested route label) throws before anything is sent, and a write
 * that throws fails its whole batch of up to 200 rows, which Convex rolls back while earlier calls
 * stay applied. `--dry-run` asks the deployment what the import would do, writing nothing, when
 * CONVEX_URL and CONVEX_DEPLOY_KEY are set.
 *
 * The Hub's database runs in WAL mode: pass a `VACUUM INTO` snapshot, or a copy of the .db file
 * with its -wal and -shm files taken while the Hub is stopped (docs/runbooks/retire-the-hub.md).
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
import type { ImportBatch, ImportReport } from "../convex/infra/hubImport.ts";
import { isRouteLabel } from "../convex/infra/ingress.ts";

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

/**
 * Splits the Hub's secret scope strings into (app, service) pairs, or refuses the import.
 *
 * The Hub keyed a service's secrets on `<app>-<service>` and an App's on `<app>`, and App and
 * service names may both contain `-`. So `web-api` is App `web-api`'s scope, service `api` of App
 * `web`, or both at once, and the Hub injected it into every one of them. Each string is checked
 * against the Hub's own Apps (the `apps` table and single-container `routes`) and services:
 *
 * - exactly one reading matches: that is the scope;
 * - more than one matches: refused, because importing it either way would hand one App's values
 *   to the other or silently drop what the Hub delivered;
 * - none matches and the string contains `-`: refused, because nothing says where the split is;
 * - none matches and the string has no `-`: the App-wide scope of an App not deployed yet, the
 *   only reading such a string has.
 *
 * Every refused scope is reported in one error, before anything is sent to Convex.
 */
export function resolveHubSecretScopes(
  scopes: readonly string[],
  hub: { apps: readonly string[]; services: ReadonlyArray<{ app: string; service: string }> },
) {
  const apps = new Set(hub.apps);
  const services = new Set(hub.services.map(({ app, service }) => JSON.stringify([app, service])));
  const problems: string[] = [];
  const resolved = scopes.map((scope): { app: string; service?: string } => {
    const readings: Array<{ app: string; service?: string }> = [];
    if (apps.has(scope)) readings.push({ app: scope });
    for (let dash = scope.indexOf("-"); dash !== -1; dash = scope.indexOf("-", dash + 1)) {
      const app = scope.slice(0, dash);
      const service = scope.slice(dash + 1);
      if (services.has(JSON.stringify([app, service]))) readings.push({ app, service });
    }
    if (readings.length === 1) return readings[0];
    if (readings.length === 0 && !scope.includes("-")) return { app: scope };
    if (readings.length === 0) {
      problems.push(
        `Hub secret scope "${scope}" names no App and no service of an App on this Hub, so it ` +
          "cannot be split into an App and a service. Unset its variables on the Hub, or deploy " +
          "the App they belong to, then run the import again.",
      );
    } else {
      const names = readings.map((r) =>
        r.service === undefined ? `App "${r.app}"` : `service "${r.service}" of App "${r.app}"`,
      );
      problems.push(
        `Hub secret scope "${scope}" is ambiguous: it names ${names.join(" and ")}, and the Hub ` +
          "injected its variables into each. Rename the App or the service on the Hub, or unset " +
          "the variables there and set them again after the import with an explicit service, " +
          "then run the import again.",
      );
    }
    return { app: scope };
  });
  if (problems.length > 0) {
    throw new Error(`Refusing to import secrets:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
  return resolved;
}

/**
 * Names the owner of each Hub route, so Convex can refuse another App that claims the label later.
 *
 * The Hub's `routes` table is keyed by label only. A label one Hub App's service routes at belongs
 * to that App and service. A label no App routes at is a single-container App the Hub deployed
 * under that name. A label two Hub Apps route at is refused: the Hub served whichever deployed
 * last, and copying either owner would hand the label to one App while the other still claims it.
 * A label no gateway can serve is refused too.
 */
export function resolveHubRouteOwners<R extends { name: string }>(
  routes: readonly R[],
  apps: ReadonlyArray<{ name: string; services: ReadonlyArray<{ name: string; route?: string }> }>,
): Array<R & { app: string; service?: string }> {
  const problems: string[] = [];
  const owned = routes.map((route) => {
    const claims = apps.flatMap((a) =>
      a.services
        .filter((s) => s.route === route.name)
        .map((s) => ({ app: a.name, service: s.name })),
    );
    // The Hub's data plane took any label of up to 63 characters. A gateway serves only a DNS
    // label (ingress.ts), so one ending in "-" would import and then never be served.
    if (!isRouteLabel(route.name)) {
      problems.push(
        `Hub route "${route.name}" is not a DNS label (it must start and end with a letter or digit), ` +
          "so no gateway would serve it. Redeploy that App on the Hub under another label, then run the import again.",
      );
    }
    if (new Set(claims.map((c) => c.app)).size > 1) {
      problems.push(
        `Hub route "${route.name}" is claimed by ${claims.map((c) => `App "${c.app}"`).join(" and ")}. ` +
          "Change the route of all but one of them on the Hub and redeploy it, then run the import again.",
      );
    }
    return { ...route, ...(claims[0] ?? { app: route.name }) };
  });
  if (problems.length > 0) {
    throw new Error(`Refusing to import routes:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
  return owned;
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

    const hubRoutes = all("SELECT * FROM routes ORDER BY app").map((r) => ({
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

    const routes = resolveHubRouteOwners(hubRoutes, apps);

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
    const scopeStrings = [...secretsByApp.keys()];
    const secrets = resolveHubSecretScopes(scopeStrings, {
      apps: [...hubRoutes.map((r) => r.name), ...apps.map((a) => a.name)],
      services: apps.flatMap((a) => a.services.map((s) => ({ app: a.name, service: s.name }))),
    }).map((scope, index) => ({ ...scope, values: secretsByApp.get(scopeStrings[index])! }));

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

/** One report from the reports of every action call, in call order. */
export function mergeImportReports(reports: readonly ImportReport[]): ImportReport {
  const merged: ImportReport = { counts: {}, items: [] };
  for (const report of reports) {
    for (const [kind, outcomes] of Object.entries(report.counts)) {
      const counts = (merged.counts[kind] ??= {});
      for (const [outcome, n] of Object.entries(outcomes))
        counts[outcome] = (counts[outcome] ?? 0) + n;
    }
    merged.items.push(...report.items);
  }
  return merged;
}

const OUTCOMES = ["created", "updated", "unchanged", "skipped", "refused"] as const;

/**
 * What an import did, or would do, as lines for the operator: a count per table and outcome, then
 * every row that is not unchanged with its reason. `refused` is how many rows Convex refused; the
 * script exits non-zero when it is above zero.
 */
export function formatImportReport(report: ImportReport, dryRun: boolean) {
  const lines = [dryRun ? "What the import would do:" : "What the import did:"];
  for (const [kind, counts] of Object.entries(report.counts)) {
    const parts = OUTCOMES.filter((o) => (counts[o] ?? 0) > 0).map((o) => `${counts[o]} ${o}`);
    lines.push(`  ${kind}: ${parts.join(", ")}`);
  }
  for (const outcome of ["refused", "skipped", "created", "updated"] as const) {
    for (const item of report.items.filter((i) => i.outcome === outcome)) {
      lines.push(
        `  ${outcome}  ${item.kind} ${item.key}${item.reason === undefined ? "" : `: ${item.reason}`}`,
      );
    }
  }
  const refused = report.items.filter((i) => i.outcome === "refused").length;
  if (refused > 0) {
    lines.push(
      `${refused} row(s) refused. Every other row was ${dryRun ? "checked" : "applied"}; ` +
        "fix each refused row on the Hub or in Convex and run the import again.",
    );
  }
  return { lines, refused };
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

  const dryRun = values["dry-run"];
  const url = process.env.CONVEX_URL;
  const adminKey = process.env.CONVEX_DEPLOY_KEY;
  if (url === undefined || adminKey === undefined) {
    if (!dryRun) throw new Error("Set CONVEX_URL and CONVEX_DEPLOY_KEY to the target deployment");
    console.log(
      "Not compared with Convex. Set CONVEX_URL and CONVEX_DEPLOY_KEY to see which rows the " +
        "import would create, update, or skip because Convex owns them.",
    );
    return;
  }
  // An internal function is callable only with a deployment's admin key. This is how
  // `npx convex run` calls one (convex/dist/esm/cli/lib/run.js); neither method is in the client's
  // published types.
  const client = new ConvexHttpClient(url) as unknown as {
    setAdminAuth(key: string): void;
    function(reference: unknown, componentPath: undefined, args: unknown): Promise<ImportReport>;
  };
  client.setAdminAuth(adminKey);
  // A dry run asks Convex what it would do and writes nothing.
  const reference = makeFunctionReference<"action">(
    dryRun ? "infra/hubImport:preview" : "infra/hubImport:run",
  );
  const calls = planImportCalls(state.batches);
  const reports: ImportReport[] = [];
  for (const [index, call] of calls.entries()) {
    reports.push(await client.function(reference, undefined, { batches: call }));
    console.log(`Call ${index + 1}/${calls.length} done`);
  }
  const { lines, refused } = formatImportReport(mergeImportReports(reports), dryRun);
  for (const line of lines) console.log(line);
  if (refused > 0) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
