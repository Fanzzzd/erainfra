import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { SIGNUP_REFUSED } from "../convex/bootstrap.ts";
import {
  constantTimeEqual,
  FAILURE_ALLOWANCE,
  GRANT_TTL_MS,
  MAX_LOCKOUT_MS,
  nextThrottleAfterFailure,
  readBootstrapSecret,
  throttleState,
} from "../convex/bootstrapPolicy.ts";
import schema from "../convex/schema";

const SECRET = "0123456789abcdef0123456789abcdef";
const modules = import.meta.glob("../convex/**/*.ts");

type Harness = TestConvex<typeof schema>;

function harness() {
  return convexTest(schema, modules);
}

/**
 * Drives the same callback the Password provider reaches on a sign-up, without
 * standing up the whole credential flow. `createOrUpdateUser` is the single
 * gate every new account passes through, so this is the surface that matters.
 */
async function signUp(t: Harness, email: string, signupGrant?: string) {
  return await t.run(async (ctx) => {
    const { consumeSignupGrant } = await import("../convex/bootstrap.ts");
    await consumeSignupGrant(ctx, signupGrant);
    return await ctx.db.insert("users", { email, emailVerificationTime: undefined });
  });
}

beforeEach(() => {
  process.env.BOOTSTRAP_SECRET = SECRET;
});

afterEach(() => {
  delete process.env.BOOTSTRAP_SECRET;
});

describe("readBootstrapSecret", () => {
  it("fails closed when the secret is unset or blank", () => {
    for (const env of [{}, { BOOTSTRAP_SECRET: "" }, { BOOTSTRAP_SECRET: "   " }]) {
      const config = readBootstrapSecret(env);
      expect(config.configured).toBe(false);
      expect(config.configured === false && config.reason).toContain("BOOTSTRAP_SECRET");
    }
  });

  it("refuses a secret that is too short to survive the lockout schedule", () => {
    expect(readBootstrapSecret({ BOOTSTRAP_SECRET: "short" }).configured).toBe(false);
    expect(readBootstrapSecret({ BOOTSTRAP_SECRET: SECRET }).configured).toBe(true);
  });
});

describe("constantTimeEqual", () => {
  it("matches identical bytes and rejects any difference", () => {
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2]))).toBe(false);
  });
});

describe("failed-attempt throttle", () => {
  it("tolerates the allowance, then locks for longer each time", () => {
    let row = null as { failures: number; lockedUntil: number } | null;
    for (let attempt = 1; attempt <= FAILURE_ALLOWANCE; attempt += 1) {
      row = nextThrottleAfterFailure(row, 1_000);
      expect(throttleState(row, 1_000).locked).toBe(false);
    }
    const first = nextThrottleAfterFailure(row, 1_000);
    expect(throttleState(first, 1_000).locked).toBe(true);
    const second = nextThrottleAfterFailure(first, 1_000);
    expect(second.lockedUntil).toBeGreaterThan(first.lockedUntil);
  });

  it("caps the lockout so a typo cannot brick setup", () => {
    let row = nextThrottleAfterFailure(null, 0);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      row = nextThrottleAfterFailure(row, 0);
    }
    expect(row.lockedUntil).toBeLessThanOrEqual(MAX_LOCKOUT_MS);
  });

  it("stops honouring a lock once it has expired", () => {
    expect(throttleState({ failures: 9, lockedUntil: 500 }, 1_000).locked).toBe(false);
  });
});

describe("bootstrap.claim", () => {
  it("refuses a wrong secret and counts the attempt", async () => {
    const t = harness();
    const result = await t.mutation(api.bootstrap.claim, { secret: "wrong".repeat(10) });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("rejected");

    const throttle = await t.run(async (ctx) => await ctx.db.query("bootstrapThrottle").first());
    expect(throttle?.failures).toBe(1);
  });

  it("locks out after the allowance is spent", async () => {
    const t = harness();
    for (let attempt = 0; attempt <= FAILURE_ALLOWANCE; attempt += 1) {
      await t.mutation(api.bootstrap.claim, { secret: "wrong".repeat(10) });
    }

    const locked = await t.mutation(api.bootstrap.claim, { secret: SECRET });
    expect(locked.ok).toBe(false);
    expect(locked.ok === false && locked.reason).toBe("locked");
    expect(locked.ok === false && (locked.retryAfterMs ?? 0)).toBeGreaterThan(0);
  });

  it("fails closed when no bootstrap secret is configured", async () => {
    delete process.env.BOOTSTRAP_SECRET;
    const t = harness();

    const result = await t.mutation(api.bootstrap.claim, { secret: SECRET });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("unavailable");
  });

  it("mints a grant for the right secret and clears the failure count", async () => {
    const t = harness();
    await t.mutation(api.bootstrap.claim, { secret: "wrong".repeat(10) });

    const result = await t.mutation(api.bootstrap.claim, { secret: SECRET });
    expect(result.ok).toBe(true);
    expect(result.ok === true && result.grantToken).toMatch(/^[0-9a-f]{64}$/);

    const throttle = await t.run(async (ctx) => await ctx.db.query("bootstrapThrottle").first());
    expect(throttle?.failures).toBe(0);
  });

  it("stores only a hash of the grant, never the token itself", async () => {
    const t = harness();
    const result = await t.mutation(api.bootstrap.claim, { secret: SECRET });
    const token = result.ok === true ? result.grantToken : "";

    const grants = await t.run(async (ctx) => await ctx.db.query("signupGrants").collect());
    expect(grants).toHaveLength(1);
    expect(grants[0]!.tokenHash).not.toBe(token);
    expect(JSON.stringify(grants)).not.toContain(token);
  });

  it("tells a caller who proved the secret that the instance is already set up", async () => {
    const t = harness();
    const first = await t.mutation(api.bootstrap.claim, { secret: SECRET });
    await signUp(t, "admin@example.com", first.ok === true ? first.grantToken : undefined);

    const second = await t.mutation(api.bootstrap.claim, { secret: SECRET });
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.reason).toBe("already-bootstrapped");
  });

  it("does not leak whether the instance is bootstrapped to a wrong secret", async () => {
    const fresh = harness();
    const beforeBootstrap = await fresh.mutation(api.bootstrap.claim, { secret: "no".repeat(20) });

    const t = harness();
    const grant = await t.mutation(api.bootstrap.claim, { secret: SECRET });
    await signUp(t, "admin@example.com", grant.ok === true ? grant.grantToken : undefined);
    const afterBootstrap = await t.mutation(api.bootstrap.claim, { secret: "no".repeat(20) });

    // Identical answers either side of bootstrap: no oracle for "is this
    // instance still unclaimed?" without the secret.
    expect(afterBootstrap).toEqual(beforeBootstrap);
  });
});

describe("sign-up gate", () => {
  it("refuses a sign-up with no grant at all", async () => {
    const t = harness();
    await expect(signUp(t, "attacker@example.com")).rejects.toThrow(SIGNUP_REFUSED);

    const users = await t.run(async (ctx) => await ctx.db.query("users").collect());
    expect(users).toHaveLength(0);
  });

  it("refuses a made-up grant token", async () => {
    const t = harness();
    await expect(signUp(t, "attacker@example.com", "f".repeat(64))).rejects.toThrow(SIGNUP_REFUSED);
  });

  it("accepts a bootstrap grant exactly once", async () => {
    const t = harness();
    const claimed = await t.mutation(api.bootstrap.claim, { secret: SECRET });
    const token = claimed.ok === true ? claimed.grantToken : "";

    await signUp(t, "admin@example.com", token);
    await expect(signUp(t, "second@example.com", token)).rejects.toThrow(SIGNUP_REFUSED);

    const users = await t.run(async (ctx) => await ctx.db.query("users").collect());
    expect(users).toHaveLength(1);
  });

  it("refuses an expired grant", async () => {
    const t = harness();
    const claimed = await t.mutation(api.bootstrap.claim, { secret: SECRET });
    const token = claimed.ok === true ? claimed.grantToken : "";

    await t.run(async (ctx) => {
      const grant = await ctx.db.query("signupGrants").first();
      await ctx.db.patch(grant!._id, { expiresAt: Date.now() - 1 });
    });

    await expect(signUp(t, "admin@example.com", token)).rejects.toThrow(SIGNUP_REFUSED);
  });

  it("keeps the TTL short enough to matter", async () => {
    const t = harness();
    const claimed = await t.mutation(api.bootstrap.claim, { secret: SECRET });
    expect(claimed.ok === true && claimed.expiresAt - Date.now()).toBeLessThanOrEqual(GRANT_TTL_MS);
  });

  // One-winner semantics. Two operators who both hold the secret each get their
  // own grant; only one of them can end up as the first admin.
  it("lets only one of two concurrent bootstrap grants create the first admin", async () => {
    const t = harness();
    const first = await t.mutation(api.bootstrap.claim, { secret: SECRET });
    const firstToken = first.ok === true ? first.grantToken : "";

    // Mint a second grant directly: claim() refuses once a user exists, and
    // here neither sign-up has happened yet.
    const secondToken = "a".repeat(64);
    await t.run(async (ctx) => {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secondToken));
      await ctx.db.insert("signupGrants", {
        kind: "bootstrap",
        tokenHash: Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join(""),
        createdAt: Date.now(),
        expiresAt: Date.now() + GRANT_TTL_MS,
      });
    });

    const outcomes = await Promise.allSettled([
      signUp(t, "one@example.com", firstToken),
      signUp(t, "two@example.com", secondToken),
    ]);
    const created = outcomes.filter((outcome) => outcome.status === "fulfilled");

    expect(created).toHaveLength(1);
    const users = await t.run(async (ctx) => await ctx.db.query("users").collect());
    expect(users).toHaveLength(1);
  });

  // A grant minted before the instance was claimed stays unredeemable
  // afterwards, and stays that way however many times it is retried. It is not
  // marked used: the refusal aborts the transaction, so any write on that path
  // would roll back with it.
  it("leaves a bootstrap grant inert once the instance is claimed", async () => {
    const t = harness();
    const claimed = await t.mutation(api.bootstrap.claim, { secret: SECRET });
    const token = claimed.ok === true ? claimed.grantToken : "";

    await t.run(async (ctx) => {
      await ctx.db.insert("users", {
        email: "first@example.com",
        emailVerificationTime: undefined,
      });
    });

    await expect(signUp(t, "late@example.com", token)).rejects.toThrow(SIGNUP_REFUSED);
    await expect(signUp(t, "late@example.com", token)).rejects.toThrow(SIGNUP_REFUSED);

    const users = await t.run(async (ctx) => await ctx.db.query("users").collect());
    expect(users).toHaveLength(1);
  });
});

describe("bootstrap.invite", () => {
  it("requires an authenticated admin", async () => {
    const t = harness();
    await expect(t.mutation(api.bootstrap.invite, {})).rejects.toThrow(/Authentication required/);
  });

  it("lets an authenticated admin open sign-up for exactly one more account", async () => {
    const t = harness();
    const userId = await t.run(
      async (ctx) =>
        await ctx.db.insert("users", {
          email: "admin@example.com",
          emailVerificationTime: undefined,
        }),
    );

    const { grantToken } = await t
      .withIdentity({ subject: userId as Id<"users"> })
      .mutation(api.bootstrap.invite, {});

    // An invite works after bootstrap, where a bootstrap grant would not.
    await signUp(t, "colleague@example.com", grantToken);
    const users = await t.run(async (ctx) => await ctx.db.query("users").collect());
    expect(users).toHaveLength(2);

    await expect(signUp(t, "third@example.com", grantToken)).rejects.toThrow(SIGNUP_REFUSED);
  });
});

describe("existing users", () => {
  it("leaves an existing account untouched and still able to sign in", async () => {
    const t = harness();
    const userId = await t.run(
      async (ctx) =>
        await ctx.db.insert("users", {
          email: "existing@example.com",
          emailVerificationTime: undefined,
        }),
    );

    // The gate only runs for *new* accounts; signing in resolves an existing
    // account before createOrUpdateUser is ever consulted.
    const before = await t.run(async (ctx) => await ctx.db.get(userId));
    await expect(signUp(t, "someone-else@example.com")).rejects.toThrow(SIGNUP_REFUSED);
    const after = await t.run(async (ctx) => await ctx.db.get(userId));

    expect(after).toEqual(before);
  });
});
