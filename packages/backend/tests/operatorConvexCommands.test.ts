// Every `convex env …` and `convex run …` an operator is told to type must name the production
// deployment. The Convex CLI finds the project through packages/backend/.env.local, and on the
// owner's machine that file says CONVEX_DEPLOYMENT=dev:…. `convex deploy` targets production
// regardless, but `env` and `run` act on CONVEX_DEPLOYMENT unless told otherwise, so a runbook line
// without `--prod` changes the dev deployment while the live fleet keeps running on the old value.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");

// Where operator-facing commands live: every doc and runbook, the scripts operators run, and the
// strings the dashboard, the backend and the CLI show them.
const ROOTS = [
  "README.md",
  "CONTEXT.md",
  "docs",
  "deploy",
  "apps/dashboard/src",
  "apps/erainfra-cli",
  "packages/backend/convex",
  "packages/backend/scripts",
];
const EXTENSIONS = new Set([".md", ".sh", ".ps1", ".ts", ".tsx", ".go"]);
const SKIP_DIRECTORIES = new Set(["node_modules", "_generated", "dist"]);

// A command written for a dev deployment on purpose, by file and an exact piece of its line. Each
// entry needs a reason a reader of that file would accept; none exists today.
const DEV_ONLY: readonly { file: string; command: string; reason: string }[] = [];

// `convex env <subcommand> <argument>` or `convex run <argument>`. A bare mention in prose, such as
// "`npx convex run` carries no user", has no argument and is not a command to type.
const COMMAND = /\bconvex\s+(?:env\s+(?:set|get|list|remove|rm|unset)|run)\s+(?=[^\s`"'])/;
// Any of the CLI's explicit deployment selectors. Only --prod appears today.
const NAMES_DEPLOYMENT = /\s--(?:prod|deployment|deployment-name|preview-name|url)\b/;

function files(relative: string): string[] {
  const absolute = path.join(repoRoot, relative);
  if (!statSync(absolute).isDirectory())
    return EXTENSIONS.has(path.extname(relative)) ? [relative] : [];
  return readdirSync(absolute).flatMap((entry) =>
    SKIP_DIRECTORIES.has(entry) || entry.startsWith(".") ? [] : files(path.join(relative, entry)),
  );
}

/** Lines joined across shell `\` continuations, each with the number of its first physical line. */
function logicalLines(text: string) {
  const lines: { line: number; text: string }[] = [];
  let pending: { line: number; text: string } | null = null;
  text.split("\n").forEach((raw, index) => {
    const current: { line: number; text: string } = pending
      ? { line: pending.line, text: `${pending.text} ${raw.trim()}` }
      : { line: index + 1, text: raw };
    if (raw.endsWith("\\")) {
      pending = { line: current.line, text: current.text.slice(0, -1) };
    } else {
      lines.push(current);
      pending = null;
    }
  });
  if (pending) lines.push(pending);
  return lines;
}

function commandsWithoutDeployment() {
  const found: { file: string; line: number; text: string }[] = [];
  for (const file of ROOTS.flatMap(files)) {
    for (const { line, text } of logicalLines(readFileSync(path.join(repoRoot, file), "utf8"))) {
      if (COMMAND.test(text) && !NAMES_DEPLOYMENT.test(text)) found.push({ file, line, text });
    }
  }
  return found;
}

describe("operator commands that act on a Convex deployment", () => {
  it("the pinned CLI picks production for env and run only when told to", () => {
    // The CLI is ESM that needs its own dependencies at load time, so read the rule rather than
    // import it. If an upgrade changes it, re-check what an unflagged command reaches.
    const api = path.join(
      path.dirname(createRequire(import.meta.url).resolve("convex/package.json")),
      "dist/esm/cli/lib/api.js",
    );
    const source = readFileSync(api, "utf8");
    const rule = source.slice(
      source.indexOf("export function deploymentSelectionWithinProjectFromOptions"),
    );
    expect(rule).toMatch(/if \(options\.prod\) \{\s*return \{ kind: "prod" \};/);
    expect(rule).toMatch(/return \{ kind: "unspecified" \};/);
  });

  it("finds a command without --prod, across a line continuation, and ignores prose", () => {
    expect(COMMAND.test("npx convex env set ERAINFRA_FAILOVER 0")).toBe(true);
    expect(COMMAND.test("`npx convex run` carries no user, so it cannot bind.")).toBe(false);
    expect(COMMAND.test("`npx convex env get` prints nothing for an unset variable")).toBe(false);
    const joined = logicalLines("npx convex run infra/nodes:enroll \\\n  '{}' --prod\nnext");
    expect(joined).toEqual([
      { line: 1, text: "npx convex run infra/nodes:enroll  '{}' --prod" },
      { line: 3, text: "next" },
    ]);
    expect(NAMES_DEPLOYMENT.test(joined[0].text)).toBe(true);
    expect(NAMES_DEPLOYMENT.test("npx convex env set --production-ish X 1")).toBe(false);
  });

  it("name the production deployment everywhere an operator reads them", () => {
    const offenders = commandsWithoutDeployment().filter(
      ({ file, text }) =>
        !DEV_ONLY.some((allowed) => allowed.file === file && text.includes(allowed.command)),
    );
    expect(
      offenders.map(({ file, line, text }) => `${file}:${line}: ${text.trim()}`),
      "add --prod: without it the command acts on the deployment .env.local names, a dev deployment",
    ).toEqual([]);
  });

  it("keeps no stale dev-only exception", () => {
    const remaining = commandsWithoutDeployment();
    for (const allowed of DEV_ONLY) {
      expect(
        remaining.some(({ file, text }) => file === allowed.file && text.includes(allowed.command)),
        `${allowed.file}: "${allowed.command}" no longer appears; drop it from DEV_ONLY`,
      ).toBe(true);
    }
  });

  it("checks the runbooks the rollout runs", () => {
    const scanned = ROOTS.flatMap(files);
    for (const runbook of [
      "docs/runbooks/retire-the-hub.md",
      "docs/runbooks/move-ingress-to-gateways.md",
      "docs/runbooks/deploy-control-plane.md",
      "docs/infra-management.md",
      "deploy/infra/gateway.sh",
      "apps/dashboard/src/routes/login.tsx",
      "packages/backend/convex/githubAppConfig.ts",
    ]) {
      expect(scanned).toContain(runbook);
    }
  });
});
