// Verify per-app secrets reach the running container: set an env var via env.set, deploy, and assert
// the container sees it. Needs Docker + registry :5005.
// Run: node --experimental-strip-types prototypes/relay-experiments/verify-env.ts
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.PORTLESS_HUB_BASE = 'http://127.0.0.1:8795';
process.env.PORTLESS_REGISTRY = '127.0.0.1:5005';
import { createApiServer } from '../../apps/api/src/server.ts';
import { appRouter } from '../../apps/api/src/router.ts';
import { createCallerFactory } from '../../apps/api/src/trpc.ts';
import { InMemoryAuditLog } from '../../apps/api/src/audit.ts';
import { LocalRuntime } from '../../apps/api/src/runtime/local.ts';
import type { Principal } from '../../apps/api/src/auth.ts';

const PORT = 8795, APP = 'env-app', APP_PORT = 8093;
const owner: Principal = { id: 'u-owner', name: 'Owner', roles: ['owner'] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cleanup = () => { try { execSync(`docker rm -f ${APP}`, { stdio: 'ignore' }); } catch { /* gone */ } };

const src = mkdtempSync(join(tmpdir(), 'env-'));
writeFileSync(join(src, 'package.json'), JSON.stringify({ name: APP, version: '1.0.0', scripts: { start: 'node index.js' } }));
writeFileSync(join(src, 'index.js'), "const http=require('http');const p=process.env.PORT||3000;http.createServer((_,r)=>r.end(process.env.GREETING||'unset')).listen(p);");
const tgz = join(tmpdir(), 'env-src.tgz');
execSync(`tar -czf ${tgz} -C ${src} .`);

cleanup();
const app = createApiServer();
await app.listen({ port: PORT, host: '127.0.0.1' });
const agent = spawn('deploy/bin/portless-agent-darwin-arm64', ['connect', '--hub', `ws://127.0.0.1:${PORT}/agent`, '--token', 'owner-dev-token', '--name', 'builder'], { stdio: ['ignore', 'pipe', 'pipe'] });
agent.stderr.on('data', (d) => process.stdout.write(`  [agent!] ${d}`));
const caller = createCallerFactory(appRouter)({ principal: owner, audit: new InMemoryAuditLog(), runtime: new LocalRuntime() });

let failed = true;
try {
  for (let i = 0; i < 40 && !(await caller.agents.list()).some((a) => a.id === 'builder'); i++) await sleep(250);
  // set a secret for this app BEFORE deploy
  await caller.env.set({ app: APP, vars: { GREETING: 'hello-from-secret' } });
  console.log('✅ env.set GREETING (stored encrypted)');
  // masked listing never leaks the value
  const masked = await caller.env.list({ app: APP });
  console.log(`env.list → ${JSON.stringify(masked)}`);
  if (JSON.stringify(masked).includes('hello-from-secret')) throw new Error('value leaked in list!');

  const up = await app.inject({ method: 'POST', url: '/upload', headers: { authorization: 'Bearer owner-dev-token', 'content-type': 'application/gzip' }, payload: execSync(`cat ${tgz}`) });
  const r = await caller.upload.deploy({ buildId: up.json().buildId, name: APP, port: APP_PORT, buildNode: 'builder', deployNode: 'builder', confirm: true });
  if (!r.ok) throw new Error(`${r.stage} failed: ${r.error}`);

  let body = '';
  for (let i = 0; i < 30; i++) { try { body = (await fetch(`http://127.0.0.1:${APP_PORT}/`).then((x) => x.text())).trim(); if (body) break; } catch { /* not up */ } await sleep(500); }
  console.log(`GET / → ${JSON.stringify(body)}`);
  if (body === 'hello-from-secret') console.log('✅ secret reached the running container (injected as env)');
  else throw new Error('env not injected: ' + body);
  failed = false;
} catch (e) {
  console.error('FAIL:', (e as Error).message);
}
cleanup();
agent.kill('SIGKILL');
process.exit(failed ? 1 : 0);
