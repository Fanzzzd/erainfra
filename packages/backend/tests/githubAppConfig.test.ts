import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  APP_EVENTS,
  APP_PERMISSIONS,
  buildManifest,
  canConnectApp,
  evaluateSetupState,
  isSetupStateCollectable,
  manifestFormAction,
  normalizePrivateKey,
  parseManifestConversion,
  resolveAppCredentials,
  resolveCredentialSource,
  SETUP_STATE_TTL_MS,
  toAppSummary,
} from "../convex/githubAppConfig.ts";

const NO_ENV = { appId: undefined, privateKey: undefined, pat: undefined };
const ENV_APP = { appId: "12345", privateKey: "-----BEGIN RSA PRIVATE KEY-----" };

describe("resolveCredentialSource", () => {
  it("prefers a stored App over a legacy PAT", () => {
    assert.equal(resolveCredentialSource(true, { ...NO_ENV, pat: "ghp_legacy" }), "manifest");
  });

  it("prefers a stored App over hand-registered environment credentials", () => {
    assert.equal(resolveCredentialSource(true, { ...ENV_APP, pat: "ghp_legacy" }), "manifest");
  });

  it("falls back to a hand-registered App before the PAT", () => {
    assert.equal(resolveCredentialSource(false, { ...ENV_APP, pat: "ghp_legacy" }), "envApp");
  });

  it("uses the PAT only when no App is configured anywhere", () => {
    assert.equal(resolveCredentialSource(false, { ...NO_ENV, pat: "ghp_legacy" }), "pat");
  });

  it("reports nothing configured when the environment is empty", () => {
    assert.equal(resolveCredentialSource(false, NO_ENV), "none");
  });

  it("treats a half-configured environment App as absent", () => {
    assert.equal(
      resolveCredentialSource(false, { appId: "12345", privateKey: undefined, pat: "ghp_legacy" }),
      "pat",
    );
  });

  it("treats blank environment values as unset", () => {
    assert.equal(
      resolveCredentialSource(false, { appId: "  ", privateKey: "\n", pat: "  " }),
      "none",
    );
  });
});

describe("canConnectApp", () => {
  // Requirement: a PAT-configured deployment must still be able to migrate.
  it("keeps the offer open on the legacy PAT", () => {
    assert.equal(canConnectApp("pat"), true);
  });

  it("keeps the offer open for a hand-registered App", () => {
    assert.equal(canConnectApp("envApp"), true);
  });

  it("keeps the offer open when nothing is configured", () => {
    assert.equal(canConnectApp("none"), true);
  });

  it("hides the offer once an App is stored", () => {
    assert.equal(canConnectApp("manifest"), false);
  });
});

describe("resolveAppCredentials", () => {
  it("uses stored credentials ahead of the environment", () => {
    const result = resolveAppCredentials({ appId: 999, privateKey: "stored-pem" }, ENV_APP);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.appId, 999);
    assert.equal(result.ok && result.privateKey, "stored-pem");
    assert.equal(result.ok && result.source, "manifest");
  });

  it("falls back to the environment when nothing is stored", () => {
    const result = resolveAppCredentials(null, ENV_APP);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.appId, 12345);
    assert.equal(result.ok && result.source, "envApp");
  });

  it("fails closed with an actionable message when no App is configured", () => {
    const result = resolveAppCredentials(null, { appId: undefined, privateKey: undefined });
    assert.equal(result.ok, false);
    assert.match(
      result.ok === false ? result.error : "",
      /Connect a GitHub App from the dashboard/,
    );
  });

  it("rejects a non-numeric GITHUB_APP_ID", () => {
    const result = resolveAppCredentials(null, { appId: "not-a-number", privateKey: "pem" });
    assert.equal(result.ok, false);
    assert.match(
      result.ok === false ? result.error : "",
      /GITHUB_APP_ID must be a positive integer/,
    );
  });

  it("reports a missing private key separately from a missing app id", () => {
    const result = resolveAppCredentials(null, { appId: "12345", privateKey: undefined });
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.error : "", /GITHUB_APP_PRIVATE_KEY/);
  });

  it("rejects a stored record with an unusable app id", () => {
    const result = resolveAppCredentials({ appId: 0, privateKey: "pem" }, ENV_APP);
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.error : "", /Disconnect and reconnect/);
  });

  it("expands escaped newlines in an environment PEM", () => {
    const result = resolveAppCredentials(null, { appId: "7", privateKey: "line-1\\nline-2" });
    assert.equal(result.ok && result.privateKey, "line-1\nline-2");
  });

  it("leaves a literal multiline PEM untouched", () => {
    assert.equal(normalizePrivateKey("line-1\nline-2"), "line-1\nline-2");
  });
});

describe("evaluateSetupState", () => {
  const now = 1_700_000_000_000;

  it("accepts a fresh unused state", () => {
    assert.equal(evaluateSetupState({ createdAt: now }, now), "valid");
  });

  it("rejects a state it has never seen", () => {
    assert.equal(evaluateSetupState(null, now), "unknown");
  });

  it("rejects a state that was already consumed", () => {
    assert.equal(evaluateSetupState({ createdAt: now, usedAt: now }, now), "consumed");
  });

  it("rejects a state older than the TTL", () => {
    assert.equal(evaluateSetupState({ createdAt: now - SETUP_STATE_TTL_MS - 1 }, now), "expired");
  });

  it("still accepts a state exactly at the TTL boundary", () => {
    assert.equal(evaluateSetupState({ createdAt: now - SETUP_STATE_TTL_MS }, now), "valid");
  });

  it("reports consumed ahead of expired for a used, aged state", () => {
    assert.equal(
      evaluateSetupState({ createdAt: now - SETUP_STATE_TTL_MS - 1, usedAt: now }, now),
      "consumed",
    );
  });

  it("collects every state that is no longer usable", () => {
    assert.equal(isSetupStateCollectable({ createdAt: now }, now), false);
    assert.equal(isSetupStateCollectable({ createdAt: now, usedAt: now }, now), true);
    assert.equal(isSetupStateCollectable({ createdAt: now - SETUP_STATE_TTL_MS - 1 }, now), true);
  });
});

describe("buildManifest", () => {
  const manifest = buildManifest("https://example.convex.site");

  it("requests only the permissions the JIT runner endpoints need", () => {
    assert.deepEqual(manifest.default_permissions, {
      actions: "read",
      administration: "write",
    });
    assert.deepEqual(APP_PERMISSIONS, { actions: "read", administration: "write" });
  });

  it("subscribes to workflow_job only", () => {
    assert.deepEqual([...manifest.default_events], ["workflow_job"]);
    assert.deepEqual([...APP_EVENTS], ["workflow_job"]);
  });

  it("points the webhook and redirect at this deployment", () => {
    assert.equal(manifest.hook_attributes.url, "https://example.convex.site/github/webhook");
    assert.equal(manifest.redirect_url, "https://example.convex.site/github/app/callback");
  });

  it("keeps the app private to its owner", () => {
    assert.equal(manifest.public, false);
  });

  it("targets the personal app form when no organization is given", () => {
    assert.equal(manifestFormAction(undefined), "https://github.com/settings/apps/new");
    assert.equal(manifestFormAction("   "), "https://github.com/settings/apps/new");
  });

  it("targets the organization app form and escapes the login", () => {
    assert.equal(
      manifestFormAction("my org"),
      "https://github.com/organizations/my%20org/settings/apps/new",
    );
  });
});

describe("parseManifestConversion", () => {
  const valid = {
    id: 42,
    slug: "runner-center-abc",
    name: "Runner Center",
    client_id: "Iv1.abc123",
    client_secret: "should-be-ignored",
    pem: "-----BEGIN RSA PRIVATE KEY-----",
    webhook_secret: "whsec",
    html_url: "https://github.com/apps/runner-center-abc",
  };

  it("accepts a well-formed conversion response", () => {
    assert.deepEqual(parseManifestConversion(valid), {
      appId: 42,
      clientId: "Iv1.abc123",
      slug: "runner-center-abc",
      name: "Runner Center",
      privateKey: "-----BEGIN RSA PRIVATE KEY-----",
      webhookSecret: "whsec",
      htmlUrl: "https://github.com/apps/runner-center-abc",
    });
  });

  it("does not carry the client secret through", () => {
    const parsed = parseManifestConversion(valid);
    assert.equal(Object.hasOwn(parsed ?? {}, "clientSecret"), false);
    assert.equal(JSON.stringify(parsed).includes("should-be-ignored"), false);
  });

  it("rejects a response missing the client id", () => {
    assert.equal(parseManifestConversion({ ...valid, client_id: undefined }), null);
  });

  it("rejects a response missing the private key", () => {
    assert.equal(parseManifestConversion({ ...valid, pem: "" }), null);
  });

  it("rejects a response missing the webhook secret", () => {
    assert.equal(parseManifestConversion({ ...valid, webhook_secret: undefined }), null);
  });

  it("rejects a non-positive app id", () => {
    assert.equal(parseManifestConversion({ ...valid, id: 0 }), null);
  });

  it("rejects a non-object payload", () => {
    assert.equal(parseManifestConversion("nope"), null);
    assert.equal(parseManifestConversion(null), null);
  });
});

describe("toAppSummary", () => {
  const stored = {
    appId: 42,
    clientId: "Iv1.abc123",
    slug: "runner-center-abc",
    name: "Runner Center",
    privateKey: "-----BEGIN RSA PRIVATE KEY-----super-secret",
    webhookSecret: "whsec-super-secret",
    htmlUrl: "https://github.com/apps/runner-center-abc",
    createdAt: 1_700_000_000_000,
  };

  it("never exposes the private key or webhook secret", () => {
    const summary = toAppSummary(stored);
    assert.equal(Object.hasOwn(summary, "privateKey"), false);
    assert.equal(Object.hasOwn(summary, "webhookSecret"), false);
    assert.equal(Object.hasOwn(summary, "slug"), false);

    const serialized = JSON.stringify(summary);
    assert.equal(serialized.includes("super-secret"), false);
    assert.equal(serialized.includes("whsec"), false);
  });

  it("derives the installation URL from the slug", () => {
    assert.equal(
      toAppSummary(stored).installUrl,
      "https://github.com/apps/runner-center-abc/installations/new",
    );
  });

  it("keeps the public identifiers the dashboard shows", () => {
    const summary = toAppSummary(stored);
    assert.equal(summary.appId, 42);
    assert.equal(summary.clientId, "Iv1.abc123");
    assert.equal(summary.name, "Runner Center");
  });
});
