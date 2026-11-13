import { readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { READINESS_STATES } from "../convex/readinessStates";
import schema from "../convex/schema";

function convexModules(directory: URL, prefix = ""): Array<{ name: string; url: URL }> {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      return entry.name === "_generated"
        ? []
        : convexModules(new URL(`${entry.name}/`, directory), `${name}/`);
    }
    return entry.isFile() && entry.name.endsWith(".ts")
      ? [{ name, url: new URL(entry.name, directory) }]
      : [];
  });
}

describe("readinessStates", () => {
  it("lists exactly the readiness states the schema stores", () => {
    const state = schema.tables.workerReadiness.validator.fields.state;
    if (state.kind !== "union") throw new Error("workerReadiness.state is not a union");
    const stored = state.members.map((member) => {
      if (member.kind !== "literal") throw new Error("workerReadiness.state has a non-literal");
      return String(member.value);
    });
    expect(stored).toEqual([...READINESS_STATES]);
  });

  // A module that declares its own list drifts the first time a state is added: the scheduler or
  // the metrics then skip rows in the new state, and a validator rejects them.
  it("is the only backend module that lists readiness states", () => {
    const readinessState = String.raw`"(?:preparing|ready|degraded|failed)"`;
    const stateList = new RegExp(
      String.raw`\[\s*(?:${readinessState}\s*,\s*)+${readinessState}\s*,?\s*\]`,
    );
    // Only readiness has a "degraded" state, so a validator literal for it is a copied union.
    const stateValidator = /v\.literal\(\s*"degraded"\s*\)/;
    const copies = convexModules(new URL("../convex/", import.meta.url))
      .filter(({ name }) => name !== "readinessStates.ts")
      .filter(({ url }) => {
        const source = readFileSync(url, "utf8");
        return stateList.test(source) || stateValidator.test(source);
      })
      .map(({ name }) => name);
    expect(copies).toEqual([]);
  });
});
