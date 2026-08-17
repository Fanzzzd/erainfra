// Real-infra proof: deploy a container to the HK work-remote (Linux, NAT'd behind its LAN) THROUGH
// portless, and reach it over the data plane across the WAN from this Mac. The hub runs here; the
// work-remote agent reaches it via a reverse SSH tunnel (started by the caller). Isolated container
// (unique name + unused port), cleaned up at the end — nothing of theirs is touched.
// Run: node --experimental-strip-types apps/hub/scripts/verify/deploy-workremote.ts
process.env.PORTLESS_APP_DOMAIN = "apps.local";
import http from "node:http";
import { createApiServer } from "../../src/server.ts";
import { appRouter } from "../../src/router.ts";
import { createCallerFactory } from "../../src/trpc.ts";
import { InMemoryAuditLog } from "../../src/audit.ts";
import { dataGateway } from "../../src/runtime/dataplane.ts";
import type { Principal } from "../../src/auth.ts";

const PORT = 8787,
  APP = "pl-demo",
  HOST_PORT = 18055; // registry:2 serves /v2/ on container 5000
const owner: Principal = { id: "u-owner", name: "Owner", roles: ["owner"] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function get(host: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: "127.0.0.1", port: PORT, path, method: "GET", headers: { host } },
      (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
      },
    );
    r.on("error", reject);
    r.end();
  });
}

const app = createApiServer();
await app.listen({ port: PORT, host: "127.0.0.1" });
console.log(`hub listening on 127.0.0.1:${PORT} (reverse-tunneled to work-remote:18787)`);
const caller = createCallerFactory(appRouter)({ principal: owner, audit: new InMemoryAuditLog() });

let failed = true;
try {
  console.log("waiting for the work-remote agent to dial in over the tunnel…");
  for (let i = 0; i < 120 && !(await caller.agents.list()).some((a) => a.id === "wr-node"); i++)
    await sleep(500);
  if (!(await caller.agents.list()).some((a) => a.id === "wr-node"))
    throw new Error("wr-node never connected (control)");
  for (let i = 0; i < 40 && !dataGateway.isConnected("wr-node"); i++) await sleep(500);
  if (!dataGateway.isConnected("wr-node")) throw new Error("wr-node data channel never connected");
  console.log("✅ work-remote agent connected over the WAN (control + data)");

  // Deploy a registry:2 container (image already on the box — no Docker Hub download) on an unused port.
  const r = await caller.agents.deploy({
    agentId: "wr-node",
    image: "registry:2.8.2",
    name: APP,
    args: ["-p", `${HOST_PORT}:5000`],
    port: HOST_PORT,
    confirm: true,
  });
  if (!r.ok) throw new Error(`deploy failed: ${r.error ?? r.output}`);
  console.log(`✅ portless deployed "${APP}" on work-remote (route → wr-node)`);

  // Reach it from this Mac over the data plane (hub proxy → data WS → tunnel → work-remote → container).
  let res;
  for (let i = 0; i < 30; i++) {
    res = await get(`${APP}.apps.local`, "/v2/");
    if (res.status === 200) break;
    await sleep(1000);
  }
  console.log(`GET ${APP}.apps.local/v2/ → ${res?.status} ${JSON.stringify(res?.body)}`);
  if (res?.status !== 200) throw new Error(`data-plane reach failed: ${res?.status}`);
  console.log("✅ reached the HK container from this Mac over the data plane (WAN round-trip)");
  failed = false;
} catch (e) {
  console.error("FAIL:", (e as Error).message);
}

// Cleanup: stop the demo container on work-remote via the agent, then forget the route.
try {
  await caller.agents.run({
    agentId: "wr-node",
    operation: { name: "container.remove", args: { name: APP } },
    confirm: true,
  });
  console.log("cleaned up: pl-demo container removed on work-remote");
} catch (e) {
  console.error("cleanup note:", (e as Error).message);
}
await app.close();
process.exit(failed ? 1 : 0);
