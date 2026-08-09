import { describe, expect, it } from "vitest";
import {
  backoffMs,
  decideAttemptOutcome,
  MAX_PROVISION_ATTEMPTS,
  summarizeError,
} from "../convex/retry.ts";

describe("backoffMs", () => {
  it("grows with each attempt and then holds", () => {
    expect(backoffMs(0)).toBe(0);
    expect(backoffMs(1)).toBe(15_000);
    expect(backoffMs(2)).toBe(60_000);
    expect(backoffMs(3)).toBe(300_000);
    expect(backoffMs(99)).toBe(300_000);
  });
});

describe("decideAttemptOutcome", () => {
  const now = 1_000_000;

  it("retries behind a growing backoff while attempts remain", () => {
    const first = decideAttemptOutcome(1, now, "boom");
    expect(first.kind).toBe("retry");
    expect(first.kind === "retry" && first.nextAttemptAt).toBe(now + 15_000);

    const second = decideAttemptOutcome(2, now, "boom");
    expect(second.kind === "retry" && second.nextAttemptAt).toBe(now + 60_000);
  });

  it("gives up once the attempt budget is spent", () => {
    const outcome = decideAttemptOutcome(MAX_PROVISION_ATTEMPTS, now, "boom");
    expect(outcome.kind).toBe("exhausted");
    expect(outcome.attempts).toBe(MAX_PROVISION_ATTEMPTS);
  });

  it("never retries past the cap even if the counter overshoots", () => {
    expect(decideAttemptOutcome(MAX_PROVISION_ATTEMPTS + 5, now, "boom").kind).toBe("exhausted");
  });

  it("carries a summarized error into the outcome", () => {
    const outcome = decideAttemptOutcome(1, now, "  line one\n  line two  ");
    expect(outcome.lastError).toBe("line one line two");
  });
});

describe("summarizeError", () => {
  it("collapses whitespace so the dashboard shows one line", () => {
    expect(summarizeError("a\n\tb   c")).toBe("a b c");
  });

  it("falls back to a placeholder for an empty message", () => {
    expect(summarizeError("   ")).toBe("Unknown error");
  });

  it("truncates a very long message", () => {
    const summarized = summarizeError("x".repeat(1_000));
    expect(summarized).toHaveLength(500);
    expect(summarized.endsWith("…")).toBe(true);
  });
});
