// Verify git push-to-deploy end to end (the Vercel flow), with a REAL public GitHub repo:
// bind KlausFan/portless-sample → git.deployNow → the build agent clones it from GitHub, builds with
// nixpacks (no Dockerfile), pushes to the registry, deploys, and the container serves HTTP.
// Needs Docker + a registry on :5005. Run:
//   node --experimental-strip-types apps/hub/scripts/verify/verify-gitdeploy.ts
import { spawn, execSync } from "node:child_process";
process.env.PORTLESS_HUB_BASE = "http://127.0.0.1:8795"; // where the build agent fetches image.sh
process.env.PORTLESS_REGISTRY = "127.0.0.1:5005"; // where it pushes / deploys pull from
import { createApiServer } from "../../src/server.ts";
import { appRouter } from "../../src/router.ts";
import { createCallerFactory } from "../../src/trpc.ts";
import { InMemoryAuditLog } from "../../src/audit.ts";
import type { Principal } from "../../src/auth.ts";

const PORT = 8795,
  APP = "sample-app",
  APP_PORT = 8090;
const owner: Principal = { id: "u-owner", name: "Owner", roles: ["owner"] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cleanup = () => {
  try {
    execSync(`docker rm -f ${APP}`, { stdio: "ignore" });
  } catch {
    /* gone */
  }
};

cleanup();
const app = createApiServer();
await app.listen({ port: PORT, host: "127.0.0.1" });
console.log(`hub on 127.0.0.1:${PORT}`);

// A host-process build+deploy node (has git/curl/docker). This test exercises the git PIPELINE;
// off-loopback networking is covered separately by verify-remote-node.ts.
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

  const bind = await caller.git.bind({
    repo: "KlausFan/portless-sample",
    branch: "main",
    buildNode: "builder",
    deployNode: "builder",
    name: APP,
    port: APP_PORT,
    confirm: true,
  });
  console.log(`✅ bound KlausFan/portless-sample@main → ${APP} (id ${bind.id.slice(0, 8)})`);

  console.log("deploying from GitHub (clone → nixpacks build → push → deploy)…");
  const r = await caller.git.deployNow({ id: bind.id, confirm: true });
  console.log(
    `deploy result: ok=${r.ok} stage=${r.stage} image=${r.image}${r.error ? " error=" + r.error : ""}`,
  );
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
  console.log(`GET http://127.0.0.1:${APP_PORT}/ → ${JSON.stringify(body)}`);
  if (!body.includes("hello from portless")) throw new Error("deployed app did not serve");
  console.log("✅ git push-to-deploy works end to end — app built from GitHub is serving traffic");
  await caller.git.unbind({ id: bind.id, confirm: true });
  failed = false;
} catch (e) {
  console.error("FAIL:", (e as Error).message);
}
cleanup();
agent.kill("SIGKILL");
console.log("cleaned up.");
process.exit(failed ? 1 : 0);
