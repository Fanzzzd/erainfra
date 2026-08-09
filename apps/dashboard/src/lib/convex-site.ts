// The client subscribes over `.convex.cloud`, but HTTP actions — the install
// script, the GitHub webhook, and the GitHub App Manifest flow — are served
// from `.convex.site` on the same deployment.
export function convexSiteUrl() {
  return String(import.meta.env.VITE_CONVEX_URL).replace(/\.convex\.cloud\/?$/, ".convex.site");
}
