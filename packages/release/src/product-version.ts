import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * The product packages Changesets versions as one `fixed` group (.changeset/config.json). They
 * must agree after `changeset version`, and their shared version is the product version.
 */
export const PRODUCT_PACKAGES = [
  "apps/action-runner-agent",
  "apps/controller",
  "apps/runtime",
  "packages/backend",
  "apps/dashboard",
] as const;

type Edit = { file: string; apply: (text: string, version: string) => string };

function replaceOnce(text: string, pattern: RegExp, replacement: string, file: string) {
  if (!pattern.test(text)) throw new Error(`${file}: no product version found to replace`);
  return text.replace(pattern, replacement);
}

/**
 * Files that carry the product version but that Changesets does not edit. The release workflow
 * refuses a tag where any of them disagrees with the root package.json.
 */
const EDITS: Edit[] = [
  {
    file: "package.json",
    apply: (text, v) => replaceOnce(text, /^(  "version": )"[^"]*"/m, `$1"${v}"`, "package.json"),
  },
  {
    file: "apps/mesh/Cargo.toml",
    apply: (text, v) =>
      replaceOnce(text, /^(version = )"[^"]*"/m, `$1"${v}"`, "apps/mesh/Cargo.toml"),
  },
  {
    file: "apps/mesh/Cargo.lock",
    apply: (text, v) =>
      replaceOnce(
        text,
        /(\[\[package\]\]\nname = "erainfra-mesh"\nversion = )"[^"]*"/,
        `$1"${v}"`,
        "apps/mesh/Cargo.lock",
      ),
  },
  {
    // npm writes the version twice: at the top and under packages[""].
    file: "apps/action-runner-agent/package-lock.json",
    apply: (text, v) => {
      const lock = JSON.parse(text);
      if (lock.packages?.[""] === undefined) {
        throw new Error("apps/action-runner-agent/package-lock.json: no root package entry");
      }
      lock.version = v;
      lock.packages[""].version = v;
      return `${JSON.stringify(lock, null, 2)}\n`;
    },
  },
  {
    file: "packages/backend/convex/agentRelease.ts",
    apply: (text, v) =>
      replaceOnce(
        text,
        /(export const AGENT_RELEASE: AgentRelease = \{\n  repo: "[^"]*",\n  version: )"[^"]*"/,
        `$1"${v}"`,
        "packages/backend/convex/agentRelease.ts",
      ),
  },
];

function packageVersion(repoRoot: string, dir: string): string {
  return JSON.parse(readFileSync(path.join(repoRoot, dir, "package.json"), "utf8")).version;
}

/** Reads the fixed group's version and writes it everywhere else the product version lives. */
export function syncProductVersion(repoRoot: string): { version: string; changed: string[] } {
  const versions = PRODUCT_PACKAGES.map((dir) => [dir, packageVersion(repoRoot, dir)] as const);
  const version = versions[0][1];
  const disagree = versions.filter(([, v]) => v !== version);
  if (disagree.length > 0) {
    throw new Error(
      `product packages disagree: ${versions.map(([d, v]) => `${d}=${v}`).join(", ")}; ` +
        "check the fixed group in .changeset/config.json",
    );
  }
  const changed: string[] = [];
  for (const edit of EDITS) {
    const file = path.join(repoRoot, edit.file);
    const before = readFileSync(file, "utf8");
    const after = edit.apply(before, version);
    if (after !== before) {
      writeFileSync(file, after);
      changed.push(edit.file);
    }
  }
  return { version, changed };
}
