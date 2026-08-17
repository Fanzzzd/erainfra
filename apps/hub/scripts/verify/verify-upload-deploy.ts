// Verify drag-drop / upload deploy end to end (the non-git half of the Vercel flow): tar a local app,
// POST it to /upload, then upload.deploy → the build node fetches the tarball back from the hub (with
// its own token), builds it with nixpacks, pushes, deploys, and the container serves HTTP.
// Needs Docker + a registry on :5005. Run:
//   node --experimental-strip-types apps/hub/scripts/verify/verify-upload-deploy.ts
import { spawn, execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.PORTLESS_HUB_BASE = "http://127.0.0.1:8795";
process.env.PORTLESS_REGISTRY = "127.0.0.1:5005";
import { createApiServer } from "../../src/server.ts";
import { appRouter } from "../../src/router.ts";
import { createCallerFactory } from "../../src/trpc.ts";
import { InMemoryAuditLog } from "../../src/audit.ts";
import type { Principal } from "../../src/auth.ts";
import { deployed } from "./_wait-for-deploy.ts";

const PORT = 8795,
  APP = "upload-app",
  APP_PORT = 8091;
const owner: Principal = { id: "u-owner", name: "Owner", roles: ["owner"] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cleanup = () => {
  try {
    execSync(`docker rm -f ${APP}`, { stdio: "ignore" });
  } catch {
    /* gone */
  }
};

// build a tarball of a tiny no-Dockerfile node app (nixpacks path)
const src = mkdtempSync(join(tmpdir(), "src-"));
writeFileSync(
  join(src, "package.json"),
  JSON.stringify({ name: "upload-app", version: "1.0.0", scripts: { start: "node index.js" } }),
);
writeFileSync(
  join(src, "index.js"),
  "const http=require('http');const p=process.env.PORT||3000;http.createServer((_,r)=>r.end('hello from uploaded source\\n')).listen(p,()=>console.log('up '+p));",
);
const tgz = join(tmpdir(), "upload-src.tgz");
execSync(`tar -czf ${tgz} -C ${src} .`);

cleanup();
const app = createApiServer();
await app.listen({ port: PORT, host: "127.0.0.1" });
console.log(`hub on 127.0.0.1:${PORT}`);

const agent = spawn(
  "deploy/infra/bin/portless-agent-darwin-arm64",
  [
    "connect",
    "--hub",
    `ws://127.0.0.1:${PORT}/agent`,
    "--token",
    "owner-dev-token",
    "--name",
    "builder",
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
agent.stdout.on("data", (d) => process.stdout.write(`  [agent] ${d}`));
agent.stderr.on("data", (d) => process.stdout.write(`  [agent!] ${d}`));

const caller = createCallerFactory(appRouter)({ principal: owner, audit: new InMemoryAuditLog() });

let failed = true;
try {
  for (let i = 0; i < 40 && !(await caller.agents.list()).some((a) => a.id === "builder"); i++)
    await sleep(250);
  if (!(await caller.agents.list()).some((a) => a.id === "builder"))
    throw new Error("build node never connected");
  console.log("✅ build node connected");

  // upload the tarball via the raw POST /upload route
  const up = await app.inject({
    method: "POST",
    url: "/upload",
    headers: { authorization: "Bearer owner-dev-token", "content-type": "application/gzip" },
    payload: execSync(`cat ${tgz}`),
  });
  const { buildId } = up.json();
  console.log(`✅ uploaded source → buildId ${buildId.slice(0, 8)}`);

  console.log("deploying from upload (fetch tar → nixpacks build → push → deploy)…");
  const started = await caller.upload.deploy({
    buildId,
    app: APP,
    port: APP_PORT,
    buildNode: "builder",
    node: "builder",
    confirm: true,
  });
  console.log(`deploy queued: deployId ${started.deployId.slice(0, 8)}`);
  const d = await deployed(caller, started.deployId);
  console.log(
    `deploy finished: ${d.stage} — ${d.detail}${d.urls.length ? ` (${d.urls.join(", ")})` : ""}`,
  );

  let body = "";
  for (let i = 0; i < 30; i++) {
    try {
      body = (await fetch(`http://127.0.0.1:${APP_PORT}/`).then((x) => x.text())).trim();
      if (body) break;
    } catch {
      /* not up */
    }
    await sleep(500);
  }
  console.log(`GET http://127.0.0.1:${APP_PORT}/ → ${JSON.stringify(body)}`);
  if (!body.includes("hello from uploaded source")) throw new Error("deployed app did not serve");
  console.log("✅ upload deploy works end to end — app built from an uploaded tarball is serving");
  failed = false;
} catch (e) {
  console.error("FAIL:", (e as Error).message);
}
cleanup();
agent.kill("SIGKILL");
console.log("cleaned up.");
process.exit(failed ? 1 : 0);
