import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseAppSpec, normalizeAppSpec, importAppSpec } from '../src/appspec.ts';

const exampleYaml = readFileSync(
  fileURLToPath(new URL('../../../examples/portless.yaml', import.meta.url)),
  'utf8',
);

test('parses and normalizes the example portless.yaml', () => {
  const result = parseAppSpec(exampleYaml);
  assert.ok(result.ok, JSON.stringify(result));
  if (!result.ok) return;

  const spec = normalizeAppSpec(result.value);
  assert.equal(spec.project, 'demo-shop');
  assert.equal(spec.services.length, 2);
  const api = spec.services.find((s) => s.name === 'api')!;
  assert.equal(api.cpu, 250); // resources.cpu flattened
  assert.equal(api.healthPath, '/health'); // health.path flattened
  assert.equal(api.replicas, 2);
});

test('import produces records mirroring the DB tables', () => {
  const parsed = parseAppSpec(exampleYaml);
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  const records = importAppSpec(parsed.value);
  assert.equal(records.project.name, 'demo-shop');
  assert.equal(records.environment.name, 'prod');
  assert.equal(records.services.length, 2);
  assert.equal(records.domains[0].hostname, 'api.example.com');
  assert.equal(records.domains[0].ingress, 'cloudflare-tunnel');
});

test('reports actionable errors with field paths', () => {
  const bad = `
project: x
environment: prod
services:
  - name: api
    type: web
    image: img
    replicas: -2
    resources:
      cpu: 100
      memoryMb: 64
`;
  const result = parseAppSpec(bad);
  assert.ok(!result.ok);
  if (result.ok) return;
  assert.ok(result.errors.some((e) => e.path.includes('replicas')), JSON.stringify(result.errors));
});

test('rejects a dependency on an unknown service', () => {
  const bad = `
project: x
environment: prod
services:
  - name: api
    type: web
    image: img
    port: 3000
    resources: { cpu: 100, memoryMb: 64 }
    dependencies:
      - service: ghost
`;
  const result = parseAppSpec(bad);
  assert.ok(!result.ok);
  if (result.ok) return;
  assert.ok(result.errors[0].message.includes('unknown dependency'), JSON.stringify(result.errors));
});

test('rejects invalid YAML with a clear message', () => {
  const result = parseAppSpec('project: [unclosed');
  assert.ok(!result.ok);
  if (result.ok) return;
  assert.match(result.errors[0].message, /invalid YAML/);
});

test('rejects a spec with more than 100 services (array cap)', () => {
  const svc = (i: number) => `  - name: s${i}\n    type: web\n    image: img\n    resources: { cpu: 1, memoryMb: 1 }`;
  const many = Array.from({ length: 101 }, (_, i) => svc(i)).join('\n');
  const result = parseAppSpec(`project: big\nenvironment: prod\nservices:\n${many}\n`);
  assert.ok(!result.ok);
});
