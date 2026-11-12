import { describe, expect, it } from "vitest";

import { resolveSiteUrl } from "../convex/siteUrl.ts";

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
    expect(resolveSiteUrl("/install").ok).toBe(false);
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
