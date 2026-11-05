// Placement, ports, Docker arguments, injected environment and mesh links for one deployment,
// computed from a validated spec. A port of the Hub's planDeploy (apps/hub/src/runtime/appdeploy.ts)
// with Nodes named by Convex id. Pure apart from the port allocator it is handed, so the rules are
// unit tested without a database; the pipeline passes infra/ports.ts's allocator, which keeps a
// port stable per (Node, key) across redeploys and failovers.
import type { Id } from "../_generated/dataModel";
import { envName, type AppSpec } from "./spec";

export type NodeId = Id<"nodes">;

export interface PlannedService {
  name: string;
  image: string;
  args: string[];
  port?: number;
  route?: string;
  nodeId: NodeId;
  env: Record<string, string>;
}

export interface PlannedLink {
  name: string;
  need: string;
  providerNodeId: NodeId;
  providerPort: number;
  consumerNodeId: NodeId;
  localPort: number;
}

export interface PlannedBuild {
  service: string;
  dir: string;
  image: string;
}

export interface DeployPlan {
  nodeId: NodeId;
  services: PlannedService[];
  links: PlannedLink[];
  builds: PlannedBuild[];
}

/**
 * Mesh link name for an App's dependency, truncated to a valid label. Not unique by construction:
 * the `-` join and the truncation can give two Apps one name, so the pipeline refuses a plan whose
 * link name another App holds (namespace.ts). The scheme stays: deployed Nodes hold these names.
 */
export function linkName(app: string, need: string) {
  return `${app.slice(0, 30)}-${need.slice(0, 30)}`.slice(0, 63);
}

/** The image tag suffix: a short git sha, or the deployment id for an upload. */
export function tagSuffix(revision: string | undefined) {
  return (revision || "latest").replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 12) || "latest";
}

export async function planDeploy(input: {
  spec: AppSpec;
  /** Where a service without `node:` lands. */
  defaultNodeId: NodeId;
  /** A spec's `node:` names a Node; this resolves it, or returns null for an unknown name. */
  nodeIdOf: (name: string) => NodeId | null;
  /** Per-service placement that wins over the spec, as failover moves services off a lost Node. */
  placement?: Record<string, NodeId>;
  /** Images already built, by service name. Failover redeploys these instead of building. */
  images?: Record<string, string>;
  registry: string;
  revision?: string;
  allocate: (nodeId: NodeId, key: string) => Promise<number>;
}): Promise<{ ok: true; plan: DeployPlan } | { ok: false; error: string }> {
  const { spec } = input;
  const nodeOf = new Map<string, NodeId>();
  for (const s of spec.services) {
    const placed = input.placement?.[s.name];
    if (placed !== undefined) nodeOf.set(s.name, placed);
    else if (s.node === undefined) nodeOf.set(s.name, input.defaultNodeId);
    else {
      const id = input.nodeIdOf(s.node);
      if (id === null)
        return { ok: false, error: `service "${s.name}": no Node named "${s.node}"` };
      nodeOf.set(s.name, id);
    }
  }
  const tag = tagSuffix(input.revision);

  // A service needs a loopback host port when it is routed, or when a service on another Node
  // depends on it: the mesh exposure on the provider forwards to that port.
  const crossNeeded = new Set<string>();
  for (const s of spec.services)
    for (const need of s.needs) if (nodeOf.get(s.name) !== nodeOf.get(need)) crossNeeded.add(need);
  // Port keys are `<app>/<service>` and `<app>/link-<need>`: a service named `link-<need>` would
  // share its key, and so its port, with the link that surfaces `<need>`.
  for (const need of crossNeeded)
    if (spec.services.some((s) => s.name === `link-${need}`))
      return {
        ok: false,
        error: `service "link-${need}": the name is reserved while a service on another Node needs "${need}"`,
      };

  const builds: PlannedBuild[] = [];
  const services: PlannedService[] = [];
  for (const s of spec.services) {
    const nodeId = nodeOf.get(s.name)!;
    let image = s.image;
    if (image === undefined) {
      image = input.images?.[s.name] ?? `${input.registry}/${spec.app}-${s.name}:${tag}`;
      if (input.images?.[s.name] === undefined)
        builds.push({ service: s.name, dir: s.build === "." ? "" : (s.build ?? ""), image });
    }
    const hostPort =
      s.route || crossNeeded.has(s.name)
        ? await input.allocate(nodeId, `${spec.app}/${s.name}`)
        : undefined;
    // Loopback only: public traffic arrives through gateway ingress, peers through the mesh.
    const args: string[] = [];
    if (hostPort !== undefined) args.push("-p", `127.0.0.1:${hostPort}:${s.port}`);
    for (const v of s.volumes) args.push("-v", `${spec.app}-${v}`);
    const env: Record<string, string> = {};
    if (s.port) env.PORT = String(s.port);
    services.push({
      name: s.name,
      image,
      args,
      ...(hostPort === undefined ? {} : { port: hostPort }),
      ...(s.route === undefined ? {} : { route: s.route }),
      nodeId,
      env,
    });
  }

  const byName = new Map(services.map((p) => [p.name, p]));
  const specOf = new Map(spec.services.map((s) => [s.name, s]));
  const links: PlannedLink[] = [];
  for (const p of services) {
    let crossNode = false;
    for (const need of specOf.get(p.name)!.needs) {
      const dep = byName.get(need)!;
      const depPort = specOf.get(need)!.port!;
      if (dep.nodeId === p.nodeId) {
        // Same Node: the App's Docker network resolves the service name.
        p.env[`${envName(need)}_HOST`] = need;
        p.env[`${envName(need)}_PORT`] = String(depPort);
      } else {
        // Another Node: a mesh link surfaces the dependency on this Node's loopback, and the
        // container reaches the host through host.docker.internal.
        crossNode = true;
        const localPort = await input.allocate(p.nodeId, `${spec.app}/link-${need}`);
        p.env[`${envName(need)}_HOST`] = "host.docker.internal";
        p.env[`${envName(need)}_PORT`] = String(localPort);
        if (!links.some((l) => l.need === need && l.consumerNodeId === p.nodeId)) {
          links.push({
            name: linkName(spec.app, need),
            need,
            providerNodeId: dep.nodeId,
            providerPort: dep.port!,
            consumerNodeId: p.nodeId,
            localPort,
          });
        }
      }
    }
    if (crossNode) p.args.push("--add-host=host.docker.internal:host-gateway");
    // Spec env is plain configuration and is stored with the service; PORT stays platform-owned.
    const port = p.env.PORT;
    Object.assign(p.env, specOf.get(p.name)!.env);
    if (port !== undefined) p.env.PORT = port;
  }
  return { ok: true, plan: { nodeId: input.defaultNodeId, services, links, builds } };
}

/** JSON with object keys sorted, so two equal values compare equal whatever order they were built in. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .toSorted()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** The Nodes whose group of services differs between two placements, so failover redeploys only those. */
export function changedNodes(
  before: ReadonlyArray<
    Omit<PlannedService, "nodeId" | "env"> & { nodeId?: NodeId; env?: Record<string, string> }
  >,
  beforeDefault: NodeId,
  after: readonly PlannedService[],
): NodeId[] {
  const group = (rows: ReadonlyArray<{ nodeId?: NodeId; name: string }>, fallback: NodeId) => {
    const byNode = new Map<NodeId, string>();
    for (const row of rows.toSorted((a, b) => a.name.localeCompare(b.name))) {
      const node = row.nodeId ?? fallback;
      byNode.set(node, (byNode.get(node) ?? "") + canonicalJson({ ...row, nodeId: node }));
    }
    return byNode;
  };
  const old = group(before, beforeDefault);
  const next = group(after, beforeDefault);
  return [...next.keys()].filter((node) => old.get(node) !== next.get(node));
}
