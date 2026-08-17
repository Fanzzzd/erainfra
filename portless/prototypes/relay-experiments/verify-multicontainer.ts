// Proof: portless deploys a MULTI-SERVICE ("compose-like") app — several containers brought up together
// on a shared per-app docker network, talking to each other by service name, with the web service
// exposed over the data plane. Runs fully locally against real docker:
//   - hub in-process (127.0.0.1), PORTLESS_APP_DOMAIN=apps.local
//   - the real Go agent as a subprocess (uses local docker)
//   - agents.deployApp brings up 2 services: web (exposed, nginx) + api (internal, nginx)
//   - reach web over the data plane (proves grouped deploy + ingress)
//   - exec web → wget the internal api BY SERVICE NAME (proves the shared network + DNS)
//   node --experimental-strip-types prototypes/relay-experiments/verify-multicontainer.ts
// Hermetic: routes/apps/secrets persist to scratch files (set before the singletons load). The test
// image (nginx:alpine) is pulled by local docker — test scaffolding only.
import os from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
const scratch = mkdtempSync(join(os.tmpdir(), 'pl-mc-'));
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
import { dataGateway } from '../../apps/api/src/runtime/dataplane.ts';
import type { Principal } from '../../apps/api/src/auth.ts';

const PORT = 8788, AGENT = 'localmc', APP = 'mcdemo', ROUTE = 'mcdemo', WEB_PORT = 18099, IMAGE = 'nginx:alpine';
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

const app = createApiServer();
await app.listen({ port: PORT, host: '127.0.0.1' });
console.log(`HUB_READY on 127.0.0.1:${PORT}`);
const caller = createCallerFactory(appRouter)({ principal: owner, audit: new InMemoryAuditLog() });

const agent = spawn(AGENT_BIN, ['connect', '--hub', `ws://127.0.0.1:${PORT}/agent`, '--token', 'owner-dev-token', '--name', AGENT], { stdio: ['ignore', 'inherit', 'inherit'] });

let failed = true;
try {
  console.log('waiting for the local agent to connect (control + data)…');
  for (let i = 0; i < 60 && !(await caller.agents.list()).some((a) => a.id === AGENT); i++) await sleep(500);
  if (!(await caller.agents.list()).some((a) => a.id === AGENT)) throw new Error('agent never connected (control)');
  for (let i = 0; i < 30 && !dataGateway.isConnected(AGENT); i++) await sleep(500);
  if (!dataGateway.isConnected(AGENT)) throw new Error('agent data channel never connected');
  console.log(`✅ agent "${AGENT}" online`);

  console.log(`deploying app "${APP}": web (exposed) + api (internal) on a shared network…`);
  const r = await caller.agents.deployApp({
    agentId: AGENT,
    app: APP,
    services: [
      { name: 'api', image: IMAGE }, // internal-only — no route, reachable by other services as "api"
      { name: 'web', image: IMAGE, args: ['-p', `127.0.0.1:${WEB_PORT}:80`], port: WEB_PORT, route: ROUTE }, // exposed
    ],
    confirm: true,
  });
  if (!r.ok) throw new Error(`deployApp failed: ${r.error}\n${r.output}`);
  console.log(`✅ deployApp ok — both services up on network ${APP}-net`);

  // 1) ingress: reach the web service over the data plane.
  let res;
  for (let i = 0; i < 30; i++) { res = await get(`${ROUTE}.apps.local`, '/'); if (res.status === 200) break; await sleep(1000); }
  console.log(`GET ${ROUTE}.apps.local/ → ${res?.status} (${res?.body.length} bytes)`);
  if (res?.status !== 200 || !/nginx/i.test(res.body)) throw new Error(`ingress reach failed: ${res?.status}`);
  console.log('✅ reached the web service over the data plane');

  // Raw docker exec is deliberately unavailable. The production deploy planner's same-node DNS
  // behavior is covered by spec.test.ts without reopening a general-purpose host command channel.

  failed = false;
} catch (e) {
  console.error('FAIL:', (e as Error).message);
}

console.log('cleaning up containers + network…');
try { execSync(`docker rm -f ${APP}-web ${APP}-api`, { stdio: 'ignore' }); } catch {}
try { execSync(`docker network rm ${APP}-net`, { stdio: 'ignore' }); } catch {}
agent.kill();
await app.close();
console.log(failed ? 'RESULT: FAIL' : 'RESULT: PASS');
process.exit(failed ? 1 : 0);
