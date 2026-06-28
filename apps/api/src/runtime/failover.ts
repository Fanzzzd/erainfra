// Stateless auto-failover: when a node's control channel drops and stays gone past a grace window,
// redeploy every app it ran onto a surviving node and flip the route. No rebuild — the image is
// already in the registry, so the survivor just pulls+runs it; secrets are re-injected from the store.
// The data plane makes the cutover a single atomic route write, so traffic follows immediately.
//
// ponytail: redeploys stateless apps only (pull image + run). Stateful apps need volume replication
// (not built); a redeployed DB starts empty. Single-shot per disconnect, first-fit node selection.
import { agentGateway, type AgentGateway } from './agents.ts';
import { routeStore, type RouteStore } from './routes.ts';
import { secretStore, type SecretStore } from './secrets.ts';

export interface FailoverDeps {
  gateway: Pick<AgentGateway, 'get' | 'list' | 'send' | 'onDisconnect'>;
  routes: Pick<RouteStore, 'list' | 'set'>;
  secrets: Pick<SecretStore, 'get'>;
  log?: (msg: string) => void;
}

export interface FailoverResult { app: string; from: string; to: string; ok: boolean; error?: string }

// Redeploy every app stranded on `lostId` onto a surviving node. Returns what it did (for tests/logs).
export async function failoverNode(lostId: string, deps: FailoverDeps): Promise<FailoverResult[]> {
  const log = deps.log ?? ((m: string) => console.log(`[failover] ${m}`));
  if (deps.gateway.get(lostId)) return []; // came back within the grace window — nothing to do
  const affected = deps.routes.list().filter((r) => r.node === lostId);
  if (!affected.length) return [];
  // Any other connected agent is a candidate; a wrong pick just fails the deploy and is logged.
  const healthy = deps.gateway.list().map((a) => a.id).filter((id) => id !== lostId);
  if (!healthy.length) {
    log(`node ${lostId} down with ${affected.length} app(s) but no surviving node to take over`);
    return affected.map((a) => ({ app: a.app, from: lostId, to: '', ok: false, error: 'no surviving node' }));
  }
  const results: FailoverResult[] = [];
  for (let i = 0; i < affected.length; i++) {
    const app = affected[i];
    const to = healthy[i % healthy.length]; // spread stranded apps across survivors
    const args = ['-e', `PORT=${app.port}`, '-p', `${app.port}:${app.port}`];
    try {
      const reply = await deps.gateway.send(to, { cmd: 'deploy', image: app.image, name: app.app, args, env: deps.secrets.get(app.app), port: app.port }, 180_000);
      if (reply.ok) { deps.routes.set(app.app, { node: to, image: app.image, port: app.port }); log(`failed over ${app.app}: ${lostId} → ${to}`); }
      else log(`failover of ${app.app} → ${to} failed: ${reply.error}`);
      results.push({ app: app.app, from: lostId, to, ok: reply.ok, error: reply.error });
    } catch (e) {
      log(`failover of ${app.app} → ${to} errored: ${(e as Error).message}`);
      results.push({ app: app.app, from: lostId, to, ok: false, error: (e as Error).message });
    }
  }
  return results;
}

// Wire failover to agent disconnects with a debounce: a brief blip or a hub restart (agents reconnect
// in ~3s) must NOT trigger a redeploy storm. PORTLESS_FAILOVER=0 disables it.
export function installFailover(deps: FailoverDeps = { gateway: agentGateway, routes: routeStore, secrets: secretStore }, graceMs = Number(process.env.PORTLESS_FAILOVER_GRACE_MS ?? 20_000)): void {
  if (process.env.PORTLESS_FAILOVER === '0') return;
  deps.gateway.onDisconnect((lostId) => {
    setTimeout(() => { void failoverNode(lostId, deps); }, graceMs);
  });
}
