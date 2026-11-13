// The deployment's canonical origin, the base of every URL it publishes.
//
// Free of Convex imports so the unit tests can import it directly. A total function of its
// argument: no clock reads, no environment reads, no database.

export type SiteUrlResult = { ok: true; siteUrl: string } | { ok: false; error: string };

// Loopback hosts, the only place a plaintext origin is accepted. `convex dev
// --local` serves over http on 127.0.0.1, and nothing there crosses a network.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Resolve the deployment's canonical origin from its own configuration.
 *
 * This must never be derived from `request.url` or the `Host` header. Both are
 * client-controlled, and every URL built from this value is a security
 * decision: the installers bake it into a Worker's configuration as the place
 * the Worker sends its machine token. A request reaching an installer through
 * an attacker-chosen hostname could otherwise enroll a Worker that reports to
 * that host.
 *
 * Fails closed. The error never echoes the configured value.
 */
export function resolveSiteUrl(rawSiteUrl: string | undefined): SiteUrlResult {
  if (rawSiteUrl === undefined || rawSiteUrl.trim().length === 0) {
    return {
      ok: false,
      error: "CONVEX_SITE_URL is not set on this deployment",
    };
  }

  let url: URL;
  try {
    url = new URL(rawSiteUrl.trim());
  } catch {
    return { ok: false, error: "CONVEX_SITE_URL is not a valid absolute URL" };
  }

  if (url.username.length > 0 || url.password.length > 0) {
    return { ok: false, error: "CONVEX_SITE_URL must not embed credentials" };
  }

  const isLoopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol === "http:" && !isLoopback) {
    return {
      ok: false,
      error: "CONVEX_SITE_URL must use https outside of a loopback address",
    };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, error: "CONVEX_SITE_URL must use the https scheme" };
  }

  // `origin` drops any path, query, fragment, and trailing slash, so callers
  // can concatenate without producing a double slash.
  return { ok: true, siteUrl: url.origin };
}
