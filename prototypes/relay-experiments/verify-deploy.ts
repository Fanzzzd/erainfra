// End-to-end check of the DEPLOY half of the chain (the Coolify/Railway path), over the real spine:
// start the hub, connect the real Go agent, then drive agents.deploy through the real tRPC router so
// the agent docker-pulls the image we just built+pushed and docker-runs it. Then HTTP-hit the running
// container. Proves: registry image → agent pull → run → serving. Needs a docker daemon + the image
// already pushed (see the ship step in the session). No mesh needed — loopback stands in for it.
// Run: node --experimental-strip-types prototypes/relay-experiments/verify-deploy.ts
import { spawn, execSync } from 'node:child_process';
import { createApiServer } from '../../apps/api/src/server.ts';
import { appRouter } from '../../apps/api/src/router.ts';
import { createCallerFactory } from '../../apps/api/src/trpc.ts';
import { InMemoryAuditLog } from '../../apps/api/src/audit.ts';
import type { Principal } from '../../apps/api/src/auth.ts';

const PORT = 8795;
const REGISTRY = process.env.PORTLESS_REGISTRY ?? '127.0.0.1:5005';
const IMAGE = `${REGISTRY}/pl-sample:latest`;
const NAME = 'pl-sample';
const APP_PORT = 8088;
const owner: Principal = { id: 'u-owner', name: 'Owner', roles: ['owner'] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const app = createApiServer();
await app.listen({ port: PORT, host: '127.0.0.1' });
console.log(`hub listening on :${PORT}`);

const agent = spawn(
  'deploy/bin/portless-agent-darwin-arm64', // built by `sh deploy/build-agents.sh`
  ['connect', '--hub', `ws://127.0.0.1:${PORT}/agent`, '--token', 'owner-dev-token', '--name', 'testbox'],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
agent.stdout.on('data', (d) => process.stdout.write(`  [agent] ${d}`));
agent.stderr.on('data', (d) => process.stdout.write(`  [agent!] ${d}`));

const caller = createCallerFactory(appRouter)({ principal: owner, audit: new InMemoryAuditLog() });

let failed = false;
try {
  let seen = false;
  for (let i = 0; i < 40; i++) {
    if ((await caller.agents.list()).some((a) => a.id === 'testbox')) { seen = true; break; }
    await sleep(250);
  }
  if (!seen) throw new Error('agent did not register');
  console.log('✅ agent connected + registered');

  // The product's core move: deploy an image to an agent. It docker-pulls from the registry and runs it.
  console.log(`deploying ${IMAGE} → container "${NAME}" (-p ${APP_PORT}:3000) …`);
  const r = await caller.agents.deploy({ agentId: 'testbox', image: IMAGE, name: NAME, args: ['-p', `${APP_PORT}:3000`], confirm: true });
  console.log(`deploy reply: ok=${r.ok}${r.error ? ` error=${r.error}` : ''}`);
  if (!r.ok) throw new Error('deploy failed: ' + (r.error ?? r.output));
  console.log('✅ agent pulled + ran the container');

  // Hit the running container over HTTP — the real end-to-end signal.
  let body = '';
  for (let i = 0; i < 30; i++) {
    try { body = (await fetch(`http://127.0.0.1:${APP_PORT}/`).then((x) => x.text())).trim(); if (body) break; } catch { /* not up yet */ }
    await sleep(500);
  }
  console.log(`GET http://127.0.0.1:${APP_PORT}/ → ${JSON.stringify(body)}`);
  if (body.includes('hello from portless')) console.log('✅ deployed container is serving traffic');
  else throw new Error('container did not serve expected response');
} catch (e) {
  console.error('FAIL:', (e as Error).message);
  failed = true;
}
// cleanup: stop the deployed container + kill the agent (app.close() can hang on the open socket).
try { execSync(`docker rm -f ${NAME}`, { stdio: 'ignore' }); } catch { /* already gone */ }
agent.kill('SIGKILL');
console.log('cleaned up — container removed, agent killed.');
process.exit(failed ? 1 : 0);
