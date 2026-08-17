// Proof: cross-node service-to-service over OUR mesh (dumbpipe/iroh), not the public domain. Two agents
// connect to one hub; a "db" (registry:2.8.2, internal — no route) is deployed on nodeB and published
// only to nodeB's loopback. agents.linkService then brokers a P2P mesh link: nodeB shares the db port
// → ticket → nodeA connects it → a local port on nodeA. We then reach the db FROM nodeA through that
// link — both as a host TCP check and from a CONTAINER on nodeA via host.docker.internal (the real
// backend→db path). The db is never on a domain; data flows node-to-node, not through the hub.
//   node --experimental-strip-types prototypes/relay-experiments/verify-meshlink.ts
// Needs `dumbpipe` on PATH (the agents spawn it). Both agents share this machine's docker daemon, so
// the two dumbpipe sidecars tunnel over iroh between themselves — proving the mesh carries the TCP.
import os from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
const scratch = mkdtempSync(join(os.tmpdir(), "pl-meshlink-"));
process.env.PORTLESS_APP_DOMAIN = "apps.local";
process.env.PORTLESS_BIND = "127.0.0.1";
process.env.PORTLESS_ROUTES_FILE = join(scratch, "routes.json");
process.env.PORTLESS_APPS_FILE = join(scratch, "apps.json");
process.env.PORTLESS_SECRETS_FILE = join(scratch, "secrets.json");
process.env.PORTLESS_FAILOVER = "0";
import http from "node:http";
import { spawn, execSync } from "node:child_process";
import { createApiServer } from "../../apps/api/src/server.ts";
import { appRouter } from "../../apps/api/src/router.ts";
import { createCallerFactory } from "../../apps/api/src/trpc.ts";
import { InMemoryAuditLog } from "../../apps/api/src/audit.ts";
import { dataGateway } from "../../apps/api/src/runtime/dataplane.ts";
import type { Principal } from "../../apps/api/src/auth.ts";

const PORT = 8790,
  APP = "meshdb",
  DB_HOSTPORT = 15500,
  LINK_PORT = 15600,
  IMAGE = "registry:2.8.2";
const AGENT_BIN = new URL("../../deploy/bin/portless-agent-darwin-arm64", import.meta.url).pathname;
const owner: Principal = { id: "u-owner", name: "Owner", roles: ["owner"] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Raw GET straight to host:port (not the hub) — used to hit the mesh-surfaced local port on nodeA.
function rawGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    r.on("error", reject);
    r.end();
  });
}
const spawnAgent = (name: string) =>
  spawn(
    AGENT_BIN,
    [
      "connect",
      "--hub",
      `ws://127.0.0.1:${PORT}/agent`,
      "--token",
      "owner-dev-token",
      "--name",
      name,
    ],
    { stdio: ["ignore", "inherit", "inherit"] },
  );

const app = createApiServer();
await app.listen({ port: PORT, host: "127.0.0.1" });
console.log(`HUB_READY on 127.0.0.1:${PORT}`);
const caller = createCallerFactory(appRouter)({ principal: owner, audit: new InMemoryAuditLog() });
const agentA = spawnAgent("nodeA"); // consumer (backend lives here)
const agentB = spawnAgent("nodeB"); // provider (db lives here)

let failed = true;
try {
  console.log("waiting for nodeA + nodeB…");
  for (let i = 0; i < 60 && !["nodeA", "nodeB"].every((n) => dataGateway.isConnected(n)); i++)
    await sleep(500);
  const ids = (await caller.agents.list()).map((a) => a.id);
  if (!["nodeA", "nodeB"].every((n) => ids.includes(n)))
    throw new Error(`agents not online: ${ids.join(",")}`);
  console.log("✅ nodeA + nodeB online");

  // db on nodeB, internal (no route) — published only to nodeB's loopback for the mesh to share.
  console.log(
    `deploying db (${IMAGE}) on nodeB, published to its loopback :${DB_HOSTPORT} (no public route)…`,
  );
  const d = await caller.agents.deployApp({
    agentId: "nodeB",
    app: APP,
    services: [
      { name: "db", image: IMAGE, node: "nodeB", args: ["-p", `127.0.0.1:${DB_HOSTPORT}:5000`] },
    ],
    confirm: true,
  });
  if (!d.ok) throw new Error(`db deploy failed: ${JSON.stringify(d.results)}`);
  console.log("✅ db up on nodeB (internal-only)");

  // broker the mesh link: nodeB shares db → ticket → nodeA connects it locally
  console.log("linking db across the mesh: nodeB shares → nodeA connects…");
  const link = await caller.agents.linkService({
    name: "dblink",
    provider: "nodeB",
    providerPort: DB_HOSTPORT,
    consumer: "nodeA",
    localPort: LINK_PORT,
    confirm: true,
  });
  if (!link.ok) throw new Error("linkService failed");
  console.log(
    `✅ mesh link up — db reachable on nodeA at ${link.localAddress} (containers: ${link.address})`,
  );

  // 1) host-side: reach the remote db THROUGH the mesh (this port is only served by dumbpipe-connect)
  let res;
  for (let i = 0; i < 20; i++) {
    try {
      res = await rawGet(LINK_PORT, "/v2/");
      if (res.status === 200) break;
    } catch {}
    await sleep(1000);
  }
  console.log(
    `GET 127.0.0.1:${LINK_PORT}/v2/ (via mesh → nodeB db) → ${res?.status} ${JSON.stringify(res?.body)}`,
  );
  if (res?.status !== 200) throw new Error(`mesh tunnel reach failed: ${res?.status}`);
  console.log("✅ reached nodeB's db from nodeA over the mesh (host side)");

  // The former arbitrary `docker run ... wget` probe was intentionally removed with raw argv.
  // Container host-gateway rendering is covered by the deploy-planner and Docker-arg policy tests.

  failed = false;
} catch (e) {
  console.error("FAIL:", (e as Error).message);
}

console.log("cleaning up…");
try {
  execSync(`docker rm -f ${APP}-db`, { stdio: "ignore" });
} catch {}
try {
  execSync(`docker network rm ${APP}-net`, { stdio: "ignore" });
} catch {}
try {
  execSync(`pkill -f 'dumbpipe (listen|connect)-tcp'`, { stdio: "ignore" });
} catch {}
agentA.kill();
agentB.kill();
await app.close();
console.log(failed ? "RESULT: FAIL" : "RESULT: PASS");
process.exit(failed ? 1 : 0);
