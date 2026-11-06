// Public ingress at gateway Nodes (ADR 0016 phase 3b).
//
// A Node an operator marks with the `gateway` placement role runs the gateway proxy behind
// cloudflared and routes `<label>.<zone>` by the `appRoutes` table. It reaches each App over
// erainfra-mesh: Convex gives the App's Node one exposure per route whose `allowed_peers` are
// exactly the gateway Nodes, and gives every gateway one link per route on a loopback port. No
// App Node ever listens publicly, and a Node that is not a gateway is granted nothing here.
//
// Everything below is derived inside the `state` query from rows that already exist, so a route
// that deploy or failover moves needs no extra write to reach the gateways: the next snapshot
// carries it under a new revision.

/**
 * Gateway-side loopback ports for ingress links. Disjoint from the App port allocator
 * (policy.PORT_RANGE_START..END, 62000-63999) and from the Hub's 61050/61080, so a link never
 * collides with a port Convex hands out for anything else.
 */
export const INGRESS_PORT_START = 61100;
export const INGRESS_PORT_END = 61999;
/**
 * Loopback ports the fleet keeps for host services: the Hub's registry and API (deploy/infra/hub.sh,
 * 61050 and 61080), the gateway proxy (61090, apps/infra-agent/gateway.go), the gateway's ingress
 * links, and the registry ERAINFRA_REGISTRY names, which every Node that pulls reaches over a mesh
 * link on its own loopback. A single-container route at one of these ports is not served on any
 * Node. Where the service runs, the row has outlived its container (the Hub could not publish a
 * port its host already held), and serving it would publish whatever listens there now, such as
 * the unauthenticated registry, at `<label>.<zone>`. On a Node without the service, it costs an App
 * that picked such a port one redeploy through Convex, which allocates from 62000-63999.
 */
export function isHostServicePort(port: number, registry = process.env.ERAINFRA_REGISTRY) {
  if (port === 61050 || port === 61080 || port === 61090) return true;
  if (port >= INGRESS_PORT_START && port <= INGRESS_PORT_END) return true;
  const registryPort = /^[^/:]+:(\d{1,5})(\/|$)/.exec(registry?.trim() ?? "")?.[1];
  return registryPort !== undefined && Number(registryPort) === port;
}

/**
 * The Infra Agent refuses a snapshot with more than 128 links or 128 exposures
 * (meshclient.Desired.Validate in every released agent). Ingress takes what a Node's declared
 * links and exposures leave of that budget, and never more: a route that does not fit is left out
 * of that one Node's snapshot (a gateway counts it in `ingress.overflow` and serves it 503), so a
 * large route table degrades the routes that do not fit instead of refusing every Node's
 * snapshot. Raising this needs an agent release that raises the validator first.
 */
export const MESH_LINK_LIMIT = 128;
export const MESH_EXPOSURE_LIMIT = 128;
/** Route rows a gateway reads per snapshot; rows beyond it are counted as overflow. */
export const INGRESS_ROUTE_READ_LIMIT = 1000;
/** Per ingress link and exposure. Browsers open several connections and WebSockets stay open. */
export const INGRESS_MAX_CONNECTIONS = 1024;

/** A first-level DNS label: what Cloudflare's free wildcard certificate covers (hub.sh). */
const ROUTE_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
export function isRouteLabel(name: string) {
  return ROUTE_LABEL.test(name);
}

const SERVICE_PREFIX = "ingress.";
/** Mesh names are at most 64 characters; a 63-character label plus the prefix is not. */
export function ingressServiceName(label: string) {
  const name = SERVICE_PREFIX + label;
  if (name.length <= 64) return name;
  return `${SERVICE_PREFIX}${label.slice(0, 46)}.${fnv1a(label).toString(16).padStart(8, "0")}`;
}
export function isIngressServiceName(name: string) {
  return name.startsWith(SERVICE_PREFIX);
}

function fnv1a(text: string) {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * The gateway port of each route label. Each label hashes to a slot and probes forward past
 * labels placed before it, in creation order. A new route therefore never moves an existing
 * one, so a gateway's links (and the connections on them) stay put as routes are added; removing a
 * route can move only a later route that collided with it. Every gateway computes the same ports.
 */
export function ingressPorts(routes: readonly { name: string; createdAt: number }[]) {
  const size = INGRESS_PORT_END - INGRESS_PORT_START + 1;
  const taken = new Set<number>();
  const ports = new Map<string, number>();
  const ordered = routes.toSorted(
    (a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name),
  );
  for (const route of ordered) {
    if (ports.has(route.name)) continue;
    // Every slot taken: later routes get no port (the gateway counts them as overflow).
    if (taken.size >= size) break;
    let slot = fnv1a(route.name) % size;
    while (taken.has(slot)) slot = (slot + 1) % size;
    taken.add(slot);
    ports.set(route.name, INGRESS_PORT_START + slot);
  }
  return ports;
}
