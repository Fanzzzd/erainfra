// The Durable Object SQL surface (src/store/sql.ts) over node:sqlite, so the store's tests run in
// Node. Durable Objects forbid BEGIN in `exec`; this shim only uses it inside transactionSync.

import { DatabaseSync } from "node:sqlite";

import type { Sql, SqlValue } from "../src/store/sql.ts";

export function nodeSql(path = ":memory:"): Sql & { db: DatabaseSync } {
  const db = new DatabaseSync(path);
  let depth = 0;
  return {
    db,
    exec(query: string, ...bindings: SqlValue[]) {
      const stmt = db.prepare(query);
      if (stmt.columns().length === 0) {
        stmt.run(...(bindings as never[]));
        return [];
      }
      return stmt.iterate(...(bindings as never[])) as Iterable<Record<string, SqlValue>>;
    },
    transactionSync<T>(fn: () => T): T {
      if (depth > 0) return fn();
      db.exec("BEGIN");
      depth++;
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      } finally {
        depth--;
      }
    },
  };
}
