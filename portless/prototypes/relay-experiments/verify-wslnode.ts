// Proof: the Windows box .46 — via its now-working WSL2 Ubuntu — is a real portless Linux deploy node.
// Everything is driven through the connected agent (typed operations / agents.deploy), so output is captured
// in these logs (no screenshots, no wsl.exe quoting games). The hub runs in a docker-published
// container on work-remote, reached from .46's WSL2 via a host netsh portproxy.
//
// WSL2 here has NO outbound internet (Symantec blocks the NAT) and NO iptables/nft, so:
//   - docker engine = static binaries fetched from the hub side (already extracted to /usr/local/bin),
//   - the test image = registry:2.8.2 saved on work-remote and `docker load`ed (no Docker Hub),
//   - current Portless security policy forbids host networking, so this prototype requires a normal
//     container bridge before it can pass again.
//   node --experimental-strip-types prototypes/relay-experiments/verify-wslnode.ts
process.env.PORTLESS_APP_DOMAIN = 'apps.local';
process.env.PORTLESS_BIND = '0.0.0.0';
import http from 'node:http';
import { createApiServer } from '../../apps/api/src/server.ts';
import { appRouter } from '../../apps/api/src/router.ts';
import { createCallerFactory } from '../../apps/api/src/trpc.ts';
import { InMemoryAuditLog } from '../../apps/api/src/audit.ts';
import { dataGateway } from '../../apps/api/src/runtime/dataplane.ts';
import type { Principal } from '../../apps/api/src/auth.ts';

const PORT = 8787, AGENT = 'stp06-wsl', APP = 'wsl-demo', PORTN = 5000, IMAGE = 'registry:2.8.2';
const owner: Principal = { id: 'u-owner', name: 'Owner', roles: ['owner'] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Bring up dockerd (no iptables/bridge — WSL2 lacks them) and load the test image. Backgrounded dockerd
// logs to a file (not the exec pipe) so agents.run returns instead of hanging on the daemon.
const BRINGUP = [
  'export PATH=/usr/local/bin:$PATH',
  'pkill -f /usr/local/bin/dockerd 2>/dev/null || true',
  'sleep 1',
  'nohup dockerd --iptables=false --bridge=none >/root/dockerd.log 2>&1 &',
  'for i in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done',
  'echo READY=$(docker info >/dev/null 2>&1 && echo yes || echo no)',
  'docker info 2>&1 | grep -iE "server version|storage driver|cgroup version" || true',
  'docker load -i /root/registry.tar 2>&1 | tail -1',
  'echo IMAGES=$(docker images --format "{{.Repository}}:{{.Tag}}" | tr "\\n" " ")',
  'echo "---dockerd.log tail---"; tail -5 /root/dockerd.log',
].join('\n');

function get(host: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path, method: 'GET', headers: { host } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    r.on('error', reject); r.end();
  });
}

const app = createApiServer();
await app.listen({ port: PORT, host: '0.0.0.0' });
console.log(`HUB_READY on 0.0.0.0:${PORT}`);
const caller = createCallerFactory(appRouter)({ principal: owner, audit: new InMemoryAuditLog() });

let failed = true;
try {
  console.log(`waiting for .46 WSL2 agent "${AGENT}" (control + data)…`);
  for (let i = 0; i < 1200 && !(await caller.agents.list()).some((a) => a.id === AGENT); i++) await sleep(500);
  if (!(await caller.agents.list()).some((a) => a.id === AGENT)) throw new Error(`${AGENT} never connected (control)`);
  for (let i = 0; i < 120 && !dataGateway.isConnected(AGENT); i++) await sleep(500);
  if (!dataGateway.isConnected(AGENT)) throw new Error(`${AGENT} data channel never connected`);
  console.log(`✅ agent "${AGENT}" online (control + data)`);

  console.log(`deploying ${IMAGE} as "${APP}" with a normal published port…`);
  const r = await caller.agents.deploy({ agentId: AGENT, image: IMAGE, name: APP, args: ['-p', `127.0.0.1:${PORTN}:${PORTN}`], port: PORTN, confirm: true });
  if (!r.ok) throw new Error(`deploy failed: err=${r.error} | output=${r.output}`);
  console.log(`✅ portless deployed "${APP}" on .46's WSL2`);

  let res;
  for (let i = 0; i < 60; i++) { res = await get(`${APP}.apps.local`, '/v2/'); if (res.status === 200) break; await sleep(1000); }
  console.log(`GET ${APP}.apps.local/v2/ → ${res?.status} ${JSON.stringify(res?.body)}`);
  if (res?.status !== 200) throw new Error(`data-plane reach failed: ${res?.status}`);
  console.log('✅ reached the app on .46 over the data plane — .46 is a working Linux deploy node');
  failed = false;
} catch (e) {
  console.error('FAIL:', (e as Error).message);
}
console.log(failed ? 'RESULT: FAIL' : 'RESULT: PASS');
await new Promise(() => {}); // keep hub + agent up for inspection
