#!/usr/bin/env node
// Fails when a tracked non-test source file has more than 900 lines (CONTRIBUTING.md, "Code
// rules"). It counts lines as EraDB's scripts/maturity/check-structure.mjs does,
// `text.split("\n").length`, so a file that ends in a newline counts one more than `wc -l` shows
// and the numbers agree across Era repositories. It needs only Node and git, no install.
//
//   node scripts/check-structure.mjs
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const MAX_LINES = 900;
const SOURCE = /\.(go|ts|tsx|rs|mjs)$/;
const NOT_CHECKED = [
  /_test\.go$/,
  /\.(test|spec)\.(ts|tsx|mjs)$/,
  /(^|\/)(tests?|testdata)\//,
  /(^|\/)(vendor|third_party)\//,
  /(^|\/)_generated\//,
  /\.generated\.ts$/,
  /\.d\.ts$/,
];
// Go's marker for a generated file (https://go.dev/s/generatedcode).
const GO_GENERATED = /^\/\/ Code generated .* DO NOT EDIT\.$/m;

// Files over the cap today. Each one is a split still to do; remove its entry when it is done.
// The check fails on an entry whose file is back under the cap, so the list only shrinks.
const EXCEPTIONS = new Map([
  [
    "packages/backend/convex/installScript.ts",
    "the Linux and macOS installer is one bash template string; splitting it means assembling the served script from parts",
  ],
  [
    "packages/backend/convex/http.ts",
    "every Convex HTTP route is registered on one router; route groups can move out, the router stays",
  ],
  [
    "packages/backend/convex/infra/pipeline.ts",
    "Convex names a function by its file, so only helpers may move without renaming functions callers hold",
  ],
  [
    "packages/backend/convex/infra/operator.ts",
    "Convex names a function by its file, so only helpers may move without renaming functions callers hold",
  ],
  [
    "apps/dashboard/src/routes/index.tsx",
    "one TanStack route per file; its components can move to src/components",
  ],
  [
    "apps/dashboard/src/routes/settings.tsx",
    "one TanStack route per file; its components can move to src/components",
  ],
  [
    "apps/action-runner-agent/readiness.ts",
    "the Docker, Firecracker and Hyper-V readiness probes share one module; each can move to its own",
  ],
  ["apps/mesh/src/daemon.rs", "the mesh daemon; not split yet"],
]);

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter((path) => SOURCE.test(path) && !NOT_CHECKED.some((pattern) => pattern.test(path)));

const problems = [];
const over = new Set();
for (const path of files) {
  const text = readFileSync(path, "utf8");
  if (path.endsWith(".go") && GO_GENERATED.test(text)) continue;
  const lines = text.split("\n").length;
  if (lines <= MAX_LINES) continue;
  over.add(path);
  if (!EXCEPTIONS.has(path)) {
    problems.push(
      `${path}: ${lines} lines, over the ${MAX_LINES}-line cap. Split it along a seam.`,
    );
  }
}
for (const path of EXCEPTIONS.keys()) {
  if (!over.has(path)) {
    problems.push(`${path} is listed as an exception but is not over the cap. Remove the entry.`);
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}
console.log(
  `${files.length} source files checked; ${EXCEPTIONS.size} listed exceptions over ${MAX_LINES} lines.`,
);
