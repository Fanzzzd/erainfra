import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseAppSpec } from '../src/appspec.ts';
import { buildTopology } from '../src/topology.ts';

const yaml = readFileSync(fileURLToPath(new URL('../../../examples/portless.yaml', import.meta.url)), 'utf8');

function topo() {
  const parsed = parseAppSpec(yaml);
  assert.ok(parsed.ok);
  if (!parsed.ok) throw new Error('parse failed');
  return buildTopology(parsed.value);
}

test('topology has service, ingress, and external resource nodes', () => {
  const t = topo();
  const kinds = t.nodes.reduce<Record<string, number>>((a, n) => ((a[n.kind] = (a[n.kind] ?? 0) + 1), a), {});
  assert.equal(kinds.service, 2); // postgres + api
  assert.equal(kinds.ingress, 1); // api.example.com
  assert.equal(kinds.resource, 3); // r2 assets, data-platform analytics, redis sessions
});

test('edges connect ingress->service, service->dependency, service->resource', () => {
  const t = topo();
  assert.ok(t.edges.some((e) => e.kind === 'ingress' && e.target === 'svc:api'));
  assert.ok(t.edges.some((e) => e.kind === 'depends' && e.source === 'svc:api' && e.target === 'svc:postgres'));
  assert.ok(t.edges.some((e) => e.kind === 'connects' && e.source === 'svc:api' && e.target.startsWith('res:object-storage')));
});

test('resource nodes carry provider/type metadata and are positioned in a column', () => {
  const t = topo();
  const r2 = t.nodes.find((n) => n.id === 'res:object-storage:r2:assets')!;
  assert.equal(r2.subtype, 'r2');
  assert.equal(r2.meta?.type, 'object-storage');
  assert.ok(t.nodes.filter((n) => n.kind === 'resource').every((n) => n.position.x === 760));
});
