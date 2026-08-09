import { convexTest } from "convex-test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../convex/_generated/api";
import { DISCONNECT_CONFIRMATION } from "../convex/githubAppConfig.ts";
import schema from "../convex/schema";
import { githubMock } from "./support/githubMock.ts";

const modules = {
  ...import.meta.glob("../convex/**/*.ts"),
  "../convex/github.ts": githubMock,
};

const STORED_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----stored-secret-material";
const STORED_WEBHOOK_SECRET = "whsec_stored_secret_material";
const ENV_WEBHOOK_SECRET = "whsec_legacy_env_secret";
const ENV_PAT = "ghp_legacy_env_pat";

beforeEach(() => {
  vi.unstubAllEnvs();
});

function setup() {
  return convexTest(schema, modules);
}

/** convex-test's identity shim: `status` and `disconnect` are login-gated. */
function asOperator(t: ReturnType<typeof setup>) {
  return t.withIdentity({ subject: "operator", issuer: "https://example.test" });
}

async function storeApp(t: ReturnType<typeof setup>) {
  await t.run(async (ctx) => {
    await ctx.db.insert("githubApp", {
      appId: 4242,
      clientId: "Iv1.abc123",
      slug: "runner-center-test",
      name: "Runner Center Test",
      privateKey: STORED_PRIVATE_KEY,
      webhookSecret: STORED_WEBHOOK_SECRET,
      htmlUrl: "https://github.com/apps/runner-center-test",
      createdAt: Date.now(),
    });
  });
}

describe("githubApp.status", () => {
  it("never returns a secret, in any field, on any path", async () => {
    const t = setup();
    await storeApp(t);
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", ENV_WEBHOOK_SECRET);
    vi.stubEnv("GITHUB_PAT", ENV_PAT);
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "-----BEGIN RSA PRIVATE KEY-----env");

    const status = await asOperator(t).query(api.githubApp.status, {});

    // Serialize the whole payload rather than checking known fields: a future
    // field cannot smuggle a secret past this.
    const serialized = JSON.stringify(status);
    for (const secret of [
      STORED_PRIVATE_KEY,
      STORED_WEBHOOK_SECRET,
      ENV_WEBHOOK_SECRET,
      ENV_PAT,
      "-----BEGIN RSA PRIVATE KEY-----env",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("exposes legacy credentials as presence booleans only", async () => {
    const t = setup();
    await storeApp(t);
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", ENV_WEBHOOK_SECRET);
    vi.stubEnv("GITHUB_PAT", ENV_PAT);

    const status = await asOperator(t).query(api.githubApp.status, {});

    expect(status.legacy).toEqual({
      webhookSecretConfigured: true,
      patConfigured: true,
      cutoverIncomplete: true,
    });
  });

  it("reports a finished cut-over once the legacy secrets are removed", async () => {
    const t = setup();
    await storeApp(t);

    const status = await asOperator(t).query(api.githubApp.status, {});

    expect(status.legacy.cutoverIncomplete).toBe(false);
    expect(status.legacy.webhookSecretConfigured).toBe(false);
  });

  // Precedence is the invariant this change must not disturb.
  it("keeps stored App credentials ahead of the environment", async () => {
    const t = setup();
    await storeApp(t);
    vi.stubEnv("GITHUB_APP_ID", "999");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "-----BEGIN RSA PRIVATE KEY-----env");
    vi.stubEnv("GITHUB_PAT", ENV_PAT);

    const status = await asOperator(t).query(api.githubApp.status, {});

    expect(status.source).toBe("manifest");
    expect(status.canConnect).toBe(false);
    expect(status.app?.appId).toBe(4242);
  });

  it("still reports the legacy path before an App is connected, without prompting", async () => {
    const t = setup();
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", ENV_WEBHOOK_SECRET);
    vi.stubEnv("GITHUB_PAT", ENV_PAT);

    const status = await asOperator(t).query(api.githubApp.status, {});

    expect(status.source).toBe("pat");
    expect(status.legacy.webhookSecretConfigured).toBe(true);
    // Removing the only working credentials is not advice worth giving.
    expect(status.legacy.cutoverIncomplete).toBe(false);
  });

  it("requires a signed-in operator", async () => {
    const t = setup();
    await expect(t.query(api.githubApp.status, {})).rejects.toThrow(/Authentication required/);
  });
});

describe("githubApp.disconnect", () => {
  it("refuses a call that carries no confirmation", async () => {
    const t = setup();
    await storeApp(t);

    await expect(
      // @ts-expect-error — the missing argument is the point: an accidental or
      // replayed call must not be able to disconnect.
      asOperator(t).mutation(api.githubApp.disconnect, {}),
    ).rejects.toThrow();

    const remaining = await t.run(async (ctx) => await ctx.db.query("githubApp").collect());
    expect(remaining).toHaveLength(1);
  });

  it("refuses a confirmation that does not match exactly", async () => {
    const t = setup();
    await storeApp(t);

    await expect(
      // @ts-expect-error — a near-miss string is rejected by the validator.
      asOperator(t).mutation(api.githubApp.disconnect, { confirmation: "disconnect" }),
    ).rejects.toThrow();

    const remaining = await t.run(async (ctx) => await ctx.db.query("githubApp").collect());
    expect(remaining).toHaveLength(1);
  });

  it("forgets the stored credentials when confirmed", async () => {
    const t = setup();
    await storeApp(t);

    await asOperator(t).mutation(api.githubApp.disconnect, {
      confirmation: DISCONNECT_CONFIRMATION,
    });

    const remaining = await t.run(async (ctx) => await ctx.db.query("githubApp").collect());
    expect(remaining).toHaveLength(0);
  });

  it("falls back to the environment after disconnecting, rather than to nothing", async () => {
    const t = setup();
    await storeApp(t);
    vi.stubEnv("GITHUB_APP_ID", "999");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "-----BEGIN RSA PRIVATE KEY-----env");

    await asOperator(t).mutation(api.githubApp.disconnect, {
      confirmation: DISCONNECT_CONFIRMATION,
    });
    const status = await asOperator(t).query(api.githubApp.status, {});

    expect(status.source).toBe("envApp");
    expect(status.canConnect).toBe(true);
  });

  it("requires a signed-in operator even with the right confirmation", async () => {
    const t = setup();
    await storeApp(t);

    await expect(
      t.mutation(api.githubApp.disconnect, { confirmation: DISCONNECT_CONFIRMATION }),
    ).rejects.toThrow(/Authentication required/);

    const remaining = await t.run(async (ctx) => await ctx.db.query("githubApp").collect());
    expect(remaining).toHaveLength(1);
  });
});
