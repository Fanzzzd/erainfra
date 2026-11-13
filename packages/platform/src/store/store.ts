// A Convex-compatible document store on SQLite, for running the control plane in a Durable
// Object. It implements the `ctx.db` surface the backend uses (get, insert, patch, replace,
// delete, normalizeId, query with withIndex, filter, order, first, unique, take, collect and
// paginate) with Convex's ordering and read-your-writes inside a mutation.
//
// Storage is schema-agnostic: every document is one row of `_docs`, and every index entry is one
// row of `_index` keyed by an order-preserving key (keys.ts). Changing the schema needs no DDL;
// an added or changed index is rebuilt when the store opens.
//
// A Transaction buffers its writes and applies them in one `transactionSync` at commit, so a
// mutation that throws leaves nothing behind, as in Convex.

import { convexToJson, jsonToConvex, type GenericValidator } from "convex/values";

import {
  evaluate,
  filterBuilder,
  IndexRangeBuilder,
  type Doc,
  type Expression,
  fieldValue,
} from "./expressions.ts";
import { encodeKey } from "./keys.ts";
import type { Sql, SqlValue } from "./sql.ts";
import { validateDocument } from "./validate.ts";

export type TableInfo = {
  /** Index name to the indexed fields, without the implicit trailing _creationTime. */
  indexes: Record<string, readonly string[]>;
  /** The table's document validator, or undefined to accept any document. */
  validator?: GenericValidator;
};

export type SchemaInfo = { tables: Record<string, TableInfo>; validate: boolean };

const SYSTEM_INDEXES: Record<string, readonly string[]> = {
  by_creation_time: ["_creationTime"],
  by_id: ["_id"],
};

/** Reads table, index and validator definitions from the result of Convex's `defineSchema`. */
export function schemaInfo(schema: {
  tables: Record<string, unknown>;
  schemaValidation?: boolean;
}): SchemaInfo {
  const tables: Record<string, TableInfo> = {};
  for (const [name, definition] of Object.entries(schema.tables)) {
    const def = definition as {
      " indexes"(): { indexDescriptor: string; fields: string[] }[];
      validator: GenericValidator;
    };
    const indexes: Record<string, readonly string[]> = {};
    for (const index of def[" indexes"]()) indexes[index.indexDescriptor] = index.fields;
    tables[name] = { indexes, validator: def.validator };
  }
  return { tables, validate: schema.schemaValidation !== false };
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

function newId(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += BASE32[b & 31];
  return out;
}

const serialize = (doc: Doc): string => JSON.stringify(convexToJson(doc));
const deserialize = (text: string): Doc => jsonToConvex(JSON.parse(text)) as Doc;

type Write = { table: string; doc: Doc | null };

export type Row = { key: string; doc: Doc };

export class Store {
  private lastCreationTime = 0;

  constructor(
    readonly sql: Sql,
    readonly schema: SchemaInfo,
  ) {
    this.migrate();
  }

  private exec(query: string, ...bindings: SqlValue[]): Record<string, SqlValue>[] {
    return [...this.sql.exec(query, ...bindings)];
  }

  indexesOf(table: string): Record<string, readonly string[]> {
    return { ...SYSTEM_INDEXES, ...this.schema.tables[table]?.indexes };
  }

  private migrate(): void {
    this.sql.transactionSync(() => {
      this.exec(
        "CREATE TABLE IF NOT EXISTS _docs (id TEXT PRIMARY KEY, tbl TEXT NOT NULL, ct REAL NOT NULL, doc TEXT NOT NULL)",
      );
      this.exec("CREATE INDEX IF NOT EXISTS _docs_by_table ON _docs (tbl)");
      this.exec(
        "CREATE TABLE IF NOT EXISTS _index (tbl TEXT NOT NULL, idx TEXT NOT NULL, key TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (tbl, idx, key)) WITHOUT ROWID",
      );
      // Every ID ever issued and its table. A Convex ID encodes its table, so an ID stays valid
      // for `v.id(table)` and `normalizeId` after its document is deleted; this keeps that true.
      this.exec(
        "CREATE TABLE IF NOT EXISTS _ids (id TEXT PRIMARY KEY, tbl TEXT NOT NULL) WITHOUT ROWID",
      );
      this.exec("INSERT OR IGNORE INTO _ids (id, tbl) SELECT id, tbl FROM _docs");
      this.exec(
        "CREATE TABLE IF NOT EXISTS _index_meta (tbl TEXT NOT NULL, idx TEXT NOT NULL, fields TEXT NOT NULL, PRIMARY KEY (tbl, idx)) WITHOUT ROWID",
      );
      const existing = new Map<string, string>();
      for (const row of this.exec("SELECT tbl, idx, fields FROM _index_meta")) {
        existing.set(`${row.tbl as string}\u0000${row.idx as string}`, row.fields as string);
      }
      const wanted = new Map<string, { table: string; index: string; fields: readonly string[] }>();
      const tables = new Set([
        ...Object.keys(this.schema.tables),
        ...this.exec("SELECT DISTINCT tbl FROM _docs").map((r) => r.tbl as string),
      ]);
      for (const table of tables) {
        for (const [index, fields] of Object.entries(this.indexesOf(table))) {
          wanted.set(`${table}\u0000${index}`, { table, index, fields });
        }
      }
      for (const [k, fields] of existing) {
        const want = wanted.get(k);
        if (!want || JSON.stringify(want.fields) !== fields) {
          const [table, index] = k.split("\u0000") as [string, string];
          this.exec("DELETE FROM _index WHERE tbl = ? AND idx = ?", table, index);
          this.exec("DELETE FROM _index_meta WHERE tbl = ? AND idx = ?", table, index);
          existing.delete(k);
        }
      }
      for (const [k, { table, index, fields }] of wanted) {
        if (existing.has(k)) continue;
        for (const row of this.exec("SELECT doc FROM _docs WHERE tbl = ?", table)) {
          const doc = deserialize(row.doc as string);
          this.exec(
            "INSERT INTO _index (tbl, idx, key, id) VALUES (?, ?, ?, ?)",
            table,
            index,
            indexKey(doc, fields),
            doc._id as string,
          );
        }
        this.exec(
          "INSERT INTO _index_meta (tbl, idx, fields) VALUES (?, ?, ?)",
          table,
          index,
          JSON.stringify(fields),
        );
      }
      const max = this.exec("SELECT MAX(ct) AS ct FROM _docs")[0]?.ct;
      this.lastCreationTime = typeof max === "number" ? max : 0;
    });
  }

  /** A strictly increasing creation time, in milliseconds since the epoch. */
  nextCreationTime(): number {
    const now = Date.now();
    this.lastCreationTime = now > this.lastCreationTime ? now : this.lastCreationTime + 1 / 1024;
    return this.lastCreationTime;
  }

  readDoc(id: string): { table: string; doc: Doc } | null {
    const row = this.exec("SELECT tbl, doc FROM _docs WHERE id = ?", id)[0];
    return row ? { table: row.tbl as string, doc: deserialize(row.doc as string) } : null;
  }

  /** The table an ID was issued for, even if its document has since been deleted. */
  tableOfId(id: string): string | null {
    const row = this.exec("SELECT tbl FROM _ids WHERE id = ?", id)[0];
    return row ? (row.tbl as string) : null;
  }

  *scan(table: string, index: string, lo: string, hi: string, desc: boolean): Generator<Row> {
    const rows = this.sql.exec(
      `SELECT i.key AS key, d.doc AS doc FROM _index i JOIN _docs d ON d.id = i.id
       WHERE i.tbl = ? AND i.idx = ? AND i.key >= ? AND i.key < ? ORDER BY i.key ${desc ? "DESC" : "ASC"}`,
      table,
      index,
      lo,
      hi,
    );
    for (const row of rows) yield { key: row.key as string, doc: deserialize(row.doc as string) };
  }

  private readonly commitListeners = new Set<(tables: ReadonlySet<string>) => void>();

  /** Calls `listener` with the tables each commit wrote. Returns a function that unsubscribes. */
  onCommit(listener: (tables: ReadonlySet<string>) => void): () => void {
    this.commitListeners.add(listener);
    return () => this.commitListeners.delete(listener);
  }

  apply(writes: Map<string, Write>): void {
    if (writes.size === 0) return;
    this.write(writes);
    const tables = new Set([...writes.values()].map((w) => w.table));
    for (const listener of this.commitListeners) listener(tables);
  }

  private write(writes: Map<string, Write>): void {
    this.sql.transactionSync(() => {
      for (const [id, { table, doc }] of writes) {
        const stored = this.readDoc(id);
        const indexes = this.indexesOf(table);
        if (stored) {
          for (const [index, fields] of Object.entries(indexes)) {
            this.exec(
              "DELETE FROM _index WHERE tbl = ? AND idx = ? AND key = ?",
              table,
              index,
              indexKey(stored.doc, fields),
            );
          }
        }
        if (doc === null) {
          this.exec("DELETE FROM _docs WHERE id = ?", id);
          continue;
        }
        this.exec("INSERT OR IGNORE INTO _ids (id, tbl) VALUES (?, ?)", id, table);
        this.exec(
          "INSERT INTO _docs (id, tbl, ct, doc) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET doc = excluded.doc",
          id,
          table,
          doc._creationTime as number,
          serialize(doc),
        );
        for (const [index, fields] of Object.entries(indexes)) {
          this.exec(
            "INSERT INTO _index (tbl, idx, key, id) VALUES (?, ?, ?, ?)",
            table,
            index,
            indexKey(doc, fields),
            id,
          );
        }
      }
    });
  }

  /** Starts a transaction. Reads see its own writes; nothing is stored until `commit`. */
  begin(): Transaction {
    return new Transaction(this);
  }

  /** Runs `fn` against a fresh transaction and commits it unless `fn` throws. */
  async run<T>(fn: (db: Transaction) => Promise<T> | T): Promise<T> {
    const tx = this.begin();
    const result = await fn(tx);
    tx.commit();
    return result;
  }
}

/**
 * The fields a range may name on an index: its own, then the implicit _creationTime every user
 * index ends with (the key layout in indexKey already sorts by it).
 */
export function rangeFields(index: string, fields: readonly string[]): readonly string[] {
  return index in SYSTEM_INDEXES ? fields : [...fields, "_creationTime"];
}

export function indexKey(doc: Doc, fields: readonly string[]): string {
  return encodeKey([...fields.map((f) => fieldValue(doc, f)), doc._creationTime, doc._id]);
}

const clone = <T>(v: T): T => structuredClone(v);

export class Transaction {
  readonly writes = new Map<string, Write>();
  /** The tables this transaction read, for invalidating live queries. */
  readonly reads = new Set<string>();
  private committed = false;

  constructor(private readonly store: Store) {}

  private lookup(id: string): { table: string; doc: Doc | null } | null {
    const table = this.tableOf(id);
    if (table) this.reads.add(table);
    const written = this.writes.get(id);
    if (written) return written;
    return this.store.readDoc(id);
  }

  private tableOf = (id: string): string | null =>
    this.writes.get(id)?.table ?? this.store.tableOfId(id);

  private validate(table: string, doc: Doc): void {
    const info = this.store.schema.tables[table];
    if (!info) {
      if (this.store.schema.validate) throw new Error(`Table "${table}" is not in the schema`);
      return;
    }
    if (this.store.schema.validate && info.validator) {
      validateDocument(table, info.validator, doc, this.tableOf);
    }
  }

  // Convex accepts `get(id)` and, newer, `get(table, id)`; the same holds for patch, replace and
  // delete.
  private resolve(args: unknown[]): { id: string; rest: unknown[]; table?: string } {
    if (args.length >= 2 && typeof args[1] === "string") {
      return { table: args[0] as string, id: args[1], rest: args.slice(2) };
    }
    return { id: args[0] as string, rest: args.slice(1) };
  }

  private existing(id: string, table: string | undefined, op: string): { table: string; doc: Doc } {
    const found = this.lookup(id);
    if (!found || found.doc === null) throw new Error(`${op}: no document with ID "${id}"`);
    if (table && found.table !== table)
      throw new Error(`${op}: ID "${id}" is not in table "${table}"`);
    return { table: found.table, doc: found.doc };
  }

  async get(...args: unknown[]): Promise<Doc | null> {
    const { id, table } = this.resolve(args);
    const found = this.lookup(id);
    if (!found || found.doc === null) return null;
    if (table && found.table !== table) return null;
    return clone(found.doc);
  }

  async insert(table: string, value: Doc): Promise<string> {
    if (table.startsWith("_")) throw new Error(`insert: "${table}" is a system table`);
    if ("_id" in value || "_creationTime" in value) {
      throw new Error("insert: the document must not set _id or _creationTime");
    }
    const id = newId();
    const doc = stripUndefined({
      ...clone(value),
      _id: id,
      _creationTime: this.store.nextCreationTime(),
    });
    this.validate(table, doc);
    this.writes.set(id, { table, doc });
    return id;
  }

  async patch(...args: unknown[]): Promise<void> {
    const { id, table, rest } = this.resolve(args);
    const value = rest[0] as Doc;
    const current = this.existing(id, table, "patch");
    for (const field of ["_id", "_creationTime"] as const) {
      if (field in value && value[field] !== undefined && value[field] !== current.doc[field]) {
        throw new Error(`patch: ${field} cannot change`);
      }
    }
    const next: Doc = { ...current.doc };
    for (const [k, v] of Object.entries(clone(value))) {
      if (v === undefined) delete next[k];
      else next[k] = v;
    }
    this.validate(current.table, next);
    this.writes.set(id, { table: current.table, doc: next });
  }

  async replace(...args: unknown[]): Promise<void> {
    const { id, table, rest } = this.resolve(args);
    const value = rest[0] as Doc;
    const current = this.existing(id, table, "replace");
    const next = stripUndefined({
      ...clone(value),
      _id: current.doc._id,
      _creationTime: current.doc._creationTime,
    });
    this.validate(current.table, next);
    this.writes.set(id, { table: current.table, doc: next });
  }

  async delete(...args: unknown[]): Promise<void> {
    const { id, table } = this.resolve(args);
    const current = this.existing(id, table, "delete");
    this.writes.set(id, { table: current.table, doc: null });
  }

  /** The table an ID belongs to, counting this transaction's inserts. */
  tableOfId(id: string): string | null {
    return this.tableOf(id);
  }

  normalizeId(table: string, id: string): string | null {
    return this.tableOf(id) === table ? id : null;
  }

  query(table: string): Query {
    return new Query(this.store, this, table);
  }

  /** Writes in this transaction to `table`, as [id, doc or null for a delete]. */
  pending(table: string): [string, Doc | null][] {
    const out: [string, Doc | null][] = [];
    for (const [id, w] of this.writes) if (w.table === table) out.push([id, w.doc]);
    return out;
  }

  // Index order from SQL merged with this transaction's own writes: stored rows the transaction
  // changed or deleted are skipped, and its new versions are merged in by key. With `after`, only
  // rows past that key in the plan's order.
  *scan(plan: ScanPlan, after?: string): Generator<Row> {
    let { lo, hi } = plan;
    if (after !== undefined) {
      if (plan.desc) hi = after < hi ? after : hi;
      else lo = `${after}0` > lo ? `${after}0` : lo;
    }
    const fields = this.store.indexesOf(plan.table)[plan.index];
    if (!fields) throw new Error(`Index "${plan.table}.${plan.index}" is not defined`);
    this.reads.add(plan.table);
    const pending = this.pending(plan.table);
    const touched = new Set(pending.map(([id]) => id));
    const overlay: Row[] = [];
    for (const [, doc] of pending) {
      if (!doc) continue;
      const key = indexKey(doc, fields);
      if (key >= lo && key < hi) overlay.push({ key, doc });
    }
    overlay.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) * (plan.desc ? -1 : 1));
    let o = 0;
    for (const row of this.store.scan(plan.table, plan.index, lo, hi, plan.desc)) {
      if (touched.has(row.doc._id as string)) continue;
      while (o < overlay.length && before(overlay[o], row, plan.desc)) {
        const next = overlay[o++];
        if (plan.matches(next.doc)) yield { key: next.key, doc: clone(next.doc) };
      }
      if (plan.matches(row.doc)) yield row;
    }
    while (o < overlay.length) {
      const next = overlay[o++];
      if (plan.matches(next.doc)) yield { key: next.key, doc: clone(next.doc) };
    }
  }

  // A cursor is "<fingerprint>.<key>". The fingerprint binds it to the query that issued it, so
  // a cursor from another query, or a made-up one, is refused, as Convex refuses it.
  page(plan: ScanPlan, opts: PaginationOptions): PaginationResult {
    const fp = fingerprint(plan);
    const end = `${fp}.${END_CURSOR}`;
    if (opts.cursor === end) return { page: [], isDone: true, continueCursor: end };
    let after: string | undefined;
    if (opts.cursor !== null) {
      const dot = opts.cursor.indexOf(".");
      const key = opts.cursor.slice(dot + 1);
      if (dot < 0 || opts.cursor.slice(0, dot) !== fp || !/^[0-9a-f]+$/.test(key)) {
        throw new Error("InvalidCursor: the cursor was not issued for this query");
      }
      after = key;
    }
    const page: Doc[] = [];
    let last = after;
    let isDone = true;
    for (const row of this.scan(plan, after)) {
      if (page.length >= opts.numItems) {
        isDone = false;
        break;
      }
      page.push(row.doc);
      last = row.key;
    }
    return { page, isDone, continueCursor: isDone ? end : `${fp}.${last as string}` };
  }

  /** Inserts into a system table (`_scheduled_functions`, `_storage`); only the platform does. */
  insertSystem(table: string, value: Doc): string {
    if (!table.startsWith("_")) throw new Error(`insertSystem: "${table}" is not a system table`);
    const id = newId();
    const doc = stripUndefined({
      ...clone(value),
      _id: id,
      _creationTime: this.store.nextCreationTime(),
    });
    this.writes.set(id, { table, doc });
    return id;
  }

  /** Patches a system-table document without schema validation. */
  patchSystem(id: string, value: Doc): void {
    const current = this.existing(id, undefined, "patchSystem");
    if (!current.table.startsWith("_")) throw new Error("patchSystem: not a system table");
    this.writes.set(id, { table: current.table, doc: { ...current.doc, ...clone(value) } });
  }

  commit(): void {
    if (this.committed) throw new Error("transaction already committed");
    this.committed = true;
    this.store.apply(this.writes);
  }
}

function fingerprint(plan: ScanPlan): string {
  // FNV-1a over the parts that define the query's order and range.
  let h = 0x811c9dc5;
  for (const ch of `${plan.table}\u0000${plan.index}\u0000${plan.lo}\u0000${plan.hi}\u0000${plan.desc}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

function stripUndefined(doc: Doc): Doc {
  for (const k of Object.keys(doc)) if (doc[k] === undefined) delete doc[k];
  return doc;
}

export type PaginationOptions = { numItems: number; cursor: string | null };
export type PaginationResult = { page: Doc[]; isDone: boolean; continueCursor: string };

const END_CURSOR = "_end";

/** A resolved query: one index range, an order and a document predicate. */
export type ScanPlan = {
  table: string;
  index: string;
  lo: string;
  hi: string;
  desc: boolean;
  matches: (doc: Doc) => boolean;
};

export class Query {
  private index = "by_creation_time";
  private range: IndexRangeBuilder;
  private desc = false;
  private filters: Expression[] = [];

  constructor(
    private readonly store: Store,
    private readonly tx: Transaction,
    private readonly table: string,
  ) {
    this.range = new IndexRangeBuilder(this.index, SYSTEM_INDEXES.by_creation_time);
  }

  withIndex(name: string, build?: (q: IndexRangeBuilder) => IndexRangeBuilder): this {
    const fields = this.store.indexesOf(this.table)[name];
    if (!fields) throw new Error(`Index "${this.table}.${name}" is not defined`);
    this.index = name;
    this.range = new IndexRangeBuilder(name, rangeFields(name, fields));
    if (build) build(this.range);
    return this;
  }

  fullTableScan(): this {
    return this;
  }

  order(order: "asc" | "desc"): this {
    this.desc = order === "desc";
    return this;
  }

  filter(build: (q: typeof filterBuilder) => Expression): this {
    this.filters.push(build(filterBuilder));
    return this;
  }

  plan(): ScanPlan {
    const filters = this.filters;
    return {
      table: this.table,
      index: this.index,
      ...this.range.keyRange(),
      desc: this.desc,
      matches: (doc) => filters.every((f) => evaluate(f, doc) === true),
    };
  }

  async take(n: number): Promise<Doc[]> {
    const out: Doc[] = [];
    if (n <= 0) return out;
    for (const row of this.tx.scan(this.plan())) {
      out.push(row.doc);
      if (out.length >= n) break;
    }
    return out;
  }

  async collect(): Promise<Doc[]> {
    return [...this.tx.scan(this.plan())].map((r) => r.doc);
  }

  async first(): Promise<Doc | null> {
    return (await this.take(1))[0] ?? null;
  }

  async unique(): Promise<Doc | null> {
    const found = await this.take(2);
    if (found.length > 1) throw new Error(`unique() on ${this.table} found more than one document`);
    return found[0] ?? null;
  }

  async paginate(opts: PaginationOptions): Promise<PaginationResult> {
    return this.tx.page(this.plan(), opts);
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Doc> {
    for (const row of this.tx.scan(this.plan())) yield row.doc;
  }
}

function before(a: Row, b: Row, desc: boolean): boolean {
  return desc ? a.key > b.key : a.key < b.key;
}
