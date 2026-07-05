// Enroll the locked-down Windows box (.46) onto the mesh with the ONE command, over the HK LAN.
// Chain: .46 → work-remote:18080 (lan-forward.py) → work-remote:127.0.0.1:18787 (reverse ssh tunnel)
// → this hub on the Mac (127.0.0.1:8787). The hub serves agent.ps1 + the windows agent binary, accepts
// the agent's WSS dial-in, then proves real control by running a command ON .46 through portless (it
// can't run containers — no docker — but exec proves the box is genuinely under portless control).
// Run: node --experimental-strip-types prototypes/relay-experiments/verify-winbox.ts
import { createApiServer } from '../../apps/api/src/server.ts';
import { appRouter } from '../../apps/api/src/router.ts';
import { createCallerFactory } from '../../apps/api/src/trpc.ts';
import { InMemoryAuditLog } from '../../apps/api/src/audit.ts';
import { LocalRuntime } from '../../apps/api/src/runtime/local.ts';
import type { Principal } from '../../apps/api/src/auth.ts';

const PORT = 8787, AGENT = 'winbox-46';
const owner: Principal = { id: 'u-owner', name: 'Owner', roles: ['owner'] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const app = createApiServer();
await app.listen({ port: PORT, host: '0.0.0.0' }); // runs in a published container on work-remote; .46 reaches it via the Docker-published port (bypasses the host firewall)
console.log(`HUB_READY on 0.0.0.0:${PORT}`);
const caller = createCallerFactory(appRouter)({ principal: owner, audit: new InMemoryAuditLog(), runtime: new LocalRuntime() });

// Persistent watch: stay up and, for every fresh connection of the agent, prove control + dump the
// Startup entry the -Install fallback writes. (Kept running so the box can re-enroll/retest freely.)
console.log(`watching for ${AGENT} (paste the irm one-liner in the .46 RDP PowerShell)…`);
const seen = new Set<string>();
for (;;) {
  try {
    const a = (await caller.agents.list()).find((x) => x.id === AGENT);
    if (a && !seen.has(a.connectedAt as string)) {
      seen.add(a.connectedAt as string);
      console.log(`\n✅ ${AGENT} enrolled onto the mesh from one command:`, JSON.stringify(a));
      const r = await caller.agents.run({ agentId: AGENT, argv: ['cmd', '/c', 'ver & hostname & whoami'], confirm: true });
      console.log('--- output from the Windows box, via portless ---');
      console.log((r.output ?? r.error ?? '').trim());
      const s = await caller.agents.run({ agentId: AGENT, argv: ['cmd', '/c', 'type "%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\portless-agent.cmd"'], confirm: true });
      console.log('--- reboot-persistence (Startup entry on the box) ---');
      console.log((s.ok ? s.output : `(none: ${s.error})`)?.trim());
      console.log(r.ok ? '✅ portless is controlling the Windows box (remote exec over the spine)\n' : '');
    }
  } catch (e) {
    console.error('watch error:', (e as Error).message);
  }
  await sleep(3000);
}
