// Verify the wildcard-domain backbone end to end: deploy a container on an agent, then make an HTTP
// request to the hub with Host `<app>.<domain>` and assert it is reverse-proxied over the data WS to
// the container on loopback — no inbound port on the node. Needs Docker + registry :5005.
// Run: node --experimental-strip-types prototypes/relay-experiments/verify-dataplane.ts
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
process.env.PORTLESS_HUB_BASE = 'http://127.0.0.1:8796';
process.env.PORTLESS_REGISTRY = '127.0.0.1:5005';
process.env.PORTLESS_APP_DOMAIN = 'apps.local'; // enables the ingress hook
import { createApiServer } from '../../apps/api/src/server.ts';
import { appRouter } from '../../apps/api/src/router.ts';
import { createCallerFactory } from '../../apps/api/src/trpc.ts';
import { InMemoryAuditLog } from '../../apps/api/src/audit.ts';
import { LocalRuntime } from '../../apps/api/src/runtime/local.ts';
import { dataGateway } from '../../apps/api/src/runtime/dataplane.ts';
import type { Principal } from '../../apps/api/src/auth.ts';

const PORT = 8796, APP = 'web-app', APP_PORT = 8094;
const owner: Principal = { id: 'u-owner', name: 'Owner', roles: ['owner'] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cleanup = () => { try { execSync(`docker rm -f ${APP}`, { stdio: 'ignore' }); } catch { /* gone */ } };

// A container that echoes what it received, so we can prove method/path/forwarded-headers arrive.
const src = mkdtempSync(join(tmpdir(), 'dp-'));
writeFileSync(join(src, 'package.json'), JSON.stringify({ name: APP, version: '1.0.0', scripts: { start: 'node index.js' } }));
writeFileSync(join(src, 'index.js'),
  "const http=require('http');const p=process.env.PORT||3000;" +
  "http.createServer((req,res)=>{res.setHeader('x-app','" + APP + "');" +
  "res.end(JSON.stringify({path:req.url,method:req.method,xff:req.headers['x-forwarded-for']||'',host:req.headers.host||''}));}).listen(p);");
const tgz = join(tmpdir(), 'dp-src.tgz');
execSync(`tar -czf ${tgz} -C ${src} .`);

// Minimal HTTP client that sets an arbitrary Host header (undici forbids it; node:http allows it).
function req(hostHeader: string, path: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path, method: 'GET', headers: { host: hostHeader } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b }));
    });
    r.on('error', reject); r.end();
  });
}

cleanup();
const app = createApiServer();
await app.listen({ port: PORT, host: '127.0.0.1' });
const agent = spawn('deploy/bin/portless-agent-darwin-arm64', ['connect', '--hub', `ws://127.0.0.1:${PORT}/agent`, '--token', 'owner-dev-token', '--name', 'builder'], { stdio: ['ignore', 'pipe', 'pipe'] });
agent.stderr.on('data', (d) => process.stdout.write(`  [agent!] ${d}`));
const caller = createCallerFactory(appRouter)({ principal: owner, audit: new InMemoryAuditLog(), runtime: new LocalRuntime() });

let failed = true;
try {
  // wait for BOTH the control channel and the data channel to be up
  for (let i = 0; i < 40 && !(await caller.agents.list()).some((a) => a.id === 'builder'); i++) await sleep(250);
  for (let i = 0; i < 40 && !dataGateway.isConnected('builder'); i++) await sleep(250);
  if (!dataGateway.isConnected('builder')) throw new Error('data channel never connected');
  console.log('✅ agent control + data channels connected');

  const up = await app.inject({ method: 'POST', url: '/upload', headers: { authorization: 'Bearer owner-dev-token', 'content-type': 'application/gzip' }, payload: execSync(`cat ${tgz}`) });
  const r = await caller.upload.deploy({ buildId: up.json().buildId, name: APP, port: APP_PORT, buildNode: 'builder', deployNode: 'builder', confirm: true });
  if (!r.ok) throw new Error(`${r.stage} failed: ${r.error}`);
  console.log('✅ deployed; route recorded app→node');

  // The real test: hit the hub with Host <app>.apps.local — no port to the node, it's NAT'd.
  let res: Awaited<ReturnType<typeof req>> | undefined;
  for (let i = 0; i < 30; i++) { try { res = await req(`${APP}.apps.local`, '/hello?x=1'); if (res.status === 200) break; } catch { /* not up */ } await sleep(500); }
  console.log(`GET http://${APP}.apps.local/hello?x=1 → ${res?.status} ${res?.body}`);
  if (res?.status !== 200) throw new Error(`proxy did not return 200: ${res?.status} ${res?.body}`);
  const echo = JSON.parse(res.body);
  if (echo.path !== '/hello?x=1') throw new Error('path not forwarded: ' + echo.path);
  if (res.headers['x-app'] !== APP) throw new Error('response headers not forwarded');
  if (!echo.xff) throw new Error('X-Forwarded-For not set');
  console.log('✅ inbound HTTP reverse-proxied to the NAT\'d container (path + headers intact)');

  // unknown app → 404 (no default route / open proxy)
  const ghost = await req('ghost.apps.local', '/');
  if (ghost.status !== 404) throw new Error('unknown app should 404, got ' + ghost.status);
  console.log('✅ unknown app → 404 (no open proxy)');

  // hub's own host is NOT proxied — /health still served normally
  const health = await req('hub.local', '/health');
  if (health.status !== 200 || !health.body.includes('ok')) throw new Error('hub host should bypass proxy: ' + health.status);
  console.log('✅ hub host bypasses the proxy (normal routing intact)');
  failed = false;
} catch (e) {
  console.error('FAIL:', (e as Error).message);
}
cleanup();
agent.kill('SIGKILL');
await app.close();
process.exit(failed ? 1 : 0);
