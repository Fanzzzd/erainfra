// Real physical second machine: the Windows Server box at 192.168.10.46 over the LAN.
// The box is UAC-locked (no headless copy/exec, no SSH/WinRM), so it's enrolled the product way:
// a human runs ONE line in an RDP session. This script stands up the Mac side and waits:
//   - hub on 0.0.0.0:8795  (the agent dials in over the LAN; node is allowed through the Mac firewall)
//   - a plain HTTP server on :8799 serving the cross-compiled Windows agent (SMB copy is blocked)
// then it polls until "winbox" connects and proves control over the LAN (hostname + `ver`).
// Run (background): node --experimental-strip-types prototypes/relay-experiments/verify-winbox.ts
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createApiServer } from '../../apps/api/src/server.ts';
import { appRouter } from '../../apps/api/src/router.ts';
import { createCallerFactory } from '../../apps/api/src/trpc.ts';
import { InMemoryAuditLog } from '../../apps/api/src/audit.ts';
import { LocalRuntime } from '../../apps/api/src/runtime/local.ts';
import type { Principal } from '../../apps/api/src/auth.ts';

const HUB_PORT = 8795, BIN_PORT = 8799, LAN_IP = '192.168.10.129';
const owner: Principal = { id: 'u-owner', name: 'Owner', roles: ['owner'] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const app = createApiServer();
await app.listen({ port: HUB_PORT, host: '0.0.0.0' });

const exe = readFileSync('/tmp/pl-agent.exe');
const binServer = createServer((_req, res) => { res.setHeader('content-type', 'application/octet-stream'); res.end(exe); }).listen(BIN_PORT, '0.0.0.0');

console.log(`hub on 0.0.0.0:${HUB_PORT}, agent download on :${BIN_PORT} (${exe.length} bytes)`);
console.log('\n=== run this ONE line in an RDP session on the Windows box (192.168.10.46) ===');
console.log(`  $h='${LAN_IP}'; iwr "http://$h:${BIN_PORT}/pl-agent.exe" -OutFile "$env:TEMP\\pl-agent.exe"; & "$env:TEMP\\pl-agent.exe" connect --hub "ws://$h:${HUB_PORT}/agent" --token owner-dev-token --name winbox`);
console.log('===========================================================================\n');

const caller = createCallerFactory(appRouter)({ principal: owner, audit: new InMemoryAuditLog(), runtime: new LocalRuntime() });

let failed = true;
try {
  let seen = false;
  for (let i = 0; i < 300; i++) { // ~10 min window for the human RDP step
    if ((await caller.agents.list()).some((a) => a.id === 'winbox')) { seen = true; break; }
    if (i % 15 === 0) console.log(`waiting for winbox to connect… (${i * 2}s)`);
    await sleep(2000);
  }
  if (!seen) { console.error('TIMEOUT: winbox never connected'); }
  else {
    console.log('✅ winbox connected to the hub over the LAN');
    const host = await caller.agents.run({ agentId: 'winbox', argv: ['hostname'], confirm: true });
    const ver = await caller.agents.run({ agentId: 'winbox', argv: ['cmd', '/c', 'ver'], confirm: true });
    console.log(`winbox hostname: ${JSON.stringify((host.output ?? '').trim())}`);
    console.log(`winbox ver:      ${JSON.stringify((ver.output ?? '').trim())}`);
    if (host.ok && ver.ok && /Windows/i.test(ver.output ?? '')) { console.log('✅ exec round-trips to the real Windows box over the LAN'); failed = false; }
    else console.error('FAIL: exec did not round-trip as expected');
  }
} catch (e) { console.error('FAIL:', (e as Error).message); }

binServer.close();
console.log('done — you can Ctrl-C the agent in RDP and `del %TEMP%\\pl-agent.exe` to leave it clean.');
process.exit(failed ? 1 : 0);
