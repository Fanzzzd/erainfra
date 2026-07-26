import staticHosting from "@convex-dev/static-hosting/convex.config.js";
import { defineApp } from "convex/server";

// App-owned root routing: our exact routes (auth discovery, webhook, runs-on)
// win over the static catch-all. See @convex-dev/static-hosting README.
const app = defineApp();
app.use(staticHosting);

export default app;
