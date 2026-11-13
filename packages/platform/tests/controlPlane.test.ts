// The Durable Object's HTTP function API, called by Convex's own ConvexHttpClient. Convex Auth's
// React provider uses that client for sign-in and token refresh.

import { ConvexHttpClient } from "convex/browser";
import {
  defineSchema,
  defineTable,
  makeFunctionReference,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { ConvexError, v } from "convex/values";
import { describe, expect, test } from "vitest";

import { createControlPlane, type DurableObjectState } from "../src/cloudflare/controlPlane.ts";
import { nodeSql } from "../src/testing/nodeSql.ts";

const schema = defineSchema({ notes: defineTable({ text: v.string() }) });
const modules = {
  notes: {
    add: mutationGeneric({
      args: { text: v.string() },
      handler: async (ctx, { text }) => {
        if (!text) throw new ConvexError({ code: "empty" });
        return ctx.db.insert("notes", { text });
      },
    }),
    count: queryGeneric({
      args: {},
      handler: async (ctx) => (await ctx.db.query("notes").collect()).length,
    }),
  },
};

function setup() {
  const { ControlPlane } = createControlPlane({ modules, schema });
  const sql = nodeSql();
  const state: DurableObjectState = {
    storage: {
      sql: { exec: (q, ...b) => sql.exec(q, ...b) },
      transactionSync: (fn) => sql.transactionSync(fn),
      setAlarm: async () => {},
      deleteAlarm: async () => {},
    },
    blockConcurrencyWhile: (fn) => fn(),
  };
  const object = new ControlPlane(state, { CONTROL_PLANE: null as never });
  const client = new ConvexHttpClient("https://cp.example", {
    fetch: (input, init) => object.fetch(new Request(input, init)),
  });
  return { client };
}

describe("the HTTP function API with ConvexHttpClient", () => {
  test("runs a mutation and a query", async () => {
    const { client } = setup();
    await client.mutation(makeFunctionReference<"mutation">("notes:add"), { text: "a" });
    expect(await client.query(makeFunctionReference<"query">("notes:count"), {})).toBe(1);
  });

  test("returns ConvexError data", async () => {
    const { client } = setup();
    const err = await client
      .mutation(makeFunctionReference<"mutation">("notes:add"), { text: "" })
      .catch((e: unknown) => e);
    expect((err as ConvexError<{ code: string }>).data).toEqual({ code: "empty" });
  });
});
