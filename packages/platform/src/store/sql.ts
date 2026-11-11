// The subset of Durable Object SQL storage the store uses. A Durable Object passes
// `ctx.storage.sql` and `ctx.storage.transactionSync`; tests pass the node:sqlite shim in
// tests/nodeSql.ts.

export type SqlValue = string | number | null | ArrayBuffer;

export interface Sql {
  /** Runs one statement. Rows are produced lazily, so a caller can stop early. */
  exec(query: string, ...bindings: SqlValue[]): Iterable<Record<string, SqlValue>>;
  /** Runs `fn` in one SQLite transaction; a throw rolls every write in it back. */
  transactionSync<T>(fn: () => T): T;
}
