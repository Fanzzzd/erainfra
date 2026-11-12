import { readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ACTIVE_ATTEMPT_STATES,
  ACTIVE_EXPERIMENT_STATES,
  ASSIGNED_ATTEMPT_STATES,
  ASSIGNED_EXPERIMENT_STATES,
  IDLE_ATTEMPT_STATES,
  TERMINAL_ATTEMPT_STATES,
  TERMINAL_EXPERIMENT_STATES,
} from "../convex/attemptStates";
import schema from "../convex/schema";

function stateLiterals(table: "attempts" | "experiments"): string[] {
  const state = schema.tables[table].validator.fields.state;
  if (state.kind !== "union") throw new Error(`${table}.state is not a union`);
  return state.members.map((member) => {
    if (member.kind !== "literal") throw new Error(`${table}.state has a non-literal member`);
    return String(member.value);
  });
}

function sorted(values: readonly string[]) {
  return values.toSorted((left, right) => left.localeCompare(right));
}

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

describe("attemptStates", () => {
  it("classifies every Attempt state in the schema exactly once", () => {
    const classified = [...ACTIVE_ATTEMPT_STATES, ...TERMINAL_ATTEMPT_STATES];
    expect(new Set(classified).size).toBe(classified.length);
    expect(sorted(classified)).toEqual(sorted(stateLiterals("attempts")));
  });

  it("classifies every Experiment state in the schema exactly once", () => {
    const classified = [...ACTIVE_EXPERIMENT_STATES, ...TERMINAL_EXPERIMENT_STATES];
    expect(new Set(classified).size).toBe(classified.length);
    expect(sorted(classified)).toEqual(sorted(stateLiterals("experiments")));
  });

  it("derives the narrower lists from the active ones", () => {
    const without = (states: readonly string[], subset: readonly string[]) =>
      states.filter((state) => !subset.includes(state));
    // The scheduler reads pending Attempts and queued Experiments separately.
    expect(without(ACTIVE_ATTEMPT_STATES, ASSIGNED_ATTEMPT_STATES)).toEqual(["pending"]);
    expect(without(ACTIVE_EXPERIMENT_STATES, ASSIGNED_EXPERIMENT_STATES)).toEqual(["queued"]);
    expect(without(ACTIVE_ATTEMPT_STATES, IDLE_ATTEMPT_STATES)).toEqual(["running"]);
    expect(without(IDLE_ATTEMPT_STATES, ACTIVE_ATTEMPT_STATES)).toEqual([]);
  });

  // A module that declares its own list drifts the first time a state is added: slot counts,
  // reconciliation and routing then disagree about which Attempts hold a Worker.
  it("is the only backend module that lists active states", () => {
    const activeState = String.raw`"(?:pending|queued|preparing|ready|running)"`;
    const stateList = new RegExp(
      String.raw`\[\s*(?:${activeState}\s*,\s*)+${activeState}\s*,?\s*\]`,
    );
    const copies = convexModules(new URL("../convex/", import.meta.url))
      .filter(({ name }) => name !== "attemptStates.ts")
      .filter(({ url }) => stateList.test(readFileSync(url, "utf8")))
      .map(({ name }) => name);
    expect(copies).toEqual([]);
  });
});
