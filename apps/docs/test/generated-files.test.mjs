// The typecheck script runs `fumadocs-mdx && next typegen && tsc --noEmit`.
// `next typegen` loads next.config.mjs, whose createMDX() regenerates
// .source/, and then calls process.exit(0) as soon as the route types are
// written. fumadocs-mdx before 15.2.2 started that regeneration without
// awaiting it, so the exit could land between a file's truncate and its
// write and leave .source/server.ts empty; tsc then failed with
// "TS2306: File '.source/server.ts' is not a module". Whether it did
// depended on timing, so the same commit failed on some CI machines and
// passed on others (fuma-nama/fumadocs#3450).
//
// This test pins the property the script relies on: once `next typegen`
// exits, .source/ holds complete files. The preload makes every write slow
// so that a regression fails on every run, not on some.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const docsDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(docsDir, "package.json"));
const nextBin = join(dirname(require.resolve("next/package.json")), "dist/bin/next");
const fumadocsBin = join(dirname(require.resolve("fumadocs-mdx/package.json")), "bin.js");
const slowWrites = join(docsDir, "test/slow-generated-writes.mjs");

const run = (args) =>
  execFileSync(process.execPath, args, {
    cwd: docsDir,
    env: { ...process.env, NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"],
  });

// Leave a usable .source/ behind for whatever runs next, pass or fail.
after(() => run([fumadocsBin]));

test("next typegen leaves complete .source files when it exits", () => {
  // Start empty so a regeneration that never ran fails too, instead of
  // passing on the files an earlier step wrote.
  rmSync(join(docsDir, ".source"), { recursive: true, force: true });

  run([`--import=${slowWrites}`, nextBin, "typegen"]);

  const read = (name) => readFileSync(join(docsDir, ".source", name), "utf8");
  assert.match(read("server.ts"), /^export const docs = /m);
  assert.match(read("browser.ts"), /^export default browserCollections;?$/m);
  assert.ok(read("dynamic.ts").length > 0, ".source/dynamic.ts is empty");
});
