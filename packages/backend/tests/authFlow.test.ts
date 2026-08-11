import { convexTest } from "convex-test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import {
  INVALID_CREDENTIALS,
  isPasswordRequirementsError,
  MIN_PASSWORD_LENGTH,
  PASSWORD_REQUIREMENTS,
  validatePasswordRequirements,
} from "../convex/authPolicy.ts";
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

async function signUp(
  t: ReturnType<typeof harness>,
  email: string,
  signupGrant?: string,
  password: string = PASSWORD,
) {
  return await t.action(api.auth.signIn, {
    provider: "password",
    params: {
      email,
      password,
      flow: "signUp",
      ...(signupGrant === undefined ? {} : { signupGrant }),
    },
  });
}

async function signInAttempt(t: ReturnType<typeof harness>, email: string, password: string) {
  return await t.action(api.auth.signIn, {
    provider: "password",
    params: { email, password, flow: "signIn" },
  });
}

/** The message a refused call actually hands back, for comparing refusals. */
async function refusalMessage(call: Promise<unknown>) {
  try {
    await call;
  } catch (caught) {
    return caught instanceof Error ? caught.message : String(caught);
  }
  throw new Error("expected the call to be refused, but it succeeded");
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

describe("validatePasswordRequirements", () => {
  it("refuses anything under the floor and accepts the floor itself", () => {
    expect(() => validatePasswordRequirements("a".repeat(MIN_PASSWORD_LENGTH - 1))).toThrow(
      PASSWORD_REQUIREMENTS,
    );
    expect(() => validatePasswordRequirements("")).toThrow(PASSWORD_REQUIREMENTS);
    expect(() => validatePasswordRequirements("a".repeat(MIN_PASSWORD_LENGTH))).not.toThrow();
  });

  it("recognises its own refusal and nothing else", () => {
    expect(isPasswordRequirementsError(new Error(PASSWORD_REQUIREMENTS))).toBe(true);
    expect(isPasswordRequirementsError(new Error(INVALID_CREDENTIALS))).toBe(false);
    expect(isPasswordRequirementsError(PASSWORD_REQUIREMENTS)).toBe(false);
  });
});

describe("password policy, end to end", () => {
  it("refuses a sign-up under the floor even with a valid grant", async () => {
    const t = harness();
    const grant = await claimGrant(t);
    const message = await refusalMessage(
      signUp(t, "admin@example.com", grant, "a".repeat(MIN_PASSWORD_LENGTH - 1)),
    );

    expect(message).toContain(PASSWORD_REQUIREMENTS);
    const users = await t.run(async (ctx) => await ctx.db.query("users").collect());
    expect(users).toHaveLength(0);
  });

  // The password is validated before the account lookup, so a refused password
  // must not cost the operator their one-shot grant.
  it("leaves the grant usable after a password the policy refused", async () => {
    const t = harness();
    const grant = await claimGrant(t);
    await expect(signUp(t, "admin@example.com", grant, "short")).rejects.toThrow();

    await signUp(t, "admin@example.com", grant);
    const users = await t.run(async (ctx) => await ctx.db.query("users").collect());
    expect(users).toHaveLength(1);
  });

  it("accepts a password exactly at the floor", async () => {
    const t = harness();
    await signUp(t, "admin@example.com", await claimGrant(t), "a".repeat(MIN_PASSWORD_LENGTH));

    const users = await t.run(async (ctx) => await ctx.db.query("users").collect());
    expect(users).toHaveLength(1);
  });

  // Raising the floor must not lock out an account created under the old one.
  // If the rule ran on sign-in, a short password would be refused as a policy
  // violation before any account was looked up; it is refused as a credential.
  it("does not apply the floor to sign-in", async () => {
    const t = harness();
    await signUp(t, "admin@example.com", await claimGrant(t));

    const message = await refusalMessage(signInAttempt(t, "admin@example.com", "short"));
    expect(message).toContain(INVALID_CREDENTIALS);
    expect(message).not.toContain(PASSWORD_REQUIREMENTS);
  });
});

describe("credential failures do not reveal whether an email exists", () => {
  it("answers a wrong password and an unknown address identically", async () => {
    const t = harness();
    await signUp(t, "admin@example.com", await claimGrant(t));

    const wrongPassword = await refusalMessage(
      signInAttempt(t, "admin@example.com", "not-the-password"),
    );
    const unknownAddress = await refusalMessage(
      signInAttempt(t, "nobody@example.com", "not-the-password"),
    );

    expect(wrongPassword).toContain(INVALID_CREDENTIALS);
    expect(wrongPassword).toBe(unknownAddress);
    expect(wrongPassword).not.toContain("admin@example.com");
  });

  // The worse of the two oracles: reaching it needs no grant, so before this an
  // unauthenticated caller could enumerate accounts through the sign-up path.
  it("answers an already-registered address and a new one identically", async () => {
    const t = harness();
    await signUp(t, "admin@example.com", await claimGrant(t));

    const existing = await refusalMessage(
      signUp(t, "admin@example.com", undefined, "another-long-password"),
    );
    const unknown = await refusalMessage(
      signUp(t, "nobody@example.com", undefined, "another-long-password"),
    );

    expect(existing).toContain(SIGNUP_REFUSED);
    expect(existing).toBe(unknown);
    expect(existing).not.toContain("admin@example.com");
  });
});
