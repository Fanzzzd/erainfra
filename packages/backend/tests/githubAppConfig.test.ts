import { describe, expect, it } from "vitest";
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
  resolveSiteUrl,
  SETUP_STATE_TTL_MS,
  toAppSummary,
} from "../convex/githubAppConfig.ts";

const NO_ENV = { appId: undefined, privateKey: undefined, pat: undefined };
const ENV_APP = { appId: "12345", privateKey: "-----BEGIN RSA PRIVATE KEY-----" };

describe("resolveCredentialSource", () => {
  it("prefers a stored App over a legacy PAT", () => {
    expect(resolveCredentialSource(true, { ...NO_ENV, pat: "ghp_legacy" })).toBe("manifest");
  });

  it("prefers a stored App over hand-registered environment credentials", () => {
    expect(resolveCredentialSource(true, { ...ENV_APP, pat: "ghp_legacy" })).toBe("manifest");
  });

  it("falls back to a hand-registered App before the PAT", () => {
    expect(resolveCredentialSource(false, { ...ENV_APP, pat: "ghp_legacy" })).toBe("envApp");
  });

  it("uses the PAT only when no App is configured anywhere", () => {
    expect(resolveCredentialSource(false, { ...NO_ENV, pat: "ghp_legacy" })).toBe("pat");
  });

  it("reports nothing configured when the environment is empty", () => {
    expect(resolveCredentialSource(false, NO_ENV)).toBe("none");
  });

  it("treats a half-configured environment App as absent", () => {
    expect(
      resolveCredentialSource(false, { appId: "12345", privateKey: undefined, pat: "ghp_legacy" }),
    ).toBe("pat");
  });

  it("treats blank environment values as unset", () => {
    expect(resolveCredentialSource(false, { appId: "  ", privateKey: "\n", pat: "  " })).toBe(
      "none",
    );
  });
});

describe("canConnectApp", () => {
  // Requirement: a PAT-configured deployment must still be able to migrate.
  it("keeps the offer open on the legacy PAT", () => {
    expect(canConnectApp("pat")).toBe(true);
  });

  it("keeps the offer open for a hand-registered App", () => {
    expect(canConnectApp("envApp")).toBe(true);
  });

  it("keeps the offer open when nothing is configured", () => {
    expect(canConnectApp("none")).toBe(true);
  });

  it("hides the offer once an App is stored", () => {
    expect(canConnectApp("manifest")).toBe(false);
  });
});

describe("resolveAppCredentials", () => {
  it("uses stored credentials ahead of the environment", () => {
    const result = resolveAppCredentials({ appId: 999, privateKey: "stored-pem" }, ENV_APP);
    expect(result.ok).toBe(true);
    expect(result.ok && result.appId).toBe(999);
    expect(result.ok && result.privateKey).toBe("stored-pem");
    expect(result.ok && result.source).toBe("manifest");
  });

  it("falls back to the environment when nothing is stored", () => {
    const result = resolveAppCredentials(null, ENV_APP);
    expect(result.ok).toBe(true);
    expect(result.ok && result.appId).toBe(12345);
    expect(result.ok && result.source).toBe("envApp");
  });

  it("fails closed with an actionable message when no App is configured", () => {
    const result = resolveAppCredentials(null, { appId: undefined, privateKey: undefined });
    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.error : "").toMatch(
      /Connect a GitHub App from the dashboard/,
    );
  });

  it("rejects a non-numeric GITHUB_APP_ID", () => {
    const result = resolveAppCredentials(null, { appId: "not-a-number", privateKey: "pem" });
    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.error : "").toMatch(
      /GITHUB_APP_ID must be a positive integer/,
    );
  });

  it("reports a missing private key separately from a missing app id", () => {
    const result = resolveAppCredentials(null, { appId: "12345", privateKey: undefined });
    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.error : "").toMatch(/GITHUB_APP_PRIVATE_KEY/);
  });

  it("rejects a stored record with an unusable app id", () => {
    const result = resolveAppCredentials({ appId: 0, privateKey: "pem" }, ENV_APP);
    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.error : "").toMatch(/Disconnect and reconnect/);
  });

  it("expands escaped newlines in an environment PEM", () => {
    const result = resolveAppCredentials(null, { appId: "7", privateKey: "line-1\\nline-2" });
    expect(result.ok && result.privateKey).toBe("line-1\nline-2");
  });

  it("leaves a literal multiline PEM untouched", () => {
    expect(normalizePrivateKey("line-1\nline-2")).toBe("line-1\nline-2");
  });
});

describe("evaluateSetupState", () => {
  const now = 1_700_000_000_000;

  it("accepts a fresh unused state", () => {
    expect(evaluateSetupState({ createdAt: now }, now)).toBe("valid");
  });

  it("rejects a state it has never seen", () => {
    expect(evaluateSetupState(null, now)).toBe("unknown");
  });

  it("rejects a state that was already consumed", () => {
    expect(evaluateSetupState({ createdAt: now, usedAt: now }, now)).toBe("consumed");
  });

  it("rejects a state older than the TTL", () => {
    expect(evaluateSetupState({ createdAt: now - SETUP_STATE_TTL_MS - 1 }, now)).toBe("expired");
  });

  it("still accepts a state exactly at the TTL boundary", () => {
    expect(evaluateSetupState({ createdAt: now - SETUP_STATE_TTL_MS }, now)).toBe("valid");
  });

  it("reports consumed ahead of expired for a used, aged state", () => {
    expect(evaluateSetupState({ createdAt: now - SETUP_STATE_TTL_MS - 1, usedAt: now }, now)).toBe(
      "consumed",
    );
  });

  it("collects every state that is no longer usable", () => {
    expect(isSetupStateCollectable({ createdAt: now }, now)).toBe(false);
    expect(isSetupStateCollectable({ createdAt: now, usedAt: now }, now)).toBe(true);
    expect(isSetupStateCollectable({ createdAt: now - SETUP_STATE_TTL_MS - 1 }, now)).toBe(true);
  });
});

describe("resolveSiteUrl", () => {
  it("accepts an https deployment origin", () => {
    const result = resolveSiteUrl("https://example.convex.site");
    expect(result.ok).toBe(true);
    expect(result.ok && result.siteUrl).toBe("https://example.convex.site");
  });

  it("normalizes away a trailing slash so callers can concatenate", () => {
    const result = resolveSiteUrl("https://example.convex.site/");
    expect(result.ok && result.siteUrl).toBe("https://example.convex.site");
  });

  it("drops any path, query, and fragment", () => {
    const result = resolveSiteUrl("https://example.convex.site/nested?a=1#b");
    expect(result.ok && result.siteUrl).toBe("https://example.convex.site");
  });

  it("keeps an explicit port", () => {
    const result = resolveSiteUrl("https://example.convex.site:8443");
    expect(result.ok && result.siteUrl).toBe("https://example.convex.site:8443");
  });

  it("trims surrounding whitespace", () => {
    const result = resolveSiteUrl("  https://example.convex.site  ");
    expect(result.ok && result.siteUrl).toBe("https://example.convex.site");
  });

  it("fails closed when unset", () => {
    expect(resolveSiteUrl(undefined).ok).toBe(false);
  });

  it("fails closed when blank", () => {
    expect(resolveSiteUrl("   ").ok).toBe(false);
  });

  it("rejects a value that is not an absolute URL", () => {
    expect(resolveSiteUrl("example.convex.site").ok).toBe(false);
    expect(resolveSiteUrl("/github/app/callback").ok).toBe(false);
  });

  it("rejects plaintext http for a non-loopback host", () => {
    const result = resolveSiteUrl("http://example.convex.site");
    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.error : "").toMatch(/https/);
  });

  // Narrow dev affordance: `convex dev --local` serves http on loopback.
  it("allows http on loopback hosts only", () => {
    expect(resolveSiteUrl("http://localhost:3210").ok).toBe(true);
    expect(resolveSiteUrl("http://127.0.0.1:3210").ok).toBe(true);
    expect(resolveSiteUrl("http://[::1]:3210").ok).toBe(true);
  });

  it("does not treat a lookalike hostname as loopback", () => {
    expect(resolveSiteUrl("http://localhost.evil.example").ok).toBe(false);
    expect(resolveSiteUrl("http://notlocalhost").ok).toBe(false);
  });

  it("rejects embedded credentials", () => {
    const result = resolveSiteUrl("https://user:pass@example.convex.site");
    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.error : "").toMatch(/credentials/);
  });

  it("rejects a non-http scheme", () => {
    expect(resolveSiteUrl("ftp://example.convex.site").ok).toBe(false);
    expect(resolveSiteUrl("javascript:alert(1)").ok).toBe(false);
  });

  it("never echoes the configured value in the error", () => {
    for (const bad of [
      "http://attacker.example",
      "https://user:pass@example.convex.site",
      "ftp://example.convex.site",
      "not-a-url",
    ]) {
      const result = resolveSiteUrl(bad);
      expect(result.ok).toBe(false);
      const error = result.ok === false ? result.error : "";
      expect(error.includes(bad)).toBe(false);
      expect(error.includes("attacker")).toBe(false);
      expect(error.includes("pass")).toBe(false);
    }
  });
});

describe("buildManifest", () => {
  const manifest = buildManifest("https://example.convex.site");

  it("requests only the permissions the JIT runner endpoints need", () => {
    expect(manifest.default_permissions).toEqual({
      actions: "read",
      administration: "write",
    });
    expect(APP_PERMISSIONS).toEqual({ actions: "read", administration: "write" });
  });

  it("subscribes to workflow_job only", () => {
    expect([...manifest.default_events]).toEqual(["workflow_job"]);
    expect([...APP_EVENTS]).toEqual(["workflow_job"]);
  });

  it("points the webhook and redirect at this deployment", () => {
    expect(manifest.hook_attributes.url).toBe("https://example.convex.site/github/webhook");
    expect(manifest.redirect_url).toBe("https://example.convex.site/github/app/callback");
  });

  it("keeps the app private to its owner", () => {
    expect(manifest.public).toBe(false);
  });

  it("targets the personal app form when no organization is given", () => {
    expect(manifestFormAction(undefined)).toBe("https://github.com/settings/apps/new");
    expect(manifestFormAction("   ")).toBe("https://github.com/settings/apps/new");
  });

  it("targets the organization app form and escapes the login", () => {
    expect(manifestFormAction("my org")).toBe(
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
    expect(parseManifestConversion(valid)).toEqual({
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
    expect(Object.hasOwn(parsed ?? {}, "clientSecret")).toBe(false);
    expect(JSON.stringify(parsed).includes("should-be-ignored")).toBe(false);
  });

  it("rejects a response missing the client id", () => {
    expect(parseManifestConversion({ ...valid, client_id: undefined })).toBe(null);
  });

  it("rejects a response missing the private key", () => {
    expect(parseManifestConversion({ ...valid, pem: "" })).toBe(null);
  });

  it("rejects a response missing the webhook secret", () => {
    expect(parseManifestConversion({ ...valid, webhook_secret: undefined })).toBe(null);
  });

  it("rejects a non-positive app id", () => {
    expect(parseManifestConversion({ ...valid, id: 0 })).toBe(null);
  });

  it("rejects a non-object payload", () => {
    expect(parseManifestConversion("nope")).toBe(null);
    expect(parseManifestConversion(null)).toBe(null);
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
    expect(Object.hasOwn(summary, "privateKey")).toBe(false);
    expect(Object.hasOwn(summary, "webhookSecret")).toBe(false);
    expect(Object.hasOwn(summary, "slug")).toBe(false);

    const serialized = JSON.stringify(summary);
    expect(serialized.includes("super-secret")).toBe(false);
    expect(serialized.includes("whsec")).toBe(false);
  });

  it("derives the installation URL from the slug", () => {
    expect(toAppSummary(stored).installUrl).toBe(
      "https://github.com/apps/runner-center-abc/installations/new",
    );
  });

  it("keeps the public identifiers the dashboard shows", () => {
    const summary = toAppSummary(stored);
    expect(summary.appId).toBe(42);
    expect(summary.clientId).toBe("Iv1.abc123");
    expect(summary.name).toBe("Runner Center");
  });
});
