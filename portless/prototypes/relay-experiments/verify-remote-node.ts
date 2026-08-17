// Off-loopback multi-node check: the hub runs on the host (bound 0.0.0.0); the agent runs as a
// SEPARATE node — its own container (own OS userspace, netns, hostname) — and reaches the hub over a
// real network hop (host.docker.internal), not 127.0.0.1. It then runs a real deploy via the host
// Docker daemon (socket-mounted) and we HTTP-hit the result. This is the "agent and hub are different
// machines" path that loopback can't prove. Needs Docker + the image already pushed to :5005.
// Run: node --experimental-strip-types prototypes/relay-experiments/verify-remote-node.ts
import { spawn, execSync } from 'node:child_process';
import { createApiServer } from '../../apps/api/src/server.ts';
import { appRouter } from '../../apps/api/src/router.ts';
import { createCallerFactory } from '../../apps/api/src/trpc.ts';
import { InMemoryAuditLog } from '../../apps/api/src/audit.ts';
import type { Principal } from '../../apps/api/src/auth.ts';

const PORT = 8795;
const REGISTRY = process.env.PORTLESS_REGISTRY ?? '127.0.0.1:5005';
const IMAGE = `${REGISTRY}/pl-sample:latest`;
const APP = 'pl-remote-sample';
const NODE = 'pl-node';
const APP_PORT = 8088;
const owner: Principal = { id: 'u-owner', name: 'Owner', roles: ['owner'] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cleanup = () => { for (const c of [APP, NODE]) try { execSync(`docker rm -f ${c}`, { stdio: 'ignore' }); } catch { /* gone */ } };

cleanup(); // clear any leftovers from a prior run
const app = createApiServer();
await app.listen({ port: PORT, host: '0.0.0.0' }); // 0.0.0.0 so the container can reach us off-loopback
console.log(`hub listening on 0.0.0.0:${PORT}`);

// The agent as a separate node: its own container, dialing the hub via host.docker.internal (a real
// network hop), with the host docker socket mounted so its deploys run on the host daemon.
const node = spawn('docker', [
  'run', '--rm', '--name', NODE,
  '--add-host=host.docker.internal:host-gateway',
  '-v', `${process.cwd()}/deploy/bin/portless-agent-linux-arm64:/pl-agent:ro`, // built by build-agents.sh (Docker Desktop runs linux/arm64)
  '-v', '/var/run/docker.sock:/var/run/docker.sock',
  'docker:cli', '/pl-agent', 'connect',
  '--hub', `ws://host.docker.internal:${PORT}/agent`, '--token', 'owner-dev-token', '--name', 'linux-node',
], { stdio: ['ignore', 'pipe', 'pipe'] });
node.stdout.on('data', (d) => process.stdout.write(`  [node] ${d}`));
node.stderr.on('data', (d) => process.stdout.write(`  [node!] ${d}`));

const caller = createCallerFactory(appRouter)({ principal: owner, audit: new InMemoryAuditLog() });

let failed = false;
try {
  let info;
  for (let i = 0; i < 60; i++) { info = (await caller.agents.list()).find((a) => a.id === 'linux-node'); if (info) break; await sleep(500); }
  if (!info) throw new Error('remote node never registered (check firewall / host.docker.internal reachability)');
  console.log('✅ remote node connected over host.docker.internal (off-loopback)');

  // prove it's really a different machine: its hostname is the container id, not this Mac's
  const h = await caller.agents.run({ agentId: 'linux-node', operation: { name: 'system.hostname', args: {} }, confirm: true });
  const macHost = execSync('hostname').toString().trim();
  console.log(`node hostname=${JSON.stringify((h.output ?? '').trim())}  (this Mac=${JSON.stringify(macHost)})`);
  if (!h.ok || (h.output ?? '').trim() === macHost) throw new Error('exec did not run on a distinct node');
  console.log('✅ exec ran on the remote node (distinct hostname)');

  // real deploy initiated BY the remote node, via the host daemon
  console.log(`deploying ${IMAGE} from the remote node …`);
  const d = await caller.agents.deploy({ agentId: 'linux-node', image: IMAGE, name: APP, args: ['-p', `${APP_PORT}:3000`], confirm: true });
  if (!d.ok) throw new Error('deploy failed: ' + (d.error ?? d.output));
  console.log('✅ remote node pulled + ran the container');

  let body = '';
  for (let i = 0; i < 30; i++) { try { body = (await fetch(`http://127.0.0.1:${APP_PORT}/`).then((x) => x.text())).trim(); if (body) break; } catch { /* not up */ } await sleep(500); }
  console.log(`GET http://127.0.0.1:${APP_PORT}/ → ${JSON.stringify(body)}`);
  if (!body.includes('hello from portless')) throw new Error('deployed container did not serve');
  console.log('✅ container deployed by the remote node is serving traffic');
} catch (e) {
  console.error('FAIL:', (e as Error).message);
  try { console.error(execSync(`docker logs ${NODE} 2>&1 | tail -15`).toString()); } catch { /* no logs */ }
  failed = true;
}
cleanup();
node.kill('SIGKILL');
console.log('cleaned up — containers removed.');
process.exit(failed ? 1 : 0);
