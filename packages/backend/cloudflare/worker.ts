// The control plane's entry on the Cloudflare platform (ADR 0019). The same backend modules
// Convex runs, served by one Durable Object.
import { createControlPlane } from "@erainfra/platform/cloudflare";

import authConfig from "../convex/auth.config.ts";
import schema from "../convex/schema.ts";
import { modules } from "./modules.generated.ts";

const { ControlPlane, worker } = createControlPlane({
  modules,
  schema,
  auth: authConfig as { providers: { domain: string; applicationID: string }[] },
});

export { ControlPlane };
export default worker;
