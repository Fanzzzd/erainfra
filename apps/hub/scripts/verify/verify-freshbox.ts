// First-run proof: a BLANK Linux box (no docker, no agent) is turned into a working portless deploy
// node by ONE command — `curl -fsSL <hub>/agent.sh | sh`. The hub runs here (in-process) bound to all
// interfaces; the "blank box" is a privileged ubuntu container that reaches the hub via
// host.docker.internal. This script: starts the hub, waits for the box's agent to dial in (proving
// the one command installed docker + agent + connected), then deploys a container to it through
// portless and reaches it over the data plane. The caller (run-freshbox.sh) creates the box and runs
// the one command while this waits. Cleanup of the deployed container is done here; the box itself by
// the caller. Run: node --experimental-strip-types apps/hub/scripts/verify/verify-freshbox.ts
process.env.PORTLESS_APP_DOMAIN = "apps.local";
process.env.PORTLESS_BIND = "0.0.0.0";
import http from "node:http";
import { execSync } from "node:child_process";
import { createApiServer } from "../../src/server.ts";
import { appRouter } from "../../src/router.ts";
import { createCallerFactory } from "../../src/trpc.ts";
import { InMemoryAuditLog } from "../../src/audit.ts";
import { dataGateway } from "../../src/runtime/dataplane.ts";
import type { Principal } from "../../src/auth.ts";

const PORT = 8787,
  BOX = "pl-freshbox",
  AGENT = "freshbox",
  APP = "registry-demo",
  HOST_PORT = 18056,
  IMAGE = "registry:2";
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
await app.listen({ port: PORT, host: "0.0.0.0" });
console.log(`HUB_READY on 0.0.0.0:${PORT} (box reaches it at host.docker.internal:${PORT})`);
const caller = createCallerFactory(appRouter)({ principal: owner, audit: new InMemoryAuditLog() });

let failed = true;
try {
  console.log(
    "waiting for the fresh box to enroll itself (one command installs docker + agent + dials in)…",
  );
  for (let i = 0; i < 240 && !(await caller.agents.list()).some((a) => a.id === AGENT); i++)
    await sleep(500);
  if (!(await caller.agents.list()).some((a) => a.id === AGENT))
    throw new Error(`${AGENT} never connected (control) — the one command did not finish`);
  for (let i = 0; i < 60 && !dataGateway.isConnected(AGENT); i++) await sleep(500);
  if (!dataGateway.isConnected(AGENT)) throw new Error(`${AGENT} data channel never connected`);
  console.log(
    `✅ the fresh box enrolled itself: agent "${AGENT}" online (control + data) — docker + agent came up from one command`,
  );

  // Put an image into the box's freshly-installed docker WITHOUT a Docker Hub pull (save→load locally).
  console.log(`loading ${IMAGE} into the box (local save→load, no registry pull)…`);
  execSync(`docker save ${IMAGE} | docker exec -i ${BOX} docker load`, { stdio: "inherit" });

  const r = await caller.agents.deploy({
    agentId: AGENT,
    image: IMAGE,
    name: APP,
    args: ["-p", `${HOST_PORT}:5000`],
    port: HOST_PORT,
    confirm: true,
  });
  if (!r.ok) throw new Error(`deploy failed: err=${r.error} | output=${r.output}`);
  console.log(`✅ portless deployed "${APP}" on the fresh box (route → ${AGENT})`);

  let res;
  for (let i = 0; i < 30; i++) {
    res = await get(`${APP}.apps.local`, "/v2/");
    if (res.status === 200) break;
    await sleep(1000);
  }
  console.log(`GET ${APP}.apps.local/v2/ → ${res?.status} ${JSON.stringify(res?.body)}`);
  if (res?.status !== 200) throw new Error(`data-plane reach failed: ${res?.status}`);
  console.log(
    "✅ reached the app on the fresh box over the data plane — first-run is fully working",
  );
  failed = false;
} catch (e) {
  console.error("FAIL:", (e as Error).message);
}

try {
  await caller.agents.run({
    agentId: AGENT,
    operation: { name: "container.remove", args: { name: APP } },
    confirm: true,
  });
  console.log("cleaned up: deployed container removed");
} catch (e) {
  console.error("cleanup note:", (e as Error).message);
}
await app.close();
process.exit(failed ? 1 : 0);
