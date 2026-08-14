import { readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

type FullScanAllowance = {
  occurrences: number;
  reason: string;
};

// Full scans are reserved for deliberately small control-plane dimensions or
// complete dashboard joins. The occurrence count keeps a justified scan from
// silently allowing a second scan of the same table elsewhere in the module.
const justifiedFullScans: Record<string, FullScanAllowance> = {
  "attempts.ts:machines": {
    occurrences: 1,
    reason: "The bounded 200-row Attempt dashboard joins the operator-managed Worker fleet.",
  },
  "experiments.ts:machines": {
    occurrences: 1,
    reason: "The bounded 100-row Experiment dashboard joins the operator-managed Worker fleet.",
  },
  "githubApp.ts:githubApp": {
    occurrences: 1,
    reason: "githubApp is an enforced singleton replaced by the App setup mutation.",
  },
  "githubApp.ts:githubAppSetups": {
    occurrences: 1,
    reason: "Setup states are operator-authored, short-lived, and swept only when setup begins.",
  },
  "jobs.ts:machines": {
    occurrences: 1,
    reason: "The bounded 200-row Job dashboard joins the operator-managed Worker fleet.",
  },
  "machines.ts:benchmarkEvidence": {
    occurrences: 1,
    reason: "There is at most one benchmark evidence row per Worker in the fleet dashboard.",
  },
  "machines.ts:machines": {
    occurrences: 1,
    reason: "The fleet dashboard intentionally returns every operator-managed Worker.",
  },
  "machines.ts:readinessEvidence": {
    occurrences: 1,
    reason: "Readiness evidence is bounded to one row per Worker/Profile dashboard pair.",
  },
  "machines.ts:workerReadiness": {
    occurrences: 1,
    reason: "Readiness is bounded to one row per Worker/Profile dashboard pair.",
  },
  "profiles.ts:machines": {
    occurrences: 1,
    reason: "The Profile dashboard needs the complete operator-managed Worker dimension.",
  },
  "profiles.ts:profiles": {
    occurrences: 1,
    reason: "Profiles are a small operator-authored configuration dimension shown in full.",
  },
  "profiles.ts:readinessEvidence": {
    occurrences: 1,
    reason: "Readiness evidence is bounded to one row per Worker/Profile dashboard pair.",
  },
  "profiles.ts:workerReadiness": {
    occurrences: 1,
    reason: "Readiness is bounded to one row per Worker/Profile dashboard pair.",
  },
};

function convexModules(directory: URL, prefix = ""): Array<{ name: string; url: URL }> {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      return convexModules(new URL(`${entry.name}/`, directory), `${name}/`);
    }
    return entry.isFile() && entry.name.endsWith(".ts")
      ? [{ name, url: new URL(entry.name, directory) }]
      : [];
  });
}

function fullTableCollects(moduleName: string, source: string) {
  const findings: Array<{ key: string; line: number }> = [];
  const queryCollect =
    /\.query\(\s*(["'])([^"']+)\1\s*\)((?:(?!\.query\()[^;]){0,1000}?)\.collect\(\)/gs;
  for (const match of source.matchAll(queryCollect)) {
    if (match[3]?.includes(".withIndex(")) continue;
    const line = source.slice(0, match.index).split("\n").length;
    findings.push({ key: `${moduleName}:${match[2]}`, line });
  }
  return findings;
}

describe("hot-path database reads", () => {
  it("indexes or explicitly justifies full scans in every Convex module", () => {
    const modules = convexModules(new URL("../convex/", import.meta.url));
    const findings = modules.flatMap(({ name, url }) =>
      fullTableCollects(name, readFileSync(url, "utf8")),
    );
    const counts = new Map<string, number>();
    for (const { key } of findings) counts.set(key, (counts.get(key) ?? 0) + 1);

    const unexpected = findings.filter(({ key }) => justifiedFullScans[key] === undefined);
    const staleOrChangedAllowlist = Object.entries(justifiedFullScans).flatMap(
      ([key, allowance]) =>
        counts.get(key) === allowance.occurrences
          ? []
          : [`${key}: expected ${allowance.occurrences}, found ${counts.get(key) ?? 0}`],
    );

    expect(unexpected).toEqual([]);
    expect(staleOrChangedAllowlist).toEqual([]);
  });
});
