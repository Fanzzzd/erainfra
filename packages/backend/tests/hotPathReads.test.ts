import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const hotPathModules = ["attemptScheduler.ts", "workerApi.ts", "reconcile.ts"];

describe("hot-path database reads", () => {
  it("does not collect an entire table without an index", () => {
    const unboundedReads = hotPathModules.flatMap((moduleName) => {
      const source = readFileSync(new URL(`../convex/${moduleName}`, import.meta.url), "utf8");
      return [...source.matchAll(/\.query\("([^"]+)"\)\s*\.collect\(\)/g)].map(
        (match) => `${moduleName}:${match[1]}`,
      );
    });

    expect(unboundedReads).toEqual([]);
  });
});
