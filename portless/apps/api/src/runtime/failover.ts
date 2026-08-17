// Stateless auto-failover: when a node's control channel drops and stays gone past a grace window,
// redeploy every app it ran onto a surviving node and flip the route. No rebuild — the image is
// already in the registry, so the survivor just pulls+runs it; secrets are re-injected from the store.
// The data plane makes the cutover a single atomic route write, so traffic follows immediately.
//
// ponytail: redeploys stateless apps only (pull image + run). Stateful apps need volume replication
// (not built); a redeployed DB starts empty. Single-shot per disconnect, first-fit node selection.
import { agentGateway, type AgentGateway } from './agents.ts';
import { routeStore, type RouteStore } from './routes.ts';
import { appStore, type AppStore } from './apps.ts';
import { secretStore, type SecretStore } from './secrets.ts';

export interface FailoverDeps {
  gateway: Pick<AgentGateway, 'get' | 'list' | 'send' | 'onDisconnect'>;
  routes: Pick<RouteStore, 'list' | 'set'>;
  secrets: Pick<SecretStore, 'get'>;
  apps?: Pick<AppStore, 'list' | 'set'>; // multi-service apps; absent → single-container failover only
  log?: (msg: string) => void;
}

export interface FailoverResult { app: string; from: string; to: string; ok: boolean; error?: string }

// Redeploy every app stranded on `lostId` onto a surviving node. Returns what it did (for tests/logs).
export async function failoverNode(lostId: string, deps: FailoverDeps): Promise<FailoverResult[]> {
  const log = deps.log ?? ((m: string) => console.log(`[failover] ${m}`));
  if (deps.gateway.get(lostId)) return []; // came back within the grace window — nothing to do
  // Multi-service apps stranded on the node — redeployed as a whole group (network + all services), so
  // their per-service routes must NOT also be redeployed individually below.
  const groups = (deps.apps?.list() ?? []).filter((g) => g.node === lostId);
  const groupRoutes = new Set(groups.flatMap((g) => g.services.map((s) => s.route).filter((r): r is string => !!r)));
  const affected = deps.routes.list().filter((r) => r.node === lostId && !groupRoutes.has(r.app));
  if (!affected.length && !groups.length) return [];
  // Any other connected agent is a candidate; a wrong pick just fails the deploy and is logged.
  const healthy = deps.gateway.list().map((a) => a.id).filter((id) => id !== lostId);
  if (!healthy.length) {
    log(`node ${lostId} down with ${affected.length + groups.length} app(s) but no surviving node to take over`);
    return [...affected.map((a) => a.app), ...groups.map((g) => g.app)].map((app) => ({ app, from: lostId, to: '', ok: false, error: 'no surviving node' }));
  }
  const results: FailoverResult[] = [];
  let pick = 0; // round-robin survivor index across both single apps and groups
  for (const app of affected) {
    const to = healthy[pick++ % healthy.length];
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
  for (const g of groups) {
    const to = healthy[pick++ % healthy.length];
    // Stored plain env (PORT, injected needs) + live secrets; PORT stays platform-owned.
    const services = g.services.map((s) => {
      const env = { ...s.env, ...deps.secrets.get(g.app), ...deps.secrets.get(`${g.app}-${s.name}`) };
      if (s.env?.PORT) env.PORT = s.env.PORT;
      return { name: s.name, image: s.image, args: s.args, port: s.port, route: s.route, env };
    });
    try {
      const reply = await deps.gateway.send(to, { cmd: 'deployApp', app: g.app, services }, 300_000);
      if (reply.ok) {
        deps.apps!.set(g.app, { node: to, services: g.services });
        for (const s of g.services) if (s.route && s.port) deps.routes.set(s.route, { node: to, image: s.image, port: s.port });
        log(`failed over app ${g.app} (${g.services.length} svc): ${lostId} → ${to}`);
      } else log(`failover of app ${g.app} → ${to} failed: ${reply.error}`);
      results.push({ app: g.app, from: lostId, to, ok: reply.ok, error: reply.error });
    } catch (e) {
      log(`failover of app ${g.app} → ${to} errored: ${(e as Error).message}`);
      results.push({ app: g.app, from: lostId, to, ok: false, error: (e as Error).message });
    }
  }
  return results;
}

// Wire failover to agent disconnects with a debounce: a brief blip or a hub restart (agents reconnect
// in ~3s) must NOT trigger a redeploy storm. PORTLESS_FAILOVER=0 disables it.
export function installFailover(deps: FailoverDeps = { gateway: agentGateway, routes: routeStore, secrets: secretStore, apps: appStore }, graceMs = Number(process.env.PORTLESS_FAILOVER_GRACE_MS ?? 20_000)): void {
  if (process.env.PORTLESS_FAILOVER === '0') return;
  deps.gateway.onDisconnect((lostId) => {
    setTimeout(() => { void failoverNode(lostId, deps); }, graceMs);
  });
}
