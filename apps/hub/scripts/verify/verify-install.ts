// Verify the one-line enrollment UX: a fresh box (clean container, nothing preinstalled) runs
//   curl <hub>/agent.sh | sh -s -- --token <tok>
// and it should download the right agent binary FROM THE HUB and connect — no hand-built commands,
// no extra servers, hub URL auto-derived from where the script was served. Proves agent.sh +
// /agent-bin serving end to end. Needs the binaries built (deploy/build-agents.sh) + Docker.
// Run: node --experimental-strip-types apps/hub/scripts/verify/verify-install.ts
import { spawn, execSync } from "node:child_process";
import { createApiServer } from "../../src/server.ts";
import { appRouter } from "../../src/router.ts";
import { createCallerFactory } from "../../src/trpc.ts";
import { InMemoryAuditLog } from "../../src/audit.ts";
import type { Principal } from "../../src/auth.ts";

const PORT = 8795,
  NODE = "pl-installed";
const owner: Principal = { id: "u-owner", name: "Owner", roles: ["owner"] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cleanup = () => {
  try {
    execSync(`docker rm -f ${NODE}`, { stdio: "ignore" });
  } catch {
    /* gone */
  }
};

cleanup();
const app = createApiServer();
await app.listen({ port: PORT, host: "0.0.0.0" });
console.log(`hub on 0.0.0.0:${PORT} (serving /agent.sh + /agent-bin/*)`);

// A clean box: bare alpine, only curl added. It fetches the installer and runs it with JUST a token —
// the hub URL is templated into agent.sh, so the agent figures out wss + which binary to download.
const HUB = "http://host.docker.internal:" + PORT;
const oneLiner = `apk add -q curl && curl -fsSL ${HUB}/agent.sh | sh -s -- --hub ${HUB} --token owner-dev-token --name installed-node --foreground`;
const node = spawn(
  "docker",
  [
    "run",
    "--rm",
    "--name",
    NODE,
    "--add-host=host.docker.internal:host-gateway",
    "alpine",
    "sh",
    "-c",
    oneLiner,
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
node.stdout.on("data", (d) => process.stdout.write(`  [node] ${d}`));
node.stderr.on("data", (d) => process.stdout.write(`  [node!] ${d}`));

const caller = createCallerFactory(appRouter)({ principal: owner, audit: new InMemoryAuditLog() });

let failed = true;
try {
  let seen = false;
  for (let i = 0; i < 80; i++) {
    if ((await caller.agents.list()).some((a) => a.id === "installed-node")) {
      seen = true;
      break;
    }
    await sleep(500);
  }
  if (!seen) throw new Error("node never registered via the installer");
  console.log(
    "✅ one-line installer enrolled the node (downloaded binary from the hub, connected)",
  );
  const h = await caller.agents.run({
    agentId: "installed-node",
    operation: { name: "system.hostname", args: {} },
    confirm: true,
  });
  console.log(`installed node hostname: ${JSON.stringify((h.output ?? "").trim())}`);
  if (!h.ok) throw new Error("exec did not round-trip");
  console.log("✅ exec round-trips to the installer-enrolled node");
  failed = false;
} catch (e) {
  console.error("FAIL:", (e as Error).message);
  try {
    console.error(execSync(`docker logs ${NODE} 2>&1 | tail -20`).toString());
  } catch {
    /* no logs */
  }
}
cleanup();
node.kill("SIGKILL");
console.log("cleaned up.");
process.exit(failed ? 1 : 0);
