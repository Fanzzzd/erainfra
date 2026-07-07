// The deploy pipeline: source → portless.yaml → per-service builds → placed deployApp groups →
// routes → mesh links. This is the whole "no judgment" contract: everything below is computed from
// the spec + connected nodes; the caller (git webhook, CLI upload, redeploy) only names the source.
//
// Runs in the background (builds take minutes; Cloudflare kills tunneled requests at ~100s) and
// reports through the DeploymentStore, which the CLI/dashboard poll.
import { agentGateway, type AgentGateway } from './agents.ts';
import { appStore, type AppLink, type ServiceDeploy } from './apps.ts';
import { linkStore, type MeshLink } from './links.ts';
import { routeStore } from './routes.ts';
import { secretStore } from './secrets.ts';
import { portAllocator } from './ports.ts';
import { deployments } from './deployments.ts';
import { parseSpec, implicitSpec, envName, type AppSpec } from './spec.ts';

export interface DeploySource {
  repoUrl?: string; // git: clone url (may embed a short-lived token)
  ref?: string; // git: branch
  tarUrl?: string; // upload: hub url of the source.tgz
}

export interface DeployOpts {
  app: string; // app name when the spec doesn't name one
  port?: number; // legacy: container port for repos with no portless.yaml
  buildNode: string;
  defaultNode: string; // where unpinned services land
  registry: string;
  hubBase: string;
  sha?: string; // image tag suffix (git sha / build id)
}

type Gw = Pick<AgentGateway, 'send' | 'list'>;
type GwConnect = Gw & Pick<AgentGateway, 'onConnect'>;

const appDomain = () => process.env.PORTLESS_APP_DOMAIN;

// Mesh link name: unique per (app, dependency) on both nodes; dumbpipe replaces same-name links, so
// re-linking is idempotent. Truncated to stay a valid label.
function linkName(app: string, need: string): string {
  return `${app.slice(0, 30)}-${need.slice(0, 30)}`.slice(0, 63);
}

interface PlacedService {
  spec: AppSpec['services'][number];
  node: string;
  image: string;
  hostPort?: number; // loopback publish on the node (routed or depended-on cross-node)
  env: Record<string, string>; // plain env (PORT + injected needs) — NOT secrets
  args: string[];
}

// Compute placement, ports, args, injected env, and mesh links from a validated spec. Pure given the
// allocator, so it's unit-testable; no agent I/O happens here.
export function planDeploy(spec: AppSpec, opts: Pick<DeployOpts, 'defaultNode' | 'registry' | 'sha' | 'app'>, alloc = portAllocator): { placed: PlacedService[]; links: AppLink[] } {
  const byName = new Map(spec.services.map((s) => [s.name, s]));
  const nodeOf = (name: string) => byName.get(name)!.node ?? opts.defaultNode;
  const tagSuffix = (opts.sha || 'latest').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 12) || 'latest';

  // A service needs a host (loopback) port when it's routed, or when some service on ANOTHER node
  // depends on it (the mesh share bridges to the provider's host port).
  const crossNeeded = new Set<string>();
  for (const s of spec.services) for (const need of s.needs) if (nodeOf(s.name) !== nodeOf(need)) crossNeeded.add(need);

  const links: AppLink[] = [];
  const placed: PlacedService[] = spec.services.map((s) => {
    const node = nodeOf(s.name);
    const image = s.image ?? `${opts.registry}/${spec.app}-${s.name}:${tagSuffix}`;
    const needsHostPort = !!s.route || crossNeeded.has(s.name);
    const hostPort = needsHostPort ? alloc.alloc(node, `${spec.app}/${s.name}`) : undefined;
    const args: string[] = [];
    if (hostPort) args.push('-p', `127.0.0.1:${hostPort}:${s.port}`); // loopback only — public access is the data plane, peers are the mesh
    for (const v of s.volumes) args.push('-v', `${spec.app}-${v}`); // app-prefixed named volume: no cross-app collisions
    const env: Record<string, string> = {};
    if (s.port) env.PORT = String(s.port);
    return { spec: s, node, image, hostPort, env, args };
  });
  const byPlaced = new Map(placed.map((p) => [p.spec.name, p]));

  for (const p of placed) {
    let crossNode = false;
    for (const need of p.spec.needs) {
      const dep = byPlaced.get(need)!;
      if (dep.node === p.node) {
        // Same node: the per-app docker network resolves the service name directly.
        p.env[`${envName(need)}_HOST`] = need;
        p.env[`${envName(need)}_PORT`] = String(dep.spec.port);
      } else {
        // Cross node: a mesh link surfaces the dependency on this node; containers reach the node's
        // host via host.docker.internal. One link per (app, dependency, consumer-node), shared.
        crossNode = true;
        const localPort = alloc.alloc(p.node, `${spec.app}/link-${need}`);
        p.env[`${envName(need)}_HOST`] = 'host.docker.internal';
        p.env[`${envName(need)}_PORT`] = String(localPort);
        if (!links.some((l) => l.need === need && l.consumer === p.node)) {
          links.push({ name: linkName(spec.app, need), need, provider: dep.node, providerPort: dep.hostPort!, consumer: p.node, localPort });
        }
      }
    }
    if (crossNode) p.args.push('--add-host=host.docker.internal:host-gateway');
  }
  return { placed, links };
}

// Establish ONE mesh link: share on the provider (→ ticket, hub-internal), connect on the consumer.
// Idempotent — the agent replaces same-name links. Throws with a reason on failure. The ticket is a
// capability to reach the service; it never leaves the hub.
export async function establishLink(l: Pick<MeshLink, 'name' | 'provider' | 'providerPort' | 'consumer' | 'localPort'>, gw: Gw = agentGateway): Promise<void> {
  const connected = new Set(gw.list().map((a) => a.id));
  if (!connected.has(l.provider) || !connected.has(l.consumer)) throw new Error('node offline');
  const share = await gw.send(l.provider, { cmd: 'meshShare', name: l.name, port: l.providerPort }, 60_000);
  if (!share.ok || !share.output) throw new Error(share.error ?? 'no ticket');
  const conn = await gw.send(l.consumer, { cmd: 'meshConnect', name: l.name, ticket: share.output.trim(), port: l.localPort }, 60_000);
  if (!conn.ok) throw new Error(conn.error ?? 'connect failed');
}

// (Re-)establish an app's mesh links. Used after deploy, after failover, and by the boot-time
// re-establish sweep (agent restarts lose their dumbpipe sidecars).
export async function ensureAppLinks(app: string, gw: Gw = agentGateway): Promise<Array<{ name: string; ok: boolean; error?: string }>> {
  const dep = appStore.get(app);
  if (!dep?.links?.length) return [];
  const results: Array<{ name: string; ok: boolean; error?: string }> = [];
  for (const l of dep.links) {
    try {
      await establishLink(l, gw);
      results.push({ name: l.name, ok: true });
    } catch (e) {
      results.push({ name: l.name, ok: false, error: (e as Error).message });
    }
  }
  return results;
}

// The registry lives on ONE box (the hub host, PORTLESS_REGISTRY_NODE names its agent). Every other
// node that builds (push) or deploys (pull) reaches it at the SAME loopback address over a mesh
// link — docker trusts 127.0.0.1:* as insecure registries, so no daemon config anywhere. Links are
// persisted: the healer keeps them alive across agent restarts, so later pulls (failover, restarts)
// keep working without a deploy in flight.
export async function ensureRegistryLinks(nodes: Iterable<string>, registry: string, gw: Gw = agentGateway): Promise<string | null> {
  const registryNode = process.env.PORTLESS_REGISTRY_NODE;
  if (!registryNode) return null; // unset = single-box setup (registry locally reachable); nothing to wire
  const port = Number(registry.split(':').pop());
  const remote = [...new Set(nodes)].filter((n) => n !== registryNode);
  if (!remote.length) return null;
  if (!port) return `cannot parse a port out of PORTLESS_REGISTRY="${registry}"`;
  for (const node of remote) {
    const link: MeshLink = { name: `registry-${node}`.slice(0, 63), provider: registryNode, providerPort: port, consumer: node, localPort: port, createdBy: 'deploy' };
    try {
      await establishLink(link, gw);
      linkStore.set(link);
    } catch (e) {
      return `registry link to ${node}: ${(e as Error).message}`;
    }
  }
  return null;
}

// Merge a service's stored plain env with live secrets. Secrets win over spec env; PORT wins over
// everything (the platform owns which port the app must listen on).
export function serviceEnv(app: string, svc: Pick<ServiceDeploy, 'name' | 'env'>, specEnv: Record<string, string> = {}): Record<string, string> {
  const port = svc.env?.PORT;
  const merged = { ...svc.env, ...specEnv, ...secretStore.get(app), ...secretStore.get(`${app}-${svc.name}`) };
  if (port) merged.PORT = port;
  return merged;
}

export type PipelineResult = { ok: boolean; stage: string; urls: string[]; error?: string };

// The full pipeline. Mutates the deployment record as it goes; returns the final result too (the git
// webhook records it on the binding).
export async function runDeploy(deployId: string, source: DeploySource, opts: DeployOpts, gw: Gw = agentGateway): Promise<PipelineResult> {
  const fail = (stage: string, error: string): PipelineResult => {
    deployments.update(deployId, { stage: 'failed', detail: stage, error });
    return { ok: false, stage, urls: [], error };
  };
  try {
    // 1. Read the spec off the source (the build node fetches it; the hub never needs git/tar tooling).
    deployments.update(deployId, { stage: 'reading-spec', detail: 'reading portless.yaml' });
    const specReply = await gw.send(opts.buildNode, { cmd: 'spec', repoUrl: source.repoUrl, ref: source.ref, tarUrl: source.tarUrl }, 120_000);
    if (!specReply.ok) return fail('reading-spec', specReply.error ?? 'could not fetch the source');
    let spec: AppSpec;
    if (specReply.output?.trim()) {
      const parsed = parseSpec(specReply.output, opts.app);
      if (!parsed.ok) return fail('reading-spec', parsed.error);
      spec = parsed.spec;
    } else {
      if (!opts.port) return fail('reading-spec', 'repo has no portless.yaml — add one, or set a port on the binding');
      spec = implicitSpec(opts.app, opts.port);
    }

    // 2. Validate placement before spending minutes on builds.
    const { placed, links } = planDeploy(spec, { ...opts, app: spec.app });
    const connected = new Set(gw.list().map((a) => a.id));
    for (const n of new Set(placed.map((p) => p.node))) if (!connected.has(n)) return fail('deploying', `node "${n}" is not connected`);
    if (!connected.has(opts.buildNode)) return fail('building', `build node "${opts.buildNode}" is not connected`);

    // 2.5 Registry over the mesh: any node that builds (push) or runs (pull) needs 127.0.0.1-access
    // to the registry BEFORE we spend minutes building.
    const toBuild = placed.filter((p) => p.spec.build !== undefined);
    const registryUsers = [...placed.map((p) => p.node), ...(toBuild.length ? [opts.buildNode] : [])];
    const regErr = await ensureRegistryLinks(registryUsers, opts.registry, gw);
    if (regErr) return fail('linking', regErr);

    // 3. Build every `build:` service on the build node (sequential: one docker daemon, and ordered
    // logs beat a marginal speedup).
    for (const [i, p] of toBuild.entries()) {
      deployments.update(deployId, { stage: 'building', detail: `building ${p.spec.name} (${i + 1}/${toBuild.length})` });
      const tag = p.image.slice(opts.registry.length + 1); // planDeploy composed image as `${registry}/${tag}`
      const build = await gw.send(opts.buildNode, { cmd: 'build', repoUrl: source.repoUrl, ref: source.ref, tarUrl: source.tarUrl, dir: p.spec.build === '.' ? '' : p.spec.build, registry: opts.registry, tag, hubBase: opts.hubBase }, 900_000);
      if (!build.ok) return fail('building', `build ${p.spec.name}: ${build.error ?? ''}\n${(build.output ?? '').slice(-2000)}`);
    }

    // 4. Deploy, grouped one deployApp per node (services on a node share the app network).
    const byNode = new Map<string, PlacedService[]>();
    for (const p of placed) (byNode.get(p.node) ?? byNode.set(p.node, []).get(p.node)!).push(p);
    for (const [node, group] of byNode) {
      deployments.update(deployId, { stage: 'deploying', detail: `deploying ${group.length} service(s) on ${node}` });
      const services = group.map((p) => ({
        name: p.spec.name,
        image: p.image,
        args: p.args,
        port: p.hostPort,
        route: p.spec.route,
        env: serviceEnv(spec.app, { name: p.spec.name, env: p.env }, p.spec.env),
      }));
      const reply = await gw.send(node, { cmd: 'deployApp', app: spec.app, services }, 300_000);
      if (!reply.ok) return fail('deploying', `${node}: ${reply.error ?? ''}\n${(reply.output ?? '').slice(-2000)}`);
    }

    // 5. Record state FIRST (routes flip traffic; appStore is what failover/redeploy/links read).
    appStore.set(spec.app, {
      node: opts.defaultNode,
      services: placed.map((p) => ({ name: p.spec.name, image: p.image, args: p.args, port: p.hostPort, route: p.spec.route, node: p.node, env: { ...p.env, ...p.spec.env } })),
      links,
    });
    for (const p of placed) if (p.spec.route && p.hostPort) routeStore.set(p.spec.route, { node: p.node, image: p.image, port: p.hostPort });

    // 6. Cross-node links (idempotent; containers retry their connections until these are up).
    if (links.length) {
      deployments.update(deployId, { stage: 'linking', detail: `wiring ${links.length} cross-node link(s)` });
      const linked = await ensureAppLinks(spec.app, gw);
      const bad = linked.filter((l) => !l.ok);
      if (bad.length) return fail('linking', bad.map((l) => `${l.name}: ${l.error}`).join('; '));
    }

    const domain = appDomain();
    const urls = placed.filter((p) => p.spec.route).map((p) => (domain ? `https://${p.spec.route}.${domain}` : p.spec.route!));
    deployments.update(deployId, { stage: 'done', detail: 'deployed', urls });
    return { ok: true, stage: 'done', urls };
  } catch (e) {
    return fail('deploying', (e as Error).message);
  }
}

// Tear an app down everywhere: containers, per-app network, mesh links, routes, port allocations.
// Group-aware; falls back to the legacy single-container path for pre-spec deploys. Best-effort on
// offline nodes — state is always forgotten so traffic stops being routed.
export async function removeApp(app: string, gw: Gw = agentGateway): Promise<{ ok: true; stopped: boolean }> {
  const group = appStore.get(app);
  let stopped = false;
  if (group) {
    const byNode = new Map<string, string[]>();
    for (const s of group.services) {
      const node = s.node ?? group.node;
      (byNode.get(node) ?? byNode.set(node, []).get(node)!).push(`${app}-${s.name}`);
    }
    for (const [node, containers] of byNode) {
      try {
        const r = await gw.send(node, { cmd: 'exec', argv: ['docker', 'rm', '-f', ...containers] }, 60_000);
        stopped = stopped || r.ok;
        await gw.send(node, { cmd: 'exec', argv: ['docker', 'network', 'rm', `${app}-net`] }, 30_000).catch(() => {});
      } catch { /* node offline — still forget the state below */ }
    }
    for (const l of group.links ?? []) {
      await gw.send(l.provider, { cmd: 'meshDrop', name: l.name }, 30_000).catch(() => {});
      await gw.send(l.consumer, { cmd: 'meshDrop', name: l.name }, 30_000).catch(() => {});
    }
    for (const s of group.services) if (s.route) routeStore.delete(s.route);
    appStore.delete(app);
  } else {
    // Legacy single-container app (routeStore only), or a bare route label of a group.
    const owner = appStore.list().find((g) => g.services.some((s) => s.route === app));
    if (owner) return removeApp(owner.app, gw);
    const dep = routeStore.get(app);
    if (!dep) throw new Error(`no such app: ${app}`);
    try {
      const r = await gw.send(dep.node, { cmd: 'exec', argv: ['docker', 'rm', '-f', app] }, 30_000);
      stopped = r.ok;
    } catch { /* node offline */ }
    routeStore.delete(app);
  }
  portAllocator.releaseApp(app);
  return { ok: true, stopped };
}

// Boot-time / periodic sweep: re-establish every stored link whose nodes are connected. Agent
// restarts lose their dumbpipe sidecars; this heals them without anyone asking.
// An agent restart wipes its in-memory app->port registry while its containers keep running,
// turning every route on that node into "app not deployed here". The hub's route table is the
// source of truth, so on every agent hello we push the node's registrations back down (idempotent).
export function installServeRehydrator(gw: GwConnect = agentGateway): void {
  gw.onConnect((agentId) => {
    for (const r of routeStore.list()) {
      if (r.node === agentId) void gw.send(agentId, { cmd: 'serve', app: r.app, port: r.port }, 30_000).catch(() => {});
    }
  });
}

export function installLinkHealer(gw: Gw = agentGateway, everyMs = 60_000): void {
  const sweep = async () => {
    for (const { app, links } of appStore.list()) {
      if (links?.length) await ensureAppLinks(app, gw).catch(() => {});
    }
    // Standalone links (portless link / registry auto-links) heal the same way. Offline nodes are
    // skipped (establishLink throws 'node offline'), retried next sweep.
    for (const l of linkStore.list()) await establishLink(l, gw).catch(() => {});
  };
  setTimeout(sweep, 10_000).unref(); // first pass shortly after boot, once agents have re-dialed
  setInterval(sweep, everyMs).unref();
}
