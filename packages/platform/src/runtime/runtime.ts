// Runs the backend's unmodified Convex functions against the SQLite store by answering Convex's
// syscalls (ADR 0019). Convex's own npm code builds `ctx` and turns every `ctx` call into a
// syscall on `globalThis.Convex`; this runtime answers them.
//
// Concurrency: one Runtime serializes every query and mutation through one queue, so a query
// reads one consistent state and mutations are serializable, as on Convex. Actions run outside
// the queue and reach the store only through nested queries and mutations, which queue.

import { AsyncLocalStorage } from "node:async_hooks";

import { actionGeneric, mutationGeneric, queryGeneric } from "convex/server";
import { convexToJson, jsonToConvex, type JSONValue, type Value } from "convex/values";

import { prefixRange } from "../store/keys.ts";
import { planFromSerialized, type SerializedQuery } from "../store/serialized.ts";
import type { Sql } from "../store/sql.ts";
import { Store, type Row, type SchemaInfo, type Transaction } from "../store/store.ts";
import { CRON_STATE, cronSpecs, type CronSpec, enqueueDueCrons, nextCronDue } from "./crons.ts";
import { Files, STORAGE, UPLOADS, type FileStore } from "./files.ts";
import { FunctionError, asFunctionError, rethrowable } from "./functionError.ts";
import { checkJson, type JsonValidator } from "./validateJson.ts";

export { FunctionError } from "./functionError.ts";

export type { FileStore } from "./files.ts";

export type Kind = "query" | "mutation" | "action";

/** A module's exports, keyed by the module's path under convex/ without extension. */
export type Modules = Record<string, Record<string, unknown>>;

/** The user identity `ctx.auth.getUserIdentity()` returns, or null when signed out. */
export type Identity = Record<string, JSONValue> | null;

export type QueryOutcome =
  | { ok: true; value: Value; reads: ReadonlySet<string> }
  | { ok: false; error: FunctionError; reads: ReadonlySet<string> };

export type RuntimeOptions = {
  modules: Modules;
  schema: SchemaInfo;
  sql: Sql;
  files?: FileStore;
  /** The deployment's public URL, for `ctx.storage.getUrl` and `process.env.CONVEX_SITE_URL`. */
  siteUrl?: string;
  /** Called with the time the next scheduled function or cron is due, or null when none is. */
  setAlarm?: (at: number | null) => void;
  now?: () => number;
  /**
   * Treat a match on the root prefix route ("/*") as no match. The backend registers that route
   * only for Convex's static-hosting component; on Cloudflare, Workers Static Assets serves the
   * dashboard instead.
   */
  staticCatchAll?: boolean;
};

type Invocation = {
  runtime: Runtime;
  kind: Kind;
  tx: Transaction | null;
  identity: Identity;
  udfPath: string;
  requestId: string;
  scheduledFunctionId: string | null;
  streams: Map<string, Iterator<Row>>;
};

type RegisteredFunction = {
  isQuery?: boolean;
  isMutation?: boolean;
  isAction?: boolean;
  isHttp?: boolean;
  isPublic?: boolean;
  isInternal?: boolean;
  exportArgs(): string;
  exportReturns?: () => string | null;
  invokeQuery?(args: string): Promise<string>;
  invokeMutation?(args: string): Promise<string>;
  invokeAction?(requestId: string, args: string): Promise<string>;
  invokeHttpAction?(request: Request): Promise<Response>;
};

const als = new AsyncLocalStorage<Invocation>();

function currentInvocation(op: string): Invocation {
  const inv = als.getStore();
  if (!inv) throw new Error(`Convex syscall ${op} outside a function invocation`);
  return inv;
}

let globalInstalled = false;
function installGlobalConvex(): void {
  if (globalInstalled) return;
  globalInstalled = true;
  (globalThis as { Convex?: unknown }).Convex = {
    syscall(op: string, args: string): string {
      const inv = currentInvocation(op);
      return JSON.stringify(inv.runtime.syscall(inv, op, JSON.parse(args)));
    },
    async asyncSyscall(op: string, args: string): Promise<string> {
      const inv = currentInvocation(op);
      return JSON.stringify(await inv.runtime.asyncSyscall(inv, op, JSON.parse(args)));
    },
    // Actions pass Blobs through jsSyscall, unserialized (storage_impl.js in convex).
    jsSyscall(op: string, args: Record<string, unknown>): Promise<unknown> {
      const inv = currentInvocation(op);
      return inv.runtime.jsSyscall(inv, op, args);
    },
  };
}

/** Set on the 404 for a path no HTTP route matches, so a host can fall back to static files. */
export const NO_ROUTE = "X-EraInfra-No-Route";

const SCHEDULED = "_scheduled_functions";

/** System tables and the indexes the runtime needs on them. */
export function withSystemTables(schema: SchemaInfo): SchemaInfo {
  return {
    ...schema,
    tables: {
      ...schema.tables,
      [SCHEDULED]: { indexes: { by_state_time: ["state.kind", "scheduledTime"] } },
      [STORAGE]: { indexes: {} },
      [CRON_STATE]: { indexes: { by_name: ["name"] } },
      [UPLOADS]: { indexes: { by_token: ["token"] } },
    },
  };
}

function normalizeModulePath(path: string): string {
  return path.replace(/^\.\//, "").replace(/\.(js|ts|mjs|cjs|jsx|tsx)$/, "");
}

/** Builds a Modules map from `import.meta.glob`-style keys such as "./infra/nodes.ts". */
export function modulesFrom(entries: Record<string, Record<string, unknown>>): Modules {
  const out: Modules = {};
  for (const [k, v] of Object.entries(entries)) out[normalizeModulePath(k)] = v;
  return out;
}

function newRequestId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

export class Runtime {
  readonly store: Store;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private readonly files: Files;
  private readonly crons: CronSpec[];

  constructor(private readonly options: RuntimeOptions) {
    installGlobalConvex();
    this.store = new Store(options.sql, withSystemTables(options.schema));
    this.now = options.now ?? Date.now;
    this.crons = cronSpecs(options.modules);
    this.files = new Files({
      store: this.store,
      serialized: (fn) => this.serialized(fn),
      now: () => this.now(),
      siteUrl: options.siteUrl,
      files: options.files,
    });
  }

  /** Stores the body of a POST to an upload URL. Returns the storage ID, or null for a bad token. */
  upload(token: string, bytes: Uint8Array, contentType: string | undefined) {
    return this.files.upload(token, bytes, contentType);
  }

  /** A stored file's bytes, for serving `ctx.storage.getUrl` URLs. */
  readFile(id: string) {
    return this.files.bytes(null, id);
  }

  // ---- function lookup ----------------------------------------------------------------------

  private resolve(udfPath: string): { fn: RegisteredFunction; path: string } {
    const [modulePart, exportName = "default"] = udfPath.split(":");
    const path = normalizeModulePath(modulePart as string);
    const mod = this.options.modules[path];
    const fn = mod?.[exportName] as RegisteredFunction | undefined;
    if (!fn || (typeof fn.exportArgs !== "function" && !fn.isHttp)) {
      throw new Error(`Could not find function "${udfPath}"`);
    }
    return { fn, path: `${path}:${exportName}` };
  }

  private kindOf(fn: RegisteredFunction): Kind {
    if (fn.isQuery) return "query";
    if (fn.isMutation) return "mutation";
    if (fn.isAction) return "action";
    throw new Error("not a query, mutation or action");
  }

  // ---- public entry points ------------------------------------------------------------------

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Runs a public or internal function by path ("module:export") from outside the backend. */
  async run(
    udfPath: string,
    args: Value,
    opts: { identity?: Identity; expect?: Kind; publicOnly?: boolean } = {},
  ): Promise<Value> {
    const { fn, path } = this.resolve(udfPath);
    const kind = this.kindOf(fn);
    if (opts.expect && opts.expect !== kind)
      throw new Error(`"${udfPath}" is a ${kind}, not a ${opts.expect}`);
    if (opts.publicOnly && !fn.isPublic)
      throw new Error(`Could not find public function "${udfPath}"`);
    const identity = opts.identity ?? null;
    if (kind === "action") return this.invokeAction(fn, path, args, identity, null);
    return this.serialized(() => this.transaction(kind, fn, path, args, identity, null));
  }

  /**
   * Runs public queries for live subscriptions, all against one snapshot. Each result carries the
   * tables its query read, so a commit to any other table cannot change it.
   */
  runQueries(
    queries: readonly { udfPath: string; args: Value }[],
    identity: Identity,
  ): Promise<QueryOutcome[]> {
    return this.serialized(async () => {
      const out: QueryOutcome[] = [];
      for (const { udfPath, args } of queries) {
        const tx = this.store.begin();
        try {
          const { fn, path } = this.resolve(udfPath);
          if (!fn.isQuery || !fn.isPublic)
            throw new Error(`Could not find public query "${udfPath}"`);
          this.checkArgs(fn, path, args, tx);
          const inv = this.invocation("query", tx, identity, path, null);
          const value = await this.call(fn, "query", inv, args);
          this.checkReturns(fn, path, value, tx);
          out.push({ ok: true, value, reads: tx.reads });
        } catch (err) {
          out.push({ ok: false, error: asFunctionError(err), reads: tx.reads });
        }
      }
      return out;
    });
  }

  /** Runs `fn` with a raw transaction, for tests and data migrations (convex-test's `t.run`). */
  runInTransaction<T>(fn: (tx: Transaction) => Promise<T> | T): Promise<T> {
    return this.serialized(async () => {
      const tx = this.store.begin();
      const result = await fn(tx);
      tx.commit();
      this.armAlarm();
      return result;
    });
  }

  /**
   * Runs `handler` as an anonymous query, mutation or action with a real Convex `ctx`, and returns
   * whatever it returns, unconverted. convex-test's `t.run` is this with kind "mutation".
   */
  async inline<T>(
    kind: Kind,
    handler: (ctx: never) => Promise<T> | T,
    identity: Identity = null,
  ): Promise<T> {
    let out: T | undefined;
    const wrapped = async (ctx: never) => {
      out = await handler(ctx);
      return null;
    };
    const builder =
      kind === "query" ? queryGeneric : kind === "mutation" ? mutationGeneric : actionGeneric;
    const fn = (builder as (d: unknown) => unknown)({ handler: wrapped }) as RegisteredFunction;
    if (kind === "action") await this.invokeAction(fn, "inline", {}, identity, null);
    else await this.serialized(() => this.transaction(kind, fn, "inline", {}, identity, null));
    return out as T;
  }

  /** Answers an HTTP request with the backend's `http.ts` router. */
  async http(request: Request): Promise<Response> {
    const router = this.options.modules.http?.default as
      | { lookup(path: string, method: string): [RegisteredFunction, string, string] | null }
      | undefined;
    if (!router) return new Response("No HTTP routes", { status: 404 });
    const url = new URL(request.url);
    const match = router.lookup(url.pathname, request.method as never);
    // With `staticCatchAll`, the root prefix route "/*" belongs to Convex's static-hosting
    // component, whose job the host's static files do; treat it as no match.
    const isStaticCatchAll = this.options.staticCatchAll === true && match?.[2] === "/*";
    if (!match || isStaticCatchAll) {
      return new Response("No matching route", { status: 404, headers: { [NO_ROUTE]: "1" } });
    }
    const [handler] = match;
    const inv = this.invocation(
      "action",
      null,
      null,
      `http:${request.method} ${url.pathname}`,
      null,
    );
    return als.run(inv, () =>
      (handler.invokeHttpAction as (r: Request) => Promise<Response>)(request),
    );
  }

  // ---- invocation ---------------------------------------------------------------------------

  private invocation(
    kind: Kind,
    tx: Transaction | null,
    identity: Identity,
    udfPath: string,
    scheduledFunctionId: string | null,
  ): Invocation {
    return {
      runtime: this,
      kind,
      tx,
      identity,
      udfPath,
      requestId: newRequestId(),
      scheduledFunctionId,
      streams: new Map(),
    };
  }

  private checkArgs(
    fn: RegisteredFunction,
    path: string,
    args: Value,
    tx: Transaction | null,
  ): void {
    const validator = JSON.parse(fn.exportArgs()) as JsonValidator;
    const err = checkJson(validator, args, "args", (id) => this.tableOfId(id, tx));
    if (err) throw new Error(`ArgumentValidationError in ${path}: ${err}`);
  }

  private checkReturns(
    fn: RegisteredFunction,
    path: string,
    result: Value,
    tx: Transaction | null,
  ): void {
    const exported = fn.exportReturns?.();
    if (!exported) return;
    const validator = JSON.parse(exported) as JsonValidator | null;
    if (!validator) return;
    const err = checkJson(validator, result, "return value", (id) => this.tableOfId(id, tx));
    if (err) throw new Error(`ReturnsValidationError in ${path}: ${err}`);
  }

  private tableOfId(id: string, tx: Transaction | null): string | null {
    return tx ? tx.tableOfId(id) : this.store.tableOfId(id);
  }

  private async call(
    fn: RegisteredFunction,
    kind: Kind,
    inv: Invocation,
    args: Value,
  ): Promise<Value> {
    const argsStr = JSON.stringify(convexToJson([args]));
    let resultStr: string;
    try {
      resultStr = await als.run(inv, () => {
        if (kind === "query") return (fn.invokeQuery as (a: string) => Promise<string>)(argsStr);
        if (kind === "mutation")
          return (fn.invokeMutation as (a: string) => Promise<string>)(argsStr);
        return (fn.invokeAction as (r: string, a: string) => Promise<string>)(
          inv.requestId,
          argsStr,
        );
      });
    } catch (err) {
      throw asFunctionError(err);
    } finally {
      inv.streams.clear();
    }
    return jsonToConvex(JSON.parse(resultStr));
  }

  /** A query or mutation in its own transaction. Commits a mutation unless it throws. */
  private async transaction(
    kind: Kind,
    fn: RegisteredFunction,
    path: string,
    args: Value,
    identity: Identity,
    scheduledFunctionId: string | null,
    beforeCommit?: (tx: Transaction) => void,
  ): Promise<Value> {
    const tx = this.store.begin();
    this.checkArgs(fn, path, args, tx);
    const inv = this.invocation(kind, tx, identity, path, scheduledFunctionId);
    const result = await this.call(fn, kind, inv, args);
    this.checkReturns(fn, path, result, tx);
    if (kind === "mutation") {
      beforeCommit?.(tx);
      tx.commit();
      this.armAlarm();
    }
    return result;
  }

  private async invokeAction(
    fn: RegisteredFunction,
    path: string,
    args: Value,
    identity: Identity,
    scheduledFunctionId: string | null,
  ): Promise<Value> {
    this.checkArgs(fn, path, args, null);
    const inv = this.invocation("action", null, identity, path, scheduledFunctionId);
    const result = await this.call(fn, "action", inv, args);
    this.checkReturns(fn, path, result, null);
    return result;
  }

  // A nested query or mutation called from a query or mutation runs inside the caller's
  // transaction. A nested mutation that throws rolls back only its own writes, as in Convex.
  private async nestedInTransaction(
    inv: Invocation,
    kind: Kind,
    udfPath: string,
    args: Value,
  ): Promise<Value> {
    const { fn, path } = this.resolve(udfPath);
    const calleeKind = this.kindOf(fn);
    if (calleeKind !== kind) throw new Error(`"${udfPath}" is a ${calleeKind}, not a ${kind}`);
    if (inv.kind === "query" && kind === "mutation")
      throw new Error("A query cannot run a mutation");
    const tx = inv.tx as Transaction;
    this.checkArgs(fn, path, args, tx);
    const saved = new Map(tx.writes);
    const child = this.invocation(kind, tx, inv.identity, path, null);
    try {
      const result = await this.call(fn, kind, child, args);
      this.checkReturns(fn, path, result, tx);
      return result;
    } catch (err) {
      tx.writes.clear();
      for (const [k, v] of saved) tx.writes.set(k, v);
      throw err;
    }
  }

  // ---- syscalls -----------------------------------------------------------------------------

  private requireTx(inv: Invocation, op: string): Transaction {
    if (!inv.tx) throw new Error(`${op} is only available in queries and mutations`);
    return inv.tx;
  }

  private requireMutation(inv: Invocation, op: string): Transaction {
    if (inv.kind !== "mutation" || !inv.tx) throw new Error(`${op} is only available in mutations`);
    return inv.tx;
  }

  /** Synchronous syscalls. */
  syscall(inv: Invocation, op: string, args: Record<string, JSONValue>): JSONValue {
    switch (op) {
      case "1.0/db/normalizeId": {
        const tx = this.requireTx(inv, op);
        return { id: tx.normalizeId(args.table as string, args.idString as string) };
      }
      case "1.0/queryStream": {
        const tx = this.requireTx(inv, op);
        const { plan, limit } = planFromSerialized(
          this.store,
          args.query as unknown as SerializedQuery,
        );
        const rows = tx.scan(plan);
        const limited = limit === null ? rows : take(rows, limit);
        const queryId = `${inv.streams.size + 1}:${crypto.randomUUID()}`;
        inv.streams.set(queryId, limited[Symbol.iterator]());
        return { queryId };
      }
      case "1.0/queryCleanup":
        inv.streams.delete(args.queryId as string);
        return {};
      case "1.0/getSnapshotTs":
        return convexToJson(BigInt(Math.floor(this.now() * 1e6)));
      default:
        throw new Error(`Convex syscall ${op} is not supported on the Cloudflare platform`);
    }
  }

  /** Asynchronous syscalls. */
  async asyncSyscall(
    inv: Invocation,
    op: string,
    args: Record<string, JSONValue>,
  ): Promise<JSONValue> {
    switch (op) {
      // -- database --
      case "1.0/get": {
        const tx = this.requireTx(inv, op);
        const id = jsonToConvex(args.id as JSONValue) as string;
        const table = args.table as string | undefined;
        const doc = await (table ? tx.get(table, id) : tx.get(id));
        if (doc && !args.isSystem && this.tableOfId(id, tx)?.startsWith("_")) return null;
        return doc === null ? null : convexToJson(doc as Value);
      }
      case "1.0/insert": {
        const tx = this.requireMutation(inv, op);
        const id = await tx.insert(
          args.table as string,
          jsonToConvex(args.value as JSONValue) as never,
        );
        return { _id: id };
      }
      case "1.0/shallowMerge": {
        const tx = this.requireMutation(inv, op);
        const value = patchFromJson(args.value as Record<string, JSONValue>);
        if (args.table) await tx.patch(args.table as string, args.id as string, value);
        else await tx.patch(args.id as string, value);
        return {};
      }
      case "1.0/replace": {
        const tx = this.requireMutation(inv, op);
        const value = jsonToConvex(args.value as JSONValue) as never;
        if (args.table) await tx.replace(args.table as string, args.id as string, value);
        else await tx.replace(args.id as string, value);
        return {};
      }
      case "1.0/remove": {
        const tx = this.requireMutation(inv, op);
        if (args.table) await tx.delete(args.table as string, args.id as string);
        else await tx.delete(args.id as string);
        return {};
      }
      case "1.0/queryStreamNext": {
        const stream = inv.streams.get(args.queryId as string);
        if (!stream) throw new Error("query stream is closed");
        const next = stream.next();
        return next.done
          ? { value: null, done: true }
          : { value: convexToJson(next.value.doc as Value), done: false };
      }
      case "1.0/queryPage": {
        const tx = this.requireTx(inv, op);
        const { plan } = planFromSerialized(this.store, args.query as unknown as SerializedQuery);
        const res = tx.page(plan, {
          numItems: args.pageSize as number,
          cursor: (args.cursor as string | null) ?? null,
        });
        return {
          page: res.page.map((d) => convexToJson(d as Value)),
          isDone: res.isDone,
          continueCursor: res.continueCursor,
          splitCursor: null,
          pageStatus: null,
        };
      }
      case "1.0/count": {
        const tx = this.requireTx(inv, op);
        let n = 0;
        for (const _ of tx.scan({
          table: args.table as string,
          index: "by_creation_time",
          lo: "",
          hi: "g",
          desc: false,
          matches: () => true,
        }))
          n++;
        return n;
      }

      // -- auth and metadata --
      case "1.0/getUserIdentity":
        return inv.identity;
      case "1.0/getRequestMetadata":
        return {
          ip: null,
          userAgent: null,
          requestId: inv.requestId,
          scheduledFunctionId: inv.scheduledFunctionId,
          authToken: null,
        };
      case "1.0/getFunctionMetadata":
        return { name: inv.udfPath, componentPath: "" };
      case "1.0/getDeploymentMetadata":
        return { name: "cloudflare", region: null, url: this.options.siteUrl ?? null };
      case "1.0/getTransactionMetrics":
        return {
          bytesRead: { used: 0, remaining: 1 << 30 },
          bytesWritten: { used: 0, remaining: 1 << 30 },
          databaseQueries: { used: 0, remaining: 1 << 20 },
          documentsRead: { used: 0, remaining: 1 << 20 },
          documentsWritten: { used: 0, remaining: 1 << 20 },
          functionsScheduled: { used: 0, remaining: 1 << 20 },
          scheduledFunctionArgsBytes: { used: 0, remaining: 1 << 30 },
        };
      case "1.0/auditLog":
        return {};

      // -- nested calls --
      case "1.0/runUdf": {
        const udfPath = this.udfPathOf(args);
        const udfArgs = jsonToConvex(args.args as JSONValue);
        const udfType = args.udfType as string;
        const kind: Kind = udfType === "mutation" ? "mutation" : "query";
        return convexToJson(await this.nested(inv, kind, udfPath, udfArgs));
      }
      case "1.0/actions/query":
      case "1.0/actions/mutation":
      case "1.0/actions/action": {
        if (inv.kind !== "action") throw new Error(`${op} is only available in actions`);
        const kind = op.slice("1.0/actions/".length) as Kind;
        const udfPath = this.udfPathOf(args);
        const udfArgs = jsonToConvex(args.args as JSONValue);
        const { fn, path } = this.resolve(udfPath);
        const calleeKind = this.kindOf(fn);
        if (calleeKind !== kind) throw new Error(`"${udfPath}" is a ${calleeKind}, not a ${kind}`);
        try {
          const result =
            kind === "action"
              ? await this.invokeAction(fn, path, udfArgs, inv.identity, null)
              : await this.serialized(() =>
                  this.transaction(kind, fn, path, udfArgs, inv.identity, null),
                );
          return convexToJson(result);
        } catch (err) {
          throw rethrowable(err);
        }
      }

      // -- scheduler --
      case "1.0/schedule":
        return this.schedule(this.requireMutation(inv, op), args);
      case "1.0/actions/schedule":
        return this.serialized(async () => {
          const tx = this.store.begin();
          const id = this.schedule(tx, args);
          tx.commit();
          this.armAlarm();
          return id;
        });
      case "1.0/cancel_job":
        this.cancel(this.requireMutation(inv, op), args.id as JSONValue);
        return {};
      case "1.0/actions/cancel_job":
        await this.serialized(async () => {
          const tx = this.store.begin();
          this.cancel(tx, args.id as JSONValue);
          tx.commit();
          this.armAlarm();
        });
        return {};

      // -- files --
      case "1.0/storageGenerateUploadUrl":
        return this.files.uploadUrl(inv.tx);
      case "1.0/storageStore":
        return this.files.store(
          inv.tx,
          Uint8Array.from(atob(args.blob as string), (c) => c.charCodeAt(0)),
          (args.contentType as string | undefined) || undefined,
        );
      case "1.0/storageGet":
        return this.files.getJson(inv.tx, args.storageId as string);
      case "1.0/storageGetUrl":
        return this.files.url(inv.tx, args.storageId as string);
      case "1.0/storageGetMetadata":
        return this.files.metadata(inv.tx, args.storageId as string);
      case "1.0/storageDelete":
        await this.files.delete(inv.tx, args.storageId as string);
        return {};
      default:
        throw new Error(`Convex syscall ${op} is not supported on the Cloudflare platform`);
    }
  }

  /** Syscalls whose arguments are JavaScript objects, not JSON. */
  async jsSyscall(inv: Invocation, op: string, args: Record<string, unknown>): Promise<unknown> {
    switch (op) {
      case "storage/storeBlob": {
        const blob = args.blob as Blob;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        return this.files.store(inv.tx, bytes, blob.type || undefined);
      }
      case "storage/getBlob": {
        const file = await this.files.bytes(inv.tx, args.storageId as string);
        return file
          ? new Blob([file.bytes.slice().buffer], { type: file.contentType ?? "" })
          : null;
      }
      default:
        throw new Error(`Convex jsSyscall ${op} is not supported on the Cloudflare platform`);
    }
  }

  private udfPathOf(args: Record<string, JSONValue>): string {
    if (typeof args.name === "string") return args.name;
    if (typeof args.functionHandle === "string") {
      throw new Error("Function handles are not supported on the Cloudflare platform");
    }
    throw new Error(
      "Function references into components are not supported on the Cloudflare platform",
    );
  }

  private async nested(inv: Invocation, kind: Kind, udfPath: string, args: Value): Promise<Value> {
    try {
      if (inv.tx) return await this.nestedInTransaction(inv, kind, udfPath, args);
      const { fn, path } = this.resolve(udfPath);
      return await this.serialized(() =>
        this.transaction(kind, fn, path, args, inv.identity, null),
      );
    } catch (err) {
      throw rethrowable(err);
    }
  }

  // ---- scheduler ----------------------------------------------------------------------------

  private schedule(tx: Transaction, args: Record<string, JSONValue>): JSONValue {
    const udfPath = this.udfPathOf(args);
    const { fn } = this.resolve(udfPath);
    if (!fn.isMutation && !fn.isAction)
      throw new Error(`"${udfPath}" is not a mutation or an action`);
    const id = tx.insertSystem(SCHEDULED, {
      name: udfPath,
      args: [jsonToConvex(args.args as JSONValue)],
      scheduledTime: (args.ts as number) * 1000,
      state: { kind: "pending" },
    });
    return convexToJson(id);
  }

  private cancel(tx: Transaction, idJson: JSONValue): void {
    const id = jsonToConvex(idJson) as string;
    const found = tx.writes.get(id) ?? this.store.readDoc(id);
    const state = (found?.doc as { state?: { kind: string } } | null)?.state?.kind;
    if (state === "pending" || state === "inProgress")
      tx.patchSystem(id, { state: { kind: "canceled" } });
  }

  private nextDue(): number | null {
    const tx = this.store.begin();
    const next = tx
      .scan({
        table: SCHEDULED,
        index: "by_state_time",
        ...prefixRange(["pending"]),
        desc: false,
        matches: () => true,
      })
      .next();
    const scheduled = next.done ? null : (next.value.doc.scheduledTime as number);
    const cron = nextCronDue(tx, this.crons, this.now());
    if (scheduled === null) return cron;
    if (cron === null) return scheduled;
    return Math.min(scheduled, cron);
  }

  /** When the earliest pending scheduled function is due, or null if none is pending. */
  nextScheduledTime(): number | null {
    const next = this.store
      .begin()
      .scan({
        table: SCHEDULED,
        index: "by_state_time",
        ...prefixRange(["pending"]),
        desc: false,
        matches: () => true,
      })
      .next();
    return next.done ? null : (next.value.doc.scheduledTime as number);
  }

  private armAlarm(): void {
    this.options.setAlarm?.(this.nextDue());
  }

  /** Arms the alarm for whatever is due next. A host calls this once when it starts. */
  start(): void {
    this.armAlarm();
  }

  /**
   * Runs every scheduled function and cron due at `now`, then re-arms the alarm. A Durable
   * Object calls this from `alarm()`. Mutations run exactly once: the state change commits in
   * the mutation's own transaction. Actions run at most once: they are marked in progress first.
   */
  async runDue(opts: { ignoreTime?: boolean; crons?: boolean } = {}): Promise<number> {
    let ran = 0;
    if (opts.crons !== false) {
      await this.serialized(async () => {
        const tx = this.store.begin();
        enqueueDueCrons(tx, this.crons, this.now(), SCHEDULED);
        tx.commit();
      });
    }
    for (;;) {
      const due = await this.serialized(async () => {
        const tx = this.store.begin();
        const next = tx
          .scan({
            table: SCHEDULED,
            index: "by_state_time",
            ...prefixRange(["pending"]),
            desc: false,
            matches: () => true,
          })
          .next();
        if (next.done) return null;
        if (!opts.ignoreTime && (next.value.doc.scheduledTime as number) > this.now()) return null;
        return next.value.doc;
      });
      if (!due) break;
      ran++;
      await this.runScheduled(
        due._id as string,
        due.name as string,
        (due.args as Value[])[0] as Value,
      );
    }
    this.armAlarm();
    return ran;
  }

  private async runScheduled(id: string, udfPath: string, args: Value): Promise<void> {
    let fn: RegisteredFunction;
    let path: string;
    try {
      ({ fn, path } = this.resolve(udfPath));
    } catch (err) {
      await this.finish(id, { kind: "failed", error: String((err as Error).message) });
      return;
    }
    if (fn.isMutation) {
      try {
        await this.serialized(() =>
          this.transaction("mutation", fn, path, args, null, id, (tx) =>
            tx.patchSystem(id, { state: { kind: "success" }, completedTime: this.now() }),
          ),
        );
      } catch (err) {
        await this.finish(id, { kind: "failed", error: (err as Error).message });
      }
      return;
    }
    await this.finish(id, { kind: "inProgress" }, false);
    try {
      await this.invokeAction(fn, path, args, null, id);
      await this.finish(id, { kind: "success" });
    } catch (err) {
      await this.finish(id, { kind: "failed", error: (err as Error).message });
    }
  }

  private finish(id: string, state: Record<string, JSONValue>, completed = true): Promise<void> {
    return this.serialized(async () => {
      const tx = this.store.begin();
      tx.patchSystem(id, completed ? { state, completedTime: this.now() } : { state });
      tx.commit();
    });
  }
}

// Convex encodes a patch's `undefined` fields as { $undefined: null } so they can travel as JSON.
function patchFromJson(value: Record<string, JSONValue>): Record<string, Value | undefined> {
  const out: Record<string, Value | undefined> = {};
  for (const [k, v] of Object.entries(value)) {
    const isUndefined =
      typeof v === "object" && v !== null && !Array.isArray(v) && "$undefined" in v;
    out[k] = isUndefined ? undefined : jsonToConvex(v);
  }
  return out;
}

function* take<T>(it: Iterable<T>, n: number): Generator<T> {
  if (n <= 0) return;
  let i = 0;
  for (const x of it) {
    yield x;
    if (++i >= n) return;
  }
}
