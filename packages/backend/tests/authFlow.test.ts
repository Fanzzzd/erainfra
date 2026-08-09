import { convexTest } from "convex-test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import { SIGNUP_REFUSED } from "../convex/bootstrap.ts";
import schema from "../convex/schema";

// End-to-end cover for the sign-up gate: these go through the real
// `auth:signIn` action and the real Password provider rather than calling the
// callback directly, so the `profile` -> `createOrUpdateUser` hand-off that
// carries the grant is exercised as it runs in production.

const SECRET = "0123456789abcdef0123456789abcdef";
const PASSWORD = "correct-horse-battery";
const modules = import.meta.glob("../convex/**/*.ts");

/** What `npx @convex-dev/auth` provisions on a real deployment. */
beforeAll(async () => {
  const keys = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey));
  const base64 = btoa(String.fromCodePoint(...pkcs8));
  process.env.JWT_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----\n${base64.replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----`;
  const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  process.env.JWKS = JSON.stringify({ keys: [{ ...jwk, use: "sig" }] });
  process.env.SITE_URL = "http://localhost";
  process.env.CONVEX_SITE_URL = "http://localhost";
});

beforeEach(() => {
  process.env.BOOTSTRAP_SECRET = SECRET;
});

afterEach(() => {
  delete process.env.BOOTSTRAP_SECRET;
});

function harness() {
  return convexTest(schema, modules);
}

async function signUp(t: ReturnType<typeof harness>, email: string, signupGrant?: string) {
  return await t.action(api.auth.signIn, {
    provider: "password",
    params: {
      email,
      password: PASSWORD,
      flow: "signUp",
      ...(signupGrant === undefined ? {} : { signupGrant }),
    },
  });
}

async function claimGrant(t: ReturnType<typeof harness>) {
  const claimed = await t.mutation(api.bootstrap.claim, { secret: SECRET });
  if (!claimed.ok) {
    throw new Error(`expected a grant, got ${claimed.reason}`);
  }
  return claimed.grantToken;
}

describe("password sign-up, end to end", () => {
  // The takeover this whole design exists to close: before it, this call
  // created the sole admin for anyone who made it first.
  it("refuses an unauthenticated sign-up carrying no grant", async () => {
    const t = harness();
    await expect(signUp(t, "attacker@example.com")).rejects.toThrow();

    const users = await t.run(async (ctx) => await ctx.db.query("users").collect());
    expect(users).toHaveLength(0);
  });

  it("refuses a forged grant", async () => {
    const t = harness();
    await expect(signUp(t, "attacker@example.com", "f".repeat(64))).rejects.toThrow();

    const users = await t.run(async (ctx) => await ctx.db.query("users").collect());
    expect(users).toHaveLength(0);
  });

  it("creates the first admin from a claimed grant", async () => {
    const t = harness();
    await signUp(t, "admin@example.com", await claimGrant(t));

    const users = await t.run(async (ctx) => await ctx.db.query("users").collect());
    expect(users).toHaveLength(1);
    expect(users[0]!.email).toBe("admin@example.com");
  });

  it("does not persist the grant on the user row", async () => {
    const t = harness();
    const grant = await claimGrant(t);
    await signUp(t, "admin@example.com", grant);

    const users = await t.run(async (ctx) => await ctx.db.query("users").collect());
    expect(JSON.stringify(users)).not.toContain(grant);
  });

  it("closes sign-up once the first admin exists", async () => {
    const t = harness();
    await signUp(t, "admin@example.com", await claimGrant(t));

    await expect(signUp(t, "second@example.com")).rejects.toThrow();
    const users = await t.run(async (ctx) => await ctx.db.query("users").collect());
    expect(users).toHaveLength(1);
  });

  it("reopens sign-up for exactly one account per admin invitation", async () => {
    const t = harness();
    await signUp(t, "admin@example.com", await claimGrant(t));
    const userId = await t.run(async (ctx) => (await ctx.db.query("users").first())!._id);

    const { grantToken } = await t
      .withIdentity({ subject: userId })
      .mutation(api.bootstrap.invite, {});

    await signUp(t, "colleague@example.com", grantToken);
    await expect(signUp(t, "third@example.com", grantToken)).rejects.toThrow();

    const users = await t.run(async (ctx) => await ctx.db.query("users").collect());
    expect(users).toHaveLength(2);
  });

  it("lets an existing account keep signing in after the gate closed", async () => {
    const t = harness();
    await signUp(t, "admin@example.com", await claimGrant(t));

    // The real point of the regression: sign-in resolves an existing account
    // and never reaches the sign-up gate.
    await t.action(api.auth.signIn, {
      provider: "password",
      params: { email: "admin@example.com", password: PASSWORD, flow: "signIn" },
    });

    const users = await t.run(async (ctx) => await ctx.db.query("users").collect());
    expect(users).toHaveLength(1);
  });

  it("rejects a wrong password for an existing account", async () => {
    const t = harness();
    await signUp(t, "admin@example.com", await claimGrant(t));

    await expect(
      t.action(api.auth.signIn, {
        provider: "password",
        params: { email: "admin@example.com", password: "not-the-password", flow: "signIn" },
      }),
    ).rejects.toThrow();
  });

  it("says the same thing however a sign-up is refused", async () => {
    const t = harness();
    const expired = await claimGrant(t);
    await t.run(async (ctx) => {
      const grant = await ctx.db.query("signupGrants").first();
      await ctx.db.patch(grant!._id, { expiresAt: Date.now() - 1 });
    });

    const messages: string[] = [];
    for (const grant of [undefined, "f".repeat(64), expired]) {
      await signUp(t, "probe@example.com", grant).catch((caught: unknown) => {
        messages.push(caught instanceof Error ? caught.message : String(caught));
      });
    }

    expect(messages).toHaveLength(3);
    for (const message of messages) {
      expect(message).toContain(SIGNUP_REFUSED);
    }
    // Nothing in the refusal distinguishes the three causes from each other.
    expect(new Set(messages).size).toBe(1);
  });
});
