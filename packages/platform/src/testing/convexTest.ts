// A drop-in for convex-test's `convexTest(schema, modules)` that runs the backend on the
// Cloudflare platform runtime over node:sqlite. Aliasing "convex-test" to this module runs the
// backend's own test suite on the Cloudflare platform (ADR 0019, "The same tests run on both
// platforms").

import { getFunctionName } from "convex/server";
import type { JSONValue, Value } from "convex/values";

import {
  modulesFrom,
  Runtime,
  type Identity,
  type FileStore,
  type Modules,
} from "../runtime/runtime.ts";
import { schemaInfo } from "../store/store.ts";
import { nodeSql } from "./nodeSql.ts";

type Loader = () => Promise<Record<string, unknown>>;
type ModuleMap = Record<string, Loader | Record<string, unknown>>;

class MemoryFiles implements FileStore {
  private files = new Map<string, { bytes: Uint8Array; contentType: string | undefined }>();
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

// convex-test keys the glob by paths relative to the test file ("../convex/attempts.ts"); the
// runtime wants paths relative to convex/ ("attempts").
function convexRelative(key: string): string {
  const i = key.lastIndexOf("/convex/");
  return i === -1 ? key.replace(/^\.\//, "") : key.slice(i + "/convex/".length);
}

async function load(modules: ModuleMap): Promise<Modules> {
  const loaded: Record<string, Record<string, unknown>> = {};
  await Promise.all(
    Object.entries(modules).map(async ([key, m]) => {
      const rel = convexRelative(key);
      // convex.config.ts declares components, which only load inside Convex.
      if (
        rel.startsWith("_generated/") ||
        rel.endsWith(".d.ts") ||
        rel.startsWith("convex.config.")
      )
        return;
      loaded[rel] = typeof m === "function" ? await (m as Loader)() : m;
    }),
  );
  return modulesFrom(loaded);
}

// convex-test falls back to globbing convex/; this harness cannot glob another package, so a
// test setup file registers the backend's modules here (packages/backend/tests/platformSetup.ts).
function defaultModules(): ModuleMap {
  const registered = (globalThis as { __convexTestModules?: ModuleMap }).__convexTestModules;
  if (!registered)
    throw new Error("convexTest needs modules: pass them or register __convexTestModules");
  return registered;
}

const nameOf = (ref: unknown): string =>
  typeof ref === "string" ? ref : getFunctionName(ref as never);

function fullIdentity(partial: Record<string, JSONValue>): Identity {
  const issuer = (partial.issuer as string | undefined) ?? "https://convex.test";
  const subject = (partial.subject as string | undefined) ?? crypto.randomUUID();
  return {
    issuer,
    subject,
    tokenIdentifier: `${issuer}|${subject}`,
    ...partial,
  };
}

type Options = { schema: unknown; modules?: ModuleMap; transactionLimits?: boolean };

/**
 * Same signatures as convex-test: `convexTest(schema, modules)` or `convexTest({ schema, modules
 * })`. Convex's transaction limits are not enforced; the Cloudflare platform has its own.
 */
export function convexTest(schemaOrOptions: unknown, modulesArg?: ModuleMap) {
  const asOptions = schemaOrOptions as Options;
  const isOptions =
    typeof schemaOrOptions === "object" && schemaOrOptions !== null && "schema" in schemaOrOptions;
  const schema = isOptions ? asOptions.schema : schemaOrOptions;
  const modules = (isOptions ? asOptions.modules : modulesArg) ?? defaultModules();
  let runtime: Promise<Runtime> | undefined;
  const rt = () =>
    (runtime ??= load(modules).then(
      (m) =>
        new Runtime({
          modules: m,
          schema: schemaInfo(schema as never),
          sql: nodeSql(),
          files: new MemoryFiles(),
          siteUrl: "https://convex.test",
        }),
    ));

  const api = (identity: Identity) => ({
    async query(ref: unknown, args: Value = {}) {
      return (await rt()).run(nameOf(ref), args, { identity, expect: "query" });
    },
    async mutation(ref: unknown, args: Value = {}) {
      return (await rt()).run(nameOf(ref), args, { identity, expect: "mutation" });
    },
    async action(ref: unknown, args: Value = {}) {
      return (await rt()).run(nameOf(ref), args, { identity, expect: "action" });
    },
    async run<T>(handler: (ctx: never) => Promise<T> | T): Promise<T> {
      return (await rt()).inline("mutation", handler, identity);
    },
    async fetch(pathQueryFragment: string, init?: RequestInit): Promise<Response> {
      if (!pathQueryFragment.startsWith("/"))
        throw new Error(`Path given to t.fetch must start with a "/"`);
      return (await rt()).http(new Request(`https://convex.test${pathQueryFragment}`, init));
    },
    async finishInProgressScheduledFunctions(): Promise<void> {
      await (await rt()).runDue({ crons: false });
    },
    // Like convex-test: each pending function gets a timer at its due time, so a fake-timer
    // `advanceTimers` (vi.runAllTimers) moves the clock to that time before the function runs.
    async finishAllScheduledFunctions(
      advanceTimers: () => void,
      maxIterations = 100,
    ): Promise<void> {
      const r = await rt();
      for (let i = 0; i < maxIterations; i++) {
        const due = r.nextScheduledTime();
        if (due === null) return;
        const wait = due - Date.now();
        if (wait > 0) setTimeout(() => undefined, wait);
        advanceTimers();
        // Without fake timers the clock did not move; run the function anyway.
        if ((await r.runDue({ crons: false })) === 0)
          await r.runDue({ crons: false, ignoreTime: true });
      }
      throw new Error("finishAllScheduledFunctions: scheduled functions kept scheduling more");
    },
    withIdentity(partial: Record<string, JSONValue>) {
      return api(fullIdentity(partial));
    },
  });

  return api(null);
}

export default convexTest;
