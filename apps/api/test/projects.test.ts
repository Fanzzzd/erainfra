import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectStore } from '../src/projects.ts';
import { buildTopology } from '../src/topology.ts';

test('exampleYamls() parses into the distinct example projects', () => {
  const store = new ProjectStore(ProjectStore.exampleYamls());
  const ids = store.list().map((p) => p.id);
  assert.ok(ids.includes('demo-shop/prod'));
  assert.ok(ids.includes('data-pipeline/prod'));
  assert.ok(ids.includes('media-app/prod'));
});

test('each project has its own topology', () => {
  const store = new ProjectStore(ProjectStore.exampleYamls());
  const demo = buildTopology(store.get('demo-shop/prod')!);
  const pipe = buildTopology(store.get('data-pipeline/prod')!);
  assert.equal(demo.project, 'demo-shop');
  assert.equal(pipe.project, 'data-pipeline');
  assert.equal(demo.nodes.filter((n) => n.kind === 'service').length, 2); // demo-shop: postgres + api
  assert.equal(pipe.nodes.filter((n) => n.kind === 'service').length, 3); // data-pipeline: ingest/transform/warehouse
});

test('examples are opt-in: default starts empty, PORTLESS_SEED_EXAMPLES=1 seeds them', () => {
  const prev = process.env.PORTLESS_SEED_EXAMPLES;
  try {
    delete process.env.PORTLESS_SEED_EXAMPLES;
    assert.equal(new ProjectStore(ProjectStore.discoverSeeds()).list().length, 0); // clean by default
    process.env.PORTLESS_SEED_EXAMPLES = '1';
    assert.ok(new ProjectStore(ProjectStore.discoverSeeds()).list().length >= 3); // opt-in tour
  } finally {
    if (prev === undefined) delete process.env.PORTLESS_SEED_EXAMPLES;
    else process.env.PORTLESS_SEED_EXAMPLES = prev;
  }
});

test('import adds a project; invalid yaml returns errors', () => {
  const store = new ProjectStore([]);
  const ok = store.add('project: x\nenvironment: dev\nservices:\n  - name: a\n    type: web\n    image: i\n    port: 80\n    resources: { cpu: 1, memoryMb: 1 }\n');
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.id, 'x/dev');
  assert.equal(store.list().length, 1);

  const bad = store.add('project: y\nservices: []');
  assert.equal(bad.ok, false);
});

test('duplicate import is refused unless replace:true (no silent clobber)', () => {
  const store = new ProjectStore([]);
  const spec = 'project: dup\nenvironment: prod\nservices:\n  - name: a\n    type: web\n    image: i\n    port: 80\n    resources: { cpu: 1, memoryMb: 1 }\n';
  assert.equal(store.add(spec).ok, true);
  const again = store.add(spec);
  assert.equal(again.ok, false);
  assert.ok('collision' in again && again.collision === true);
  assert.equal(store.add(spec, { replace: true }).ok, true);
});

test('importing over a seeded example is blocked, and source stays example until explicit replace', () => {
  const store = new ProjectStore(ProjectStore.exampleYamls()); // seeded
  const demoSpec = 'project: demo-shop\nenvironment: prod\nservices:\n  - name: x\n    type: web\n    image: i\n    port: 80\n    resources: { cpu: 1, memoryMb: 1 }\n';
  assert.equal(store.add(demoSpec).ok, false); // collision, refused
  assert.equal(store.sourceOf('demo-shop/prod'), 'example'); // NOT flipped by a refused import
  assert.equal(store.add(demoSpec, { replace: true }).ok, true);
  assert.equal(store.sourceOf('demo-shop/prod'), 'imported'); // only after explicit replace
});

test('import is bounded by a project quota', () => {
  const store = new ProjectStore([]);
  for (let i = 0; i < ProjectStore.MAX_PROJECTS; i++) {
    const r = store.add(`project: p${i}\nenvironment: prod\nservices:\n  - name: a\n    type: web\n    image: i\n    port: 80\n    resources: { cpu: 1, memoryMb: 1 }\n`);
    assert.equal(r.ok, true);
  }
  const over = store.add('project: overflow\nenvironment: prod\nservices:\n  - name: a\n    type: web\n    image: i\n    port: 80\n    resources: { cpu: 1, memoryMb: 1 }\n');
  assert.equal(over.ok, false);
  // Replacing an existing project at quota is still allowed (no growth).
  assert.equal(store.add('project: p0\nenvironment: prod\nservices:\n  - name: b\n    type: web\n    image: i\n    port: 80\n    resources: { cpu: 1, memoryMb: 1 }\n', { replace: true }).ok, true);
});

test('seeded projects are tagged example; imported ones are tagged imported (honesty)', () => {
  const store = new ProjectStore(ProjectStore.exampleYamls());
  assert.equal(store.list().find((p) => p.id === 'demo-shop/prod')!.source, 'example');
  assert.equal(store.sourceOf('demo-shop/prod'), 'example');
  store.add('project: mine\nenvironment: prod\nservices:\n  - name: a\n    type: web\n    image: i\n    port: 80\n    resources: { cpu: 1, memoryMb: 1 }\n');
  assert.equal(store.sourceOf('mine/prod'), 'imported');
  assert.equal(store.list().find((p) => p.id === 'mine/prod')!.source, 'imported');
});

const WITH_API = 'project: app\nenvironment: prod\nservices:\n  - name: api\n    type: web\n    image: i\n    port: 80\n    resources: { cpu: 1, memoryMb: 1 }\n';

test('addDomain attaches a domain to a project (persisted spec, reflected in list)', () => {
  const store = new ProjectStore([]);
  store.add(WITH_API);
  assert.equal(store.addDomain('app/prod', { hostname: 'api.example.com', service: 'api' }).ok, true);
  assert.equal(store.list().find((p) => p.id === 'app/prod')!.domains, 1);
  assert.ok(store.get('app/prod')!.domains!.some((d) => d.hostname === 'api.example.com' && d.ingress === 'cloudflare-tunnel'));
});

test('addDomain rejects an unknown service and a duplicate hostname', () => {
  const store = new ProjectStore([]);
  store.add(WITH_API);
  const bad = store.addDomain('app/prod', { hostname: 'x.example.com', service: 'nope' });
  assert.equal(bad.ok, false);
  assert.equal(store.addDomain('app/prod', { hostname: 'api.example.com', service: 'api' }).ok, true);
  const dup = store.addDomain('app/prod', { hostname: 'API.EXAMPLE.COM', service: 'api' }); // case-insensitive
  assert.equal(dup.ok, false);
  assert.equal(store.get('app/prod')!.domains!.length, 1); // not duplicated
});

test('remove deletes a project from the registry (symmetric with add)', () => {
  const store = new ProjectStore([]);
  store.add(WITH_API);
  assert.ok(store.get('app/prod'));
  assert.equal(store.remove('app/prod').ok, true);
  assert.equal(store.get('app/prod'), undefined);
  assert.equal(store.list().length, 0);
  assert.equal(store.remove('app/prod').ok, false); // already gone
});

test('addDomain on an unknown project errors; removeDomain detaches it', () => {
  const store = new ProjectStore([]);
  assert.equal(store.addDomain('ghost/prod', { hostname: 'a.example.com', service: 'api' }).ok, false);
  store.add(WITH_API);
  store.addDomain('app/prod', { hostname: 'api.example.com', service: 'api' });
  assert.equal(store.removeDomain('app/prod', 'api.example.com').ok, true);
  assert.equal((store.get('app/prod')!.domains ?? []).length, 0);
  assert.equal(store.removeDomain('app/prod', 'api.example.com').ok, false); // already gone
});
