// End-to-end check of the self-controlled agent↔hub spine (the dumbpipe replacement):
// start the real hub (Fastify + /agent WS gateway), spawn the real Go agent dialing it over WSS,
// then drive it through the real tRPC router (same in-process AgentGateway singleton): list the
// agent, run a command on it, assert the reply. No dumbpipe, no docker.
// Run: node --experimental-strip-types apps/hub/scripts/verify/verify-spine.ts
import { spawn } from "node:child_process";
import { createApiServer } from "../../src/server.ts";
import { appRouter } from "../../src/router.ts";
import { createCallerFactory } from "../../src/trpc.ts";
import { InMemoryAuditLog } from "../../src/audit.ts";
import type { Principal } from "../../src/auth.ts";

const PORT = 8795;
const owner: Principal = { id: "u-owner", name: "Owner", roles: ["owner"] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const app = createApiServer();
await app.listen({ port: PORT, host: "127.0.0.1" });
console.log(`hub listening on :${PORT}`);

const agent = spawn(
  "deploy/infra/bin/portless-agent-darwin-arm64", // built by `sh deploy/infra/build-agents.sh`
  [
    "connect",
    "--hub",
    `ws://127.0.0.1:${PORT}/agent`,
    "--token",
    "owner-dev-token",
    "--name",
    "testbox",
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
agent.stdout.on("data", (d) => process.stdout.write(`  [agent] ${d}`));
agent.stderr.on("data", (d) => process.stdout.write(`  [agent!] ${d}`));

const caller = createCallerFactory(appRouter)({ principal: owner, audit: new InMemoryAuditLog() });

let failed = false;
try {
  // wait for the agent to dial in + say hello
  let seen = false;
  for (let i = 0; i < 40; i++) {
    if ((await caller.agents.list()).some((a) => a.id === "testbox")) {
      seen = true;
      break;
    }
    await sleep(250);
  }
  console.log(
    seen
      ? "✅ agent connected + registered (agents.list shows testbox)"
      : "❌ agent never registered",
  );
  if (!seen) throw new Error("agent did not register");

  // run an allowlisted operation and check the output round-trips through hub→agent→hub
  const r = await caller.agents.run({
    agentId: "testbox",
    operation: { name: "system.hostname", args: {} },
    confirm: true,
  });
  console.log(`operation reply: ok=${r.ok} output=${JSON.stringify((r.output ?? "").trim())}`);
  if (r.ok && (r.output ?? "").trim())
    console.log("✅ hub→agent operation executed, reply round-tripped");
  else throw new Error("command did not round-trip");
  // (agents.deploy = docker pull+run on the agent — needs a working docker daemon, so it's verified
  // on a real box, not here. ponytail gap: a hung `docker pull` blocks the agent's read loop; add a
  // context timeout on container commands before relying on it in production.)
} catch (e) {
  console.error("FAIL:", (e as Error).message);
  failed = true;
}
// app.close() can hang on the open agent socket; we've made our point — kill the agent and exit.
agent.kill("SIGKILL");
console.log("cleaned up — agent killed.");
process.exit(failed ? 1 : 0);
