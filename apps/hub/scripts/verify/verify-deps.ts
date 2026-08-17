// Does "add a library → it just works" hold? Deploy an app whose package.json declares real compute
// libraries (mathjs, dayjs), with an endpoint that USES them, and assert the computed output. Proves
// Nixpacks installs declared deps during build with zero extra config. Needs Docker + registry :5005.
// Run: node --experimental-strip-types apps/hub/scripts/verify/verify-deps.ts
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

const PORT = 8795,
  APP = "deps-app",
  APP_PORT = 8092;
const owner: Principal = { id: "u-owner", name: "Owner", roles: ["owner"] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cleanup = () => {
  try {
    execSync(`docker rm -f ${APP}`, { stdio: "ignore" });
  } catch {
    /* gone */
  }
};

// app with TWO different compute libraries declared as deps and actually used at runtime
const src = mkdtempSync(join(tmpdir(), "deps-"));
writeFileSync(
  join(src, "package.json"),
  JSON.stringify({
    name: "deps-app",
    version: "1.0.0",
    scripts: { start: "node index.js" },
    dependencies: { mathjs: "^14.0.0", dayjs: "^1.11.0" },
  }),
);
writeFileSync(
  join(src, "index.js"),
  `
const http = require('http');
const { evaluate } = require('mathjs');
const dayjs = require('dayjs');
const port = process.env.PORT || 3000;
http.createServer((_, res) => {
  const hypot = evaluate('sqrt(3^2 + 4^2)');                      // mathjs → 5
  const days = dayjs('2026-01-01').diff(dayjs('2025-01-01'), 'day'); // dayjs → 365
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ hypot, days }));
}).listen(port, () => console.log('up ' + port));
`,
);
const tgz = join(tmpdir(), "deps-src.tgz");
execSync(`tar -czf ${tgz} -C ${src} .`);

cleanup();
const app = createApiServer();
await app.listen({ port: PORT, host: "127.0.0.1" });
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
agent.stderr.on("data", (d) => process.stdout.write(`  [agent!] ${d}`));

const caller = createCallerFactory(appRouter)({ principal: owner, audit: new InMemoryAuditLog() });

let failed = true;
try {
  for (let i = 0; i < 40 && !(await caller.agents.list()).some((a) => a.id === "builder"); i++)
    await sleep(250);
  const up = await app.inject({
    method: "POST",
    url: "/upload",
    headers: { authorization: "Bearer owner-dev-token", "content-type": "application/gzip" },
    payload: execSync(`cat ${tgz}`),
  });
  const { buildId } = up.json();
  console.log(
    `uploaded app (deps: mathjs, dayjs) → ${buildId.slice(0, 8)}; building (nixpacks runs npm install)…`,
  );
  const r = await caller.upload.deploy({
    buildId,
    name: APP,
    port: APP_PORT,
    buildNode: "builder",
    deployNode: "builder",
    confirm: true,
  });
  if (!r.ok) throw new Error(`${r.stage} failed: ${r.error ?? r.output}`);

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
  console.log(`GET / → ${body}`);
  const j = JSON.parse(body);
  if (j.hypot === 5 && j.days === 365)
    console.log(
      "✅ both libraries installed + computed correctly after deploy — zero extra config",
    );
  else throw new Error("computed output wrong: " + body);
  failed = false;
} catch (e) {
  console.error("FAIL:", (e as Error).message);
}
cleanup();
agent.kill("SIGKILL");
process.exit(failed ? 1 : 0);
