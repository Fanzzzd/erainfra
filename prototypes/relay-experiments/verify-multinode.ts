// Proof: a multi-service app PLACED ACROSS NODES. Two agents (nodeA, nodeB) connect to one hub; an app
// deploys web→nodeA and api→nodeB; the hub fans each service out to its assigned node and gives each
// exposed service an ingress route FROM ITS OWN NODE. We then reach each over the data plane and assert
// the route resolves to the right node — i.e. web is served by nodeA's data channel, api by nodeB's.
//   node --experimental-strip-types prototypes/relay-experiments/verify-multinode.ts
// (Both agents share this machine's docker daemon, so this proves placement + per-node routing, not
//  docker isolation — true daemon separation is what real NAT'd nodes give you. Cross-node service↔
//  service connectivity is the mesh, verified separately.)
import os from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
const scratch = mkdtempSync(join(os.tmpdir(), 'pl-mn-'));
process.env.PORTLESS_APP_DOMAIN = 'apps.local';
process.env.PORTLESS_BIND = '127.0.0.1';
process.env.PORTLESS_ROUTES_FILE = join(scratch, 'routes.json');
process.env.PORTLESS_APPS_FILE = join(scratch, 'apps.json');
process.env.PORTLESS_SECRETS_FILE = join(scratch, 'secrets.json');
process.env.PORTLESS_FAILOVER = '0';
import http from 'node:http';
import { spawn, execSync } from 'node:child_process';
import { createApiServer } from '../../apps/api/src/server.ts';
import { appRouter } from '../../apps/api/src/router.ts';
import { createCallerFactory } from '../../apps/api/src/trpc.ts';
import { InMemoryAuditLog } from '../../apps/api/src/audit.ts';
import { LocalRuntime } from '../../apps/api/src/runtime/local.ts';
import { dataGateway } from '../../apps/api/src/runtime/dataplane.ts';
import type { Principal } from '../../apps/api/src/auth.ts';

const PORT = 8789, APP = 'mndemo', IMAGE = 'nginx:alpine';
const AGENT_BIN = new URL('../../deploy/bin/portless-agent-darwin-arm64', import.meta.url).pathname;
const owner: Principal = { id: 'u-owner', name: 'Owner', roles: ['owner'] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function get(host: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path, method: 'GET', headers: { host } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    r.on('error', reject); r.end();
  });
}
const spawnAgent = (name: string) => spawn(AGENT_BIN, ['connect', '--hub', `ws://127.0.0.1:${PORT}/agent`, '--token', 'owner-dev-token', '--name', name], { stdio: ['ignore', 'inherit', 'inherit'] });

const app = createApiServer();
await app.listen({ port: PORT, host: '127.0.0.1' });
console.log(`HUB_READY on 127.0.0.1:${PORT}`);
const caller = createCallerFactory(appRouter)({ principal: owner, audit: new InMemoryAuditLog(), runtime: new LocalRuntime() });
const agentA = spawnAgent('nodeA');
const agentB = spawnAgent('nodeB');

let failed = true;
try {
  console.log('waiting for nodeA + nodeB to connect (control + data)…');
  for (let i = 0; i < 60 && !(['nodeA', 'nodeB'].every((n) => (caller as any) && dataGateway.isConnected(n))); i++) await sleep(500);
  const ids = (await caller.agents.list()).map((a) => a.id);
  if (!['nodeA', 'nodeB'].every((n) => ids.includes(n) && dataGateway.isConnected(n))) throw new Error(`both agents not online: ${ids.join(',')}`);
  console.log('✅ nodeA + nodeB online');

  console.log(`deploying app "${APP}": web→nodeA, api→nodeB`);
  const r = await caller.agents.deployApp({
    agentId: 'nodeA',
    app: APP,
    services: [
      { name: 'web', image: IMAGE, node: 'nodeA', args: ['-p', '127.0.0.1:18097:80'], port: 18097, route: 'mn-web' },
      { name: 'api', image: IMAGE, node: 'nodeB', args: ['-p', '127.0.0.1:18098:80'], port: 18098, route: 'mn-api' },
    ],
    confirm: true,
  });
  if (!r.ok) throw new Error(`deployApp failed: ${JSON.stringify(r.results)}`);
  if (r.results.length !== 2) throw new Error(`expected 2 per-node deploys, got ${r.results.length}`);
  console.log(`✅ deployApp fanned out to ${r.results.length} nodes: ${r.results.map((x) => x.node).join(', ')}`);

  // routes resolve to the correct node
  const routes = await caller.routes.list();
  const web = routes.find((x) => x.app === 'mn-web'), api = routes.find((x) => x.app === 'mn-api');
  if (web?.node !== 'nodeA') throw new Error(`mn-web should route to nodeA, got ${web?.node}`);
  if (api?.node !== 'nodeB') throw new Error(`mn-api should route to nodeB, got ${api?.node}`);
  console.log('✅ routes: mn-web→nodeA, mn-api→nodeB');

  // reach each over the data plane (mn-web via nodeA's channel, mn-api via nodeB's)
  for (const [host, label] of [['mn-web.apps.local', 'web@nodeA'], ['mn-api.apps.local', 'api@nodeB']] as const) {
    let res; for (let i = 0; i < 30; i++) { res = await get(host, '/'); if (res.status === 200) break; await sleep(1000); }
    console.log(`GET ${host}/ → ${res?.status} (${label})`);
    if (res?.status !== 200 || !/nginx/i.test(res.body)) throw new Error(`reach failed for ${host}: ${res?.status}`);
  }
  console.log('✅ both services reached over the data plane, each via its own node');

  // strong check: drop nodeB → its route goes unreachable while nodeA's stays up (proves per-node routing)
  console.log('dropping nodeB to confirm per-node routing…');
  agentB.kill();
  for (let i = 0; i < 20 && dataGateway.isConnected('nodeB'); i++) await sleep(500);
  const stillWeb = await get('mn-web.apps.local', '/');
  const goneApi = await get('mn-api.apps.local', '/');
  console.log(`after nodeB down: mn-web→${stillWeb.status} (want 200), mn-api→${goneApi.status} (want non-200)`);
  if (stillWeb.status !== 200 || goneApi.status === 200) throw new Error(`per-node routing not proven: web=${stillWeb.status} api=${goneApi.status}`);
  console.log('✅ nodeB down took only api offline; web (nodeA) unaffected — placement is real');

  failed = false;
} catch (e) {
  console.error('FAIL:', (e as Error).message);
}

console.log('cleaning up…');
try { execSync(`docker rm -f ${APP}-web ${APP}-api`, { stdio: 'ignore' }); } catch {}
try { execSync(`docker network rm ${APP}-net`, { stdio: 'ignore' }); } catch {}
agentA.kill(); agentB.kill();
await app.close();
console.log(failed ? 'RESULT: FAIL' : 'RESULT: PASS');
process.exit(failed ? 1 : 0);
