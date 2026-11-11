// Differential tests: the same writes and queries run against convex-test (Convex's own emulator)
// and against the SQLite store, and the results must match.

import { convexTest } from "convex-test";
import { defineSchema, defineTable } from "convex/server";
import { v, type Value } from "convex/values";
import { describe, expect, test } from "vitest";

import { schemaInfo, Store } from "../src/store/index.ts";
import { nodeSql } from "../src/testing/nodeSql.ts";

const schema = defineSchema({
  items: defineTable({
    n: v.number(),
    group: v.string(),
    score: v.optional(v.union(v.number(), v.null())),
    tag: v.optional(v.string()),
    owner: v.optional(v.id("owners")),
  })
    .index("by_group", ["group"])
    .index("by_group_score", ["group", "score"])
    .index("by_score", ["score"]),
  owners: defineTable({ name: v.string() }).index("by_name", ["name"]),
});

type Db = {
  insert(table: string, doc: Record<string, unknown>): Promise<string>;
  patch(id: string, doc: Record<string, unknown>): Promise<void>;
  delete(id: string): Promise<void>;
  get(id: string): Promise<Record<string, unknown> | null>;
  query(table: string): any;
};

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const groups = ["a", "b", "c"];
const scores: (number | null | undefined)[] = [undefined, null, -1, 0, 1, 2.5, 10];

// Builds one random query and returns a function that runs it against a db.
function randomQuery(r: () => number): { describe: string; run: (db: Db) => Promise<unknown> } {
  const g = groups[Math.floor(r() * groups.length)] as string;
  const s = scores[2 + Math.floor(r() * 5)] as number;
  const order = r() < 0.5 ? "asc" : "desc";
  const kind = Math.floor(r() * 7);
  const pickN = (docs: Record<string, unknown>[] | null) =>
    docs === null ? null : (Array.isArray(docs) ? docs : [docs]).map((d) => d?.n ?? null);
  switch (kind) {
    case 0:
      return {
        describe: `by_group eq ${g} ${order} collect`,
        run: async (db) =>
          pickN(
            await db
              .query("items")
              .withIndex("by_group", (q: any) => q.eq("group", g))
              .order(order)
              .collect(),
          ),
      };
    case 1:
      return {
        describe: `by_group_score eq ${g} gt ${s} ${order} take 3`,
        run: async (db) =>
          pickN(
            await db
              .query("items")
              .withIndex("by_group_score", (q: any) => q.eq("group", g).gt("score", s))
              .order(order)
              .take(3),
          ),
      };
    case 2:
      return {
        describe: `by_score gte ${s} lt 10 ${order}`,
        run: async (db) =>
          pickN(
            await db
              .query("items")
              .withIndex("by_score", (q: any) => q.gte("score", s).lt("score", 10))
              .order(order)
              .collect(),
          ),
      };
    case 3:
      return {
        describe: `by_score lte ${s} ${order} (includes null and missing)`,
        run: async (db) =>
          pickN(
            await db
              .query("items")
              .withIndex("by_score", (q: any) => q.lte("score", s))
              .order(order)
              .collect(),
          ),
      };
    case 4:
      return {
        describe: `full scan filter tag=x or score>${s} ${order}`,
        run: async (db) =>
          pickN(
            await db
              .query("items")
              // convex-test compares with JavaScript's `>`, which puts null above -1; Convex puts
              // null below every number. Excluding null keeps the two comparable here; the
              // cross-type order has its own test below.
              .filter((q: any) =>
                q.or(
                  q.eq(q.field("tag"), "x"),
                  q.and(q.neq(q.field("score"), null), q.gt(q.field("score"), s)),
                ),
              )
              .order(order)
              .collect(),
          ),
      };
    case 5:
      return {
        describe: `by_group_score eq ${g} eq undefined first`,
        run: async (db) =>
          pickN(
            [
              await db
                .query("items")
                .withIndex("by_group_score", (q: any) => q.eq("group", g).eq("score", undefined))
                .first(),
            ].filter(Boolean),
          ),
      };
    default:
      return {
        describe: `by_group eq ${g} filter neq tag y ${order} take 2`,
        run: async (db) =>
          pickN(
            await db
              .query("items")
              .withIndex("by_group", (q: any) => q.eq("group", g))
              .filter((q: any) => q.neq(q.field("tag"), "y"))
              .order(order)
              .take(2),
          ),
      };
  }
}

describe("Store matches convex-test", () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    test(`random writes and queries, seed ${seed}`, async () => {
      const convex = convexTest(schema, { "./_generated/api.js": async () => ({}) });
      const store = new Store(nodeSql(), schemaInfo(schema));
      const r = rng(seed);
      const convexIds: string[] = [];
      const storeIds: string[] = [];
      let n = 0;
      for (let step = 0; step < 60; step++) {
        // One mutation of a few writes, applied identically to both.
        const ops: {
          op: "insert" | "patch" | "delete";
          at: number;
          doc: Record<string, Value | undefined>;
        }[] = [];
        for (let k = 0; k < 1 + Math.floor(r() * 3); k++) {
          const op =
            convexIds.length === 0 || r() < 0.6 ? "insert" : r() < 0.7 ? "patch" : "delete";
          const doc: Record<string, Value | undefined> = {
            n: n++,
            group: groups[Math.floor(r() * groups.length)] as string,
          };
          const score = scores[Math.floor(r() * scores.length)];
          if (score !== undefined || op === "patch") doc.score = score;
          if (r() < 0.4) doc.tag = r() < 0.5 ? "x" : "y";
          ops.push({ op, at: Math.floor(r() * Math.max(convexIds.length, 1)), doc });
        }
        const query = randomQuery(r);
        const apply = async (db: Db, ids: string[]) => {
          for (const { op, at, doc } of ops) {
            if (op === "insert") ids.push(await db.insert("items", doc));
            else if (op === "patch" && ids[at] && (await db.get(ids[at] as string)))
              await db.patch(ids[at] as string, doc);
            else if (op === "delete" && ids[at] && (await db.get(ids[at] as string)))
              await db.delete(ids[at] as string);
          }
          // Queries inside the mutation see its own writes.
          return query.run(db);
        };
        const fromConvex = await convex.run((ctx) => apply(ctx.db as unknown as Db, convexIds));
        const fromStore = await store.run((db) => apply(db as unknown as Db, storeIds));
        expect({ step, query: query.describe, result: fromStore }).toEqual({
          step,
          query: query.describe,
          result: fromConvex,
        });
        // And a fresh read after commit.
        const q2 = randomQuery(r);
        const c2 = await convex.run((ctx) => q2.run(ctx.db as unknown as Db));
        const s2 = await store.run((db) => q2.run(db as unknown as Db));
        expect({ step, query: q2.describe, result: s2 }).toEqual({
          step,
          query: q2.describe,
          result: c2,
        });
      }
    });
  }
});

describe("Store", () => {
  test("filter comparisons across types follow Convex's value order, not JavaScript's", async () => {
    const store = new Store(nodeSql(), schemaInfo(schema));
    const found = await store.run(async (db) => {
      await db.insert("items", { n: 1, group: "a", score: null });
      await db.insert("items", { n: 2, group: "a" });
      await db.insert("items", { n: 3, group: "a", score: -5 });
      return db
        .query("items")
        .filter((q) => q.lt(q.field("score"), -1))
        .collect();
    });
    // undefined < null < every number.
    expect(found.map((d) => d.n)).toEqual([1, 2, 3]);
  });

  test("a mutation that throws stores nothing", async () => {
    const store = new Store(nodeSql(), schemaInfo(schema));
    await expect(
      store.run(async (db) => {
        await db.insert("owners", { name: "kept?" });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await store.run((db) => db.query("owners").collect())).toEqual([]);
  });

  test("rejects documents that do not match the schema", async () => {
    const store = new Store(nodeSql(), schemaInfo(schema));
    await expect(store.run((db) => db.insert("owners", { name: 1 } as never))).rejects.toThrow(
      /owners.name/,
    );
    await expect(
      store.run((db) => db.insert("owners", { name: "a", extra: true } as never)),
    ).rejects.toThrow(/not in the schema/);
    await expect(store.run((db) => db.insert("nope", {}))).rejects.toThrow(/not in the schema/);
  });

  test("checks that an Id names a document of the right table", async () => {
    const store = new Store(nodeSql(), schemaInfo(schema));
    const owner = await store.run((db) => db.insert("owners", { name: "o" }));
    await store.run((db) => db.insert("items", { n: 1, group: "a", owner }));
    const item = await store.run((db) => db.insert("items", { n: 2, group: "a" }));
    await expect(
      store.run((db) => db.insert("items", { n: 3, group: "a", owner: item })),
    ).rejects.toThrow(/Id of owners/);
    expect(await store.run((db) => db.normalizeId("owners", owner))).toBe(owner);
    expect(await store.run((db) => db.normalizeId("items", owner))).toBeNull();
  });

  test("paginates through an index without gaps or repeats, including across writes", async () => {
    const store = new Store(nodeSql(), schemaInfo(schema));
    await store.run(async (db) => {
      for (let i = 0; i < 25; i++)
        await db.insert("items", { n: i, group: i % 2 ? "a" : "b", score: i });
    });
    const seen: number[] = [];
    let cursor: string | null = null;
    for (;;) {
      const res = await store.run((db) =>
        db.query("items").withIndex("by_score").order("desc").paginate({ numItems: 7, cursor }),
      );
      seen.push(...res.page.map((d) => d.n as number));
      if (res.isDone) break;
      cursor = res.continueCursor;
      // A write between pages must not disturb the order of the remaining rows.
      await store.run((db) => db.insert("owners", { name: `between-${seen.length}` }));
    }
    expect(seen).toEqual(Array.from({ length: 25 }, (_, i) => 24 - i));
  });

  test("survives reopening, and rebuilds an index added to the schema", async () => {
    const sql = nodeSql();
    const first = new Store(sql, schemaInfo(schema));
    await first.run(async (db) => {
      await db.insert("owners", { name: "b" });
      await db.insert("owners", { name: "a" });
    });
    const grown = defineSchema({
      ...schema.tables,
      owners: defineTable({ name: v.string() })
        .index("by_name", ["name"])
        .index("by_name_desc_helper", ["name"]),
    });
    const second = new Store(sql, schemaInfo(grown));
    const names = await second.run((db) =>
      db.query("owners").withIndex("by_name_desc_helper").order("desc").collect(),
    );
    expect(names.map((d) => d.name)).toEqual(["b", "a"]);
  });

  test("unique() throws on two matches; patch removes a field set to undefined", async () => {
    const store = new Store(nodeSql(), schemaInfo(schema));
    const id = await store.run(async (db) => {
      await db.insert("owners", { name: "dup" });
      await db.insert("owners", { name: "dup" });
      return db.insert("items", { n: 1, group: "a", tag: "x" });
    });
    await expect(
      store.run((db) =>
        db
          .query("owners")
          .withIndex("by_name", (q) => q.eq("name", "dup"))
          .unique(),
      ),
    ).rejects.toThrow(/more than one/);
    await store.run((db) => db.patch(id, { tag: undefined }));
    expect(await store.run((db) => db.get(id))).not.toHaveProperty("tag");
  });
});
