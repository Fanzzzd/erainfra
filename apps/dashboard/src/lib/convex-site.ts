// The client subscribes over `.convex.cloud`, but HTTP actions, such as the
// install script and the operator API, are served from `.convex.site` on the
// same deployment.
export function convexSiteUrl() {
  return String(import.meta.env.VITE_CONVEX_URL).replace(/\.convex\.cloud\/?$/, ".convex.site");
}
