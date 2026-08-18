import assert from "node:assert/strict";
import { describe, it } from "node:test";

/**
 * config.ts reads the environment at import time and throws there, so each case
 * needs its own module instance. A query string is what defeats the ESM cache;
 * the file has no side effects beyond building the object, so re-evaluating it
 * is cheap and total.
 */
let generation = 0;
async function load(overrides: Record<string, string | undefined>) {
  const saved = { ...process.env };
  try {
    process.env.CONVEX_URL = "https://example.convex.cloud";
    process.env.MACHINE_TOKEN = "0123456789abcdef0123456789abcdef";
    delete process.env.ERAINFRA_CACHE_URL;
    delete process.env.ERAINFRA_CACHE_SERVICE_V2;
    for (const [name, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    generation += 1;
    const module = await import(`../config.ts?case=${generation}`);
    return module.config as { cache: { url?: string; serviceV2?: string } };
  } finally {
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, saved);
  }
}

async function refuses(overrides: Record<string, string>, pattern: RegExp) {
  await assert.rejects(() => load(overrides), pattern);
}

describe("the job cache endpoint an Agent offers", () => {
  // OFF by default is the whole contract of this seam: a fleet that has not
  // configured a cache must compose exactly the environment it composed before.
  it("is absent unless an operator configured one", async () => {
    const config = await load({});
    assert.deepEqual(config.cache, {});
  });

  it("is absent when the variables are set to whitespace", async () => {
    const config = await load({ ERAINFRA_CACHE_URL: "  ", ERAINFRA_CACHE_SERVICE_V2: " " });
    assert.deepEqual(config.cache, {});
  });

  it("carries an absolute endpoint through, trimmed", async () => {
    const config = await load({ ERAINFRA_CACHE_URL: " https://cache.lan:8443/erainfra/ " });
    assert.equal(config.cache.url, "https://cache.lan:8443/erainfra/");
  });

  // The generation flag is independent of the URL because it carries different
  // risk: GitHub serves both generations, so setting the flag alone points no
  // traffic anywhere new and is the free way to ask whether an EraInfra-set
  // value survives the runner's injection at all.
  it("carries the generation flag on its own", async () => {
    const config = await load({ ERAINFRA_CACHE_SERVICE_V2: "false" });
    assert.deepEqual(config.cache, { serviceV2: "false" });
  });

  // Refused at startup, not at the first Attempt. An Agent that boots with a
  // malformed endpoint hands every job a cache it cannot reach, and the
  // symptom -- slower jobs, no error anywhere -- is the one nobody traces back
  // to a typo in a unit file.
  it("refuses an endpoint that is not an absolute http(s) URL", async () => {
    for (const url of ["cache.lan", "ftp://cache.lan/", "/erainfra/", "cache.lan:8443"]) {
      await refuses({ ERAINFRA_CACHE_URL: url }, /ERAINFRA_CACHE_URL/);
    }
  });

  it("refuses a generation flag that is not exactly true or false", async () => {
    for (const flag of ["yes", "1", "True", "maybe"]) {
      await refuses({ ERAINFRA_CACHE_SERVICE_V2: flag }, /ERAINFRA_CACHE_SERVICE_V2/);
    }
  });
});
