import { compareValues, type Value } from "convex/values";
import { describe, expect, test } from "vitest";

import { encodeKey } from "../src/store/keys.ts";

// A small deterministic generator, so a failure reproduces.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomValue(r: () => number, depth = 0): Value | undefined {
  const pick = Math.floor(r() * (depth > 1 ? 7 : 10));
  const numbers = [0, -0, 1, -1, 0.5, -0.5, 1e300, -1e300, Infinity, -Infinity, 42, 3.25, 2 ** 53];
  const strings = ["", "a", "a\u0000", "a\u0000b", "ab", "b", "é", "😀", "Z", "\u0000"];
  switch (pick) {
    case 0:
      return undefined;
    case 1:
      return null;
    case 2:
      return [0n, -1n, 1n, 2n ** 62n, -(2n ** 63n), 2n ** 63n - 1n][Math.floor(r() * 6)] as bigint;
    case 3:
      return numbers[Math.floor(r() * numbers.length)] as number;
    case 4:
      return r() < 0.5;
    case 5:
      return strings[Math.floor(r() * strings.length)] as string;
    case 6: {
      const bytes = new Uint8Array(Math.floor(r() * 3)).map(() => Math.floor(r() * 3));
      return bytes.buffer;
    }
    case 7:
    case 8:
      return Array.from({ length: Math.floor(r() * 3) }, () => randomValue(r, depth + 1) ?? null);
    default: {
      const obj: Record<string, Value> = {};
      for (const k of ["a", "b", "c"]) if (r() < 0.5) obj[k] = randomValue(r, depth + 1) ?? null;
      return obj;
    }
  }
}

const sign = (n: number) => (n < 0 ? -1 : n > 0 ? 1 : 0);

describe("encodeKey", () => {
  test("orders single values exactly like compareValues", () => {
    const r = rng(1);
    for (let i = 0; i < 20_000; i++) {
      const a = randomValue(r);
      const b = randomValue(r);
      const ka = encodeKey([a]);
      const kb = encodeKey([b]);
      const keyOrder = ka < kb ? -1 : ka > kb ? 1 : 0;
      expect({ a, b, order: keyOrder }).toEqual({ a, b, order: sign(compareValues(a, b)) });
    }
  });

  test("orders tuples field by field", () => {
    const r = rng(2);
    for (let i = 0; i < 5_000; i++) {
      const a = [randomValue(r), randomValue(r)];
      const b = [randomValue(r), randomValue(r)];
      const expected = sign(compareValues(a[0], b[0])) || sign(compareValues(a[1], b[1]));
      const ka = encodeKey(a);
      const kb = encodeKey(b);
      expect(ka < kb ? -1 : ka > kb ? 1 : 0).toBe(expected);
    }
  });

  test("is hex only, so a prefix plus g bounds every key with that prefix", () => {
    expect(encodeKey(["x", 1, null, undefined, [1n], { a: true }])).toMatch(/^[0-9a-f]+$/);
  });
});
