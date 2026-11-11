// The parts of the runtime the backend's suite does not reach: crons, the alarm, scheduled
// actions, files and upload tokens.

import {
  actionGeneric,
  cronJobs,
  defineSchema,
  defineTable,
  makeFunctionReference,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { v } from "convex/values";
import { describe, expect, test } from "vitest";

import { Runtime, type FileStore } from "../src/runtime/runtime.ts";
import { schemaInfo } from "../src/store/store.ts";
import { nodeSql } from "../src/testing/nodeSql.ts";

const schema = defineSchema({ events: defineTable({ what: v.string() }) });

const record = mutationGeneric({
  args: { what: v.string() },
  handler: async (ctx, { what }) => {
    await ctx.db.insert("events", { what });
  },
});
const recordRef = makeFunctionReference<"mutation", { what: string }>("jobs:record");
const listRef = makeFunctionReference<"query", Record<string, never>, { what: string }[]>(
  "jobs:list",
);

const crons = cronJobs();
crons.interval("tick", { seconds: 10 }, recordRef, { what: "tick" });

const modules = {
  jobs: {
    record,
    list: queryGeneric({ args: {}, handler: (ctx) => ctx.db.query("events").collect() }),
    later: mutationGeneric({
      args: { ms: v.number() },
      handler: async (ctx, { ms }) =>
        ctx.scheduler.runAfter(ms, recordRef, { what: `after ${ms}` }),
    }),
    viaAction: actionGeneric({
      args: {},
      handler: async (ctx) => {
        await ctx.runMutation(recordRef, { what: "from action" });
        return (await ctx.runQuery(listRef, {})).length;
      },
    }),
    failing: mutationGeneric({
      args: {},
      handler: async (ctx) => {
        await ctx.db.insert("events", { what: "rolled back" });
        throw new Error("nope");
      },
    }),
    store: actionGeneric({
      args: {},
      handler: async (ctx) => {
        const id = await ctx.storage.store(new Blob(["hello"], { type: "text/plain" }));
        const blob = await ctx.storage.get(id);
        return { id, text: await blob?.text(), url: await ctx.storage.getUrl(id) };
      },
    }),
    uploadUrl: mutationGeneric({ args: {}, handler: (ctx) => ctx.storage.generateUploadUrl() }),
  },
  crons: { default: crons },
};

class MemoryFiles implements FileStore {
  files = new Map<string, { bytes: Uint8Array; contentType: string | undefined }>();
  async put(key: string, bytes: Uint8Array, contentType: string | undefined) {
    this.files.set(key, { bytes, contentType });
  }
  async get(key: string) {
    return this.files.get(key) ?? null;
  }
  async delete(key: string) {
    this.files.delete(key);
  }
}

function setup() {
  // Convex computes a scheduled time from the real Date.now(), so the fake clock starts there.
  let now = Date.now();
  const alarms: (number | null)[] = [];
  const files = new MemoryFiles();
  const runtime = new Runtime({
    modules,
    schema: schemaInfo(schema),
    sql: nodeSql(),
    files,
    siteUrl: "https://cp.example",
    now: () => now,
    setAlarm: (at) => alarms.push(at),
  });
  const list = async () =>
    ((await runtime.run("jobs:list", {})) as { what: string }[]).map((e) => e.what);
  return { runtime, alarms, files, list, advance: (ms: number) => (now += ms), now: () => now };
}

describe("Runtime", () => {
  test("a scheduled mutation runs once when its alarm fires, not before", async () => {
    const { runtime, alarms, list, advance, now } = setup();
    await runtime.run("jobs:later", { ms: 5_000 });
    // The cron has never run, so it is due now; the alarm takes the earlier of the two.
    expect(alarms.at(-1)).toBe(now());
    await runtime.runDue();
    expect(await list()).toEqual(["tick"]);
    advance(4_000);
    await runtime.runDue();
    expect(await list()).toEqual(["tick"]);
    advance(2_000);
    await runtime.runDue();
    expect(await list()).toEqual(["tick", "after 5000"]);
  });

  test("a cron runs once per interval, and once after a long outage", async () => {
    const { runtime, list, advance } = setup();
    await runtime.runDue();
    advance(9_000);
    await runtime.runDue();
    expect(await list()).toEqual(["tick"]);
    advance(1_000);
    await runtime.runDue();
    expect(await list()).toEqual(["tick", "tick"]);
    advance(3_600_000);
    await runtime.runDue();
    expect(await list()).toEqual(["tick", "tick", "tick"]);
  });

  test("an action's nested mutation commits and its nested query sees it", async () => {
    const { runtime } = setup();
    expect(await runtime.run("jobs:viaAction", {})).toBe(1);
  });

  test("a mutation that throws leaves no writes and reports the error", async () => {
    const { runtime, list } = setup();
    await expect(runtime.run("jobs:failing", {})).rejects.toThrow("nope");
    expect(await list()).toEqual([]);
  });

  test("rejects arguments that do not match the validator", async () => {
    const { runtime } = setup();
    await expect(runtime.run("jobs:record", { what: 1 })).rejects.toThrow(
      /ArgumentValidationError/,
    );
  });

  test("stores and reads a file, and serves its URL from the deployment", async () => {
    const { runtime, files } = setup();
    const out = (await runtime.run("jobs:store", {})) as { id: string; text: string; url: string };
    expect(out.text).toBe("hello");
    expect(out.url).toBe(`https://cp.example/api/storage/${out.id}`);
    expect(files.files.get(out.id)?.contentType).toBe("text/plain");
  });

  test("an upload token works once", async () => {
    const { runtime } = setup();
    const url = new URL((await runtime.run("jobs:uploadUrl", {})) as string);
    const token = url.searchParams.get("token") as string;
    const id = await runtime.upload(token, new TextEncoder().encode("x"), "text/plain");
    expect(id).not.toBeNull();
    expect(await runtime.upload(token, new TextEncoder().encode("x"), "text/plain")).toBeNull();
  });
});
