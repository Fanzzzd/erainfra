// The client subscribes over `.convex.cloud`, but HTTP actions, such as the
// install script and the operator API, are served from `.convex.site` on the
// same deployment.
export function convexSiteUrl() {
  return String(import.meta.env.VITE_CONVEX_URL).replace(/\.convex\.cloud\/?$/, ".convex.site");
}

/** The deployment's name, such as `happy-otter-123`, from its `.convex.cloud` URL. */
export function convexDeploymentName() {
  const host = URL.canParse(String(import.meta.env.VITE_CONVEX_URL))
    ? new URL(String(import.meta.env.VITE_CONVEX_URL)).hostname
    : "";
  return host.split(".")[0] || "EraInfra";
}
