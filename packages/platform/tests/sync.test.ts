// Convex's own ConvexClient, connected to a SyncSession through an in-process WebSocket. If these
// pass, the dashboard and the Action Runner Agent can use the Cloudflare platform unmodified.

import { ConvexClient } from "convex/browser";
import {
  actionGeneric,
  defineSchema,
  defineTable,
  makeFunctionReference,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { ConvexError, v } from "convex/values";
import { afterEach, describe, expect, test } from "vitest";

import { Runtime } from "../src/runtime/runtime.ts";
import { schemaInfo } from "../src/store/store.ts";
import { SyncServer, type SyncSession } from "../src/sync/session.ts";
import { nodeSql } from "../src/testing/nodeSql.ts";

const schema = defineSchema({
  notes: defineTable({ text: v.string() }),
  other: defineTable({ n: v.number() }),
});

let listRuns = 0;
const modules = {
  notes: {
    list: queryGeneric({
      args: {},
      handler: async (ctx) => {
        listRuns++;
        return (await ctx.db.query("notes").collect()).map((n) => n.text);
      },
    }),
    whoami: queryGeneric({
      args: {},
      handler: async (ctx) => (await ctx.auth.getUserIdentity())?.subject ?? null,
    }),
    failing: queryGeneric({
      args: {},
      handler: async () => {
        throw new ConvexError({ code: "nope" });
      },
    }),
    add: mutationGeneric({
      args: { text: v.string() },
      handler: async (ctx, { text }) => ctx.db.insert("notes", { text }),
    }),
    addOther: mutationGeneric({
      args: {},
      handler: async (ctx) => {
        await ctx.db.insert("other", { n: 1 });
      },
    }),
    noop: mutationGeneric({ args: {}, handler: async () => "nothing written" }),
    echo: actionGeneric({ args: { x: v.number() }, handler: async (_ctx, { x }) => x * 2 }),
  },
};

// Typed loosely: these tests check the wire protocol, not the generated API types.
const ref = <T extends "query" | "mutation" | "action">(_kind: T, name: string) =>
  makeFunctionReference<T, Record<string, unknown>, never>(name);

// A WebSocket whose other end is a SyncSession in the same process.
function socketClass(server: SyncServer, connections: SyncSession[]) {
  return class FakeWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onclose: ((e: { code: number; reason: string }) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    private readonly session: SyncSession;

    constructor(_url: string) {
      this.session = server.connect({
        send: (data) => setTimeout(() => this.onmessage?.({ data })),
        close: (code = 1000, reason = "") => this.finish(code, reason),
      });
      connections.push(this.session);
      setTimeout(() => {
        this.readyState = 1;
        this.onopen?.();
      });
    }

    send(data: string) {
      void this.session.receive(data);
    }

    close() {
      this.finish(1000, "");
    }

    private finish(code: number, reason: string) {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.session.close();
      setTimeout(() => this.onclose?.({ code, reason }));
    }
  };
}

const clients: ConvexClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

function setup(verify: SyncServer["verify"] = null) {
  const runtime = new Runtime({ modules, schema: schemaInfo(schema), sql: nodeSql() });
  const server = new SyncServer(runtime, verify);
  const connections: SyncSession[] = [];
  const client = new ConvexClient("https://cp.example", {
    webSocketConstructor: socketClass(server, connections) as never,
    unsavedChangesWarning: false,
  });
  clients.push(client);
  return { runtime, server, client, connections };
}

// Resolves with the first value from `onUpdate` that satisfies `ok`.
function nextValue<T>(
  client: ConvexClient,
  name: string,
  ok: (value: T) => boolean = () => true,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const unsubscribe = client.onUpdate(
      ref("query", name),
      {},
      (value: T) => {
        if (!ok(value)) return;
        unsubscribe();
        resolve(value);
      },
      reject,
    );
  });
}

describe("the sync protocol with Convex's ConvexClient", () => {
  test("a subscription sees its first value, then a mutation's write", async () => {
    const { client } = setup();
    const seen: string[][] = [];
    client.onUpdate(ref("query", "notes:list"), {}, (value: string[]) => seen.push(value));
    await nextValue<string[]>(client, "notes:list");
    const id = await client.mutation(ref("mutation", "notes:add"), { text: "hello" });
    expect(typeof id).toBe("string");
    await nextValue<string[]>(client, "notes:list", (value) => value.length === 1);
    expect(seen.at(-1)).toEqual(["hello"]);
  });

  test("a write from another client reaches this one", async () => {
    const { client, server } = setup();
    const other = new ConvexClient("https://cp.example", {
      webSocketConstructor: socketClass(server, []) as never,
      unsavedChangesWarning: false,
    });
    clients.push(other);
    await nextValue<string[]>(client, "notes:list");
    await other.mutation(ref("mutation", "notes:add"), { text: "from other" });
    expect(await nextValue<string[]>(client, "notes:list", (value) => value.length === 1)).toEqual([
      "from other",
    ]);
  });

  test("a write to a table the query did not read does not re-run it", async () => {
    const { client } = setup();
    client.onUpdate(ref("query", "notes:list"), {}, () => {});
    await nextValue<string[]>(client, "notes:list");
    const before = listRuns;
    await client.mutation(ref("mutation", "notes:addOther"), {});
    await client.mutation(ref("mutation", "notes:add"), { text: "x" });
    await nextValue<string[]>(client, "notes:list", (value) => value.length === 1);
    expect(listRuns - before).toBe(1);
  });

  test("a mutation that writes nothing still resolves", async () => {
    const { client } = setup();
    expect(await client.mutation(ref("mutation", "notes:noop"), {})).toBe("nothing written");
  });

  test("an action returns its result", async () => {
    const { client } = setup();
    expect(await client.action(ref("action", "notes:echo"), { x: 21 })).toBe(42);
  });

  test("a failing query reports its ConvexError data", async () => {
    const { client } = setup();
    const err = await nextValue(client, "notes:failing").catch((e: unknown) => e);
    expect((err as ConvexError<{ code: string }>).data).toEqual({ code: "nope" });
  });

  test("a failing mutation rejects with the validator's message", async () => {
    const { client } = setup();
    await expect(client.mutation(ref("mutation", "notes:add"), { text: 1 })).rejects.toThrow(
      /ArgumentValidationError/,
    );
  });

  test("a verified token sets the identity and confirms auth", async () => {
    const { client } = setup(async (token) => {
      if (token !== "good") throw new Error("Invalid JWT");
      return { issuer: "https://cp.example", subject: "user1", tokenIdentifier: "x|user1" };
    });
    const authed = new Promise<boolean>((resolve) => {
      client.setAuth(async () => "good", resolve);
    });
    expect(await authed).toBe(true);
    expect(await nextValue<string | null>(client, "notes:whoami", (value) => value !== null)).toBe(
      "user1",
    );
  });

  test("a rejected token reports signed out", async () => {
    const { client } = setup(async () => {
      throw new Error("Invalid JWT");
    });
    const authed = new Promise<boolean>((resolve) => {
      client.setAuth(async () => "bad", resolve);
    });
    expect(await authed).toBe(false);
  });

  test("a closed connection leaves the server", async () => {
    const { client, server } = setup();
    await nextValue<string[]>(client, "notes:list");
    expect(server.size).toBe(1);
    await client.close();
    clients.length = 0;
    expect(server.size).toBe(0);
  });
});
