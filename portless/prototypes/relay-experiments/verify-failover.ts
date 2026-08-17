// Verify stateless auto-failover end to end: deploy an app to nodeA, kill nodeA's agent, and watch the
// hub redeploy the app onto nodeB and flip the route so traffic keeps flowing — through the data plane,
// no manual step. Two agents share this one Docker daemon (real multi-daemon isn't available here), so
// the control flow, redeploy, route flip, and traffic-follows-route are all genuinely exercised.
// Run: node --experimental-strip-types prototypes/relay-experiments/verify-failover.ts
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
process.env.PORTLESS_HUB_BASE = "http://127.0.0.1:8797";
process.env.PORTLESS_REGISTRY = "127.0.0.1:5005";
process.env.PORTLESS_APP_DOMAIN = "apps.local";
import { createApiServer } from "../../apps/api/src/server.ts";
import { appRouter } from "../../apps/api/src/router.ts";
import { createCallerFactory } from "../../apps/api/src/trpc.ts";
import { InMemoryAuditLog } from "../../apps/api/src/audit.ts";
import { agentGateway } from "../../apps/api/src/runtime/agents.ts";
import { dataGateway } from "../../apps/api/src/runtime/dataplane.ts";
import { routeStore } from "../../apps/api/src/runtime/routes.ts";
import { secretStore } from "../../apps/api/src/runtime/secrets.ts";
import { installFailover } from "../../apps/api/src/runtime/failover.ts";
import type { Principal } from "../../apps/api/src/auth.ts";

const PORT = 8797,
  APP = "failover-app",
  APP_PORT = 8095,
  GRACE = 1500;
const owner: Principal = { id: "u-owner", name: "Owner", roles: ["owner"] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cleanup = () => {
  try {
    execSync(`docker rm -f ${APP}`, { stdio: "ignore" });
  } catch {
    /* gone */
  }
};

const src = mkdtempSync(join(tmpdir(), "fo-"));
writeFileSync(
  join(src, "package.json"),
  JSON.stringify({ name: APP, version: "1.0.0", scripts: { start: "node index.js" } }),
);
writeFileSync(
  join(src, "index.js"),
  "const http=require('http');const p=process.env.PORT||3000;http.createServer((_,r)=>r.end('alive')).listen(p);",
);
const tgz = join(tmpdir(), "fo-src.tgz");
execSync(`tar -czf ${tgz} -C ${src} .`);

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
const spawnAgent = (name: string): ChildProcess =>
  spawn(
    "deploy/bin/portless-agent-darwin-arm64",
    [
      "connect",
      "--hub",
      `ws://127.0.0.1:${PORT}/agent`,
      "--token",
      "owner-dev-token",
      "--name",
      name,
    ],
    { stdio: ["ignore", "ignore", "ignore"] },
  );

cleanup();
const app = createApiServer();
await app.listen({ port: PORT, host: "127.0.0.1" });
installFailover(
  {
    gateway: agentGateway,
    routes: routeStore,
    secrets: secretStore,
    log: (m) => console.log(`  [failover] ${m}`),
  },
  GRACE,
);
let nodeA = spawnAgent("nodeA");
const nodeB = spawnAgent("nodeB");
const caller = createCallerFactory(appRouter)({ principal: owner, audit: new InMemoryAuditLog() });

let failed = true;
try {
  for (const r of routeStore.list()) routeStore.delete(r.app); // drop stale routes persisted by earlier verify runs
  for (let i = 0; i < 40 && !["nodeA", "nodeB"].every((n) => dataGateway.isConnected(n)); i++)
    await sleep(250);
  if (!["nodeA", "nodeB"].every((n) => dataGateway.isConnected(n)))
    throw new Error("both nodes never connected");
  console.log("✅ nodeA + nodeB connected (control + data)");

  const up = await app.inject({
    method: "POST",
    url: "/upload",
    headers: { authorization: "Bearer owner-dev-token", "content-type": "application/gzip" },
    payload: execSync(`cat ${tgz}`),
  });
  const r = await caller.upload.deploy({
    buildId: up.json().buildId,
    name: APP,
    port: APP_PORT,
    buildNode: "nodeA",
    deployNode: "nodeA",
    confirm: true,
  });
  if (!r.ok) throw new Error(`${r.stage} failed: ${r.error}`);
  if (routeStore.node(APP) !== "nodeA") throw new Error("route not on nodeA after deploy");
  let res;
  for (let i = 0; i < 30; i++) {
    res = await get(`${APP}.apps.local`, "/");
    if (res.status === 200) break;
    await sleep(500);
  }
  if (res?.body !== "alive") throw new Error("app not serving on nodeA: " + JSON.stringify(res));
  console.log("✅ deployed to nodeA, serving via the data plane (route → nodeA)");

  // KILL nodeA. The hub should notice, wait out the grace window, and redeploy onto nodeB.
  console.log("— killing nodeA —");
  nodeA.kill("SIGKILL");
  for (let i = 0; i < 40 && routeStore.node(APP) !== "nodeB"; i++) await sleep(500);
  if (routeStore.node(APP) !== "nodeB")
    throw new Error("route did not fail over to nodeB (still " + routeStore.node(APP) + ")");
  console.log("✅ auto-failover flipped the route nodeA → nodeB");

  // Traffic must follow the route with no manual step.
  let after;
  for (let i = 0; i < 30; i++) {
    after = await get(`${APP}.apps.local`, "/");
    if (after.status === 200) break;
    await sleep(500);
  }
  if (after?.body !== "alive")
    throw new Error("app not serving after failover: " + JSON.stringify(after));
  console.log(
    "✅ traffic follows: <app>.apps.local still 200 after the node died (served via nodeB)",
  );
  failed = false;
} catch (e) {
  console.error("FAIL:", (e as Error).message);
}
cleanup();
nodeA.kill("SIGKILL");
nodeB.kill("SIGKILL");
await app.close();
process.exit(failed ? 1 : 0);
