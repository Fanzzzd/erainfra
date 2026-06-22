import type { AppSpecFile } from './appspec.ts';

// A project's topology as a flow graph: ingress -> services -> external resources.
// Positions are computed here (layered columns) so the dashboard just renders.

export type NodeKind = 'ingress' | 'service' | 'resource';

export interface TopoNode {
  id: string;
  kind: NodeKind;
  label: string;
  subtype?: string; // service: web|database|worker  |  resource: r2|s3|data-platform|...
  meta?: Record<string, string | number | boolean>;
  position: { x: number; y: number };
}

export interface TopoEdge {
  id: string;
  source: string;
  target: string;
  kind: 'ingress' | 'depends' | 'connects';
  label?: string;
  latencySensitive?: boolean;
}

export interface Topology {
  project: string;
  environment: string;
  nodes: TopoNode[];
  edges: TopoEdge[];
}

const COL = { ingress: 0, service: 360, resource: 760 } as const;
const ROW = 130;

export function buildTopology(file: AppSpecFile): Topology {
  const nodes: TopoNode[] = [];
  const edges: TopoEdge[] = [];

  // Column 1: services.
  file.services.forEach((svc, i) => {
    nodes.push({
      id: `svc:${svc.name}`,
      kind: 'service',
      label: svc.name,
      subtype: svc.type,
      meta: { replicas: svc.replicas, image: svc.image, ...(svc.port ? { port: svc.port } : {}) },
      position: { x: COL.service, y: i * ROW },
    });
  });

  // Column 0: ingress (domains) -> service.
  (file.domains ?? []).forEach((dom, i) => {
    const id = `ing:${dom.hostname}`;
    nodes.push({
      id,
      kind: 'ingress',
      label: dom.hostname,
      subtype: dom.ingress,
      position: { x: COL.ingress, y: i * ROW },
    });
    edges.push({ id: `e:${id}->svc:${dom.service}`, source: id, target: `svc:${dom.service}`, kind: 'ingress', label: dom.ingress });
  });

  // service -> service dependency edges.
  for (const svc of file.services) {
    for (const dep of svc.dependencies ?? []) {
      edges.push({
        id: `e:svc:${svc.name}->svc:${dep.service}`,
        source: `svc:${svc.name}`,
        target: `svc:${dep.service}`,
        kind: 'depends',
        label: dep.latencySensitive ? 'depends (latency-sensitive)' : 'depends',
        latencySensitive: dep.latencySensitive,
      });
    }
  }

  // Column 2: external resources (deduped) <- service connections.
  const resourceIndex = new Map<string, number>();
  for (const svc of file.services) {
    for (const conn of svc.connections ?? []) {
      // Key on type+provider+name so e.g. an R2 "assets" and an S3 "assets" stay distinct.
      const id = `res:${conn.type}:${conn.provider ?? '_'}:${conn.to}`;
      if (!resourceIndex.has(id)) {
        const y = resourceIndex.size * ROW;
        resourceIndex.set(id, resourceIndex.size);
        nodes.push({
          id,
          kind: 'resource',
          label: conn.to,
          subtype: conn.provider ?? conn.type,
          meta: { type: conn.type, ...(conn.provider ? { provider: conn.provider } : {}), external: conn.external ?? false },
          position: { x: COL.resource, y },
        });
      }
      edges.push({
        id: `e:svc:${svc.name}->${id}`,
        source: `svc:${svc.name}`,
        target: id,
        kind: 'connects',
        label: conn.provider ? `${conn.type} · ${conn.provider}` : conn.type,
      });
    }
  }

  return { project: file.project, environment: file.environment, nodes, edges };
}
