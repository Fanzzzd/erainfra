import test from 'node:test';
import assert from 'node:assert/strict';
import { appRouter } from '../src/router.ts';
import { createCallerFactory } from '../src/trpc.ts';
import { InMemoryAuditLog } from '../src/audit.ts';
import { LocalRuntime } from '../src/runtime/local.ts';
import type { Principal } from '../src/auth.ts';

const createCaller = createCallerFactory(appRouter);

function caller(principal: Principal | null) {
  const audit = new InMemoryAuditLog();
  return { call: createCaller({ principal, audit, runtime: new LocalRuntime() }), audit };
}

const owner: Principal = { id: 'u-owner', name: 'Owner', roles: ['owner'] };
const viewer: Principal = { id: 'u-viewer', name: 'Viewer', roles: ['viewer'] };

test('health is public', async () => {
  const { call } = caller(null);
  assert.deepEqual(await call.health(), { ok: true });
});

test('unauthenticated audit.list is UNAUTHORIZED', async () => {
  const { call } = caller(null);
  await assert.rejects(() => call.audit.list({}), /UNAUTHORIZED/);
});

test('viewer cannot deploy and the denial is audited', async () => {
  const { call, audit } = caller(viewer);
  await assert.rejects(() => call.app.deploy({ app: 'demo/prod', dryRun: true }), /permission/);
  const last = audit.list()[0];
  assert.equal(last.outcome, 'deny');
  assert.equal(last.meta?.permission, 'app.deploy');
});

test('owner dry-run deploy is accepted and audited', async () => {
  const { call, audit } = caller(owner);
  const res = await call.app.deploy({ app: 'demo/prod', dryRun: true });
  assert.equal(res.accepted, true);
  assert.equal(res.dryRun, true);
  const last = audit.list()[0];
  assert.equal(last.action, 'app.deploy');
  assert.equal(last.dryRun, true);
  assert.equal(last.outcome, 'success');
});

test('non-dry-run deploy requires confirm:true', async () => {
  const { call } = caller(owner);
  await assert.rejects(() => call.app.deploy({ app: 'demo/prod', dryRun: false }), /confirm/);
  const ok = await caller(owner).call.app.deploy({ app: 'demo/prod', dryRun: false, confirm: true });
  assert.equal(ok.accepted, true);
  assert.equal(ok.dryRun, false);
});

const DETAIL_YAML = `project: detailtest
environment: prod
services:
  - name: api
    type: web
    image: ghcr.io/x/api
    port: 3000
    resources: { cpu: 250, memoryMb: 256 }
domains:
  - hostname: api.example.com
    service: api
    ingress: cloudflare-tunnel
`;

test('project.detail returns the full spec (services, domains, network, source)', async () => {
  const { call } = caller(owner);
  const imp = await call.project.import({ yaml: DETAIL_YAML });
  if (!imp.ok) throw new Error('import failed');
  const d = await call.project.detail({ projectId: imp.id });
  assert.equal(d.project, 'detailtest');
  assert.equal(d.source, 'imported');
  const api = d.services.find((s) => s.name === 'api')!;
  assert.equal(api.type, 'web');
  assert.ok(api.cpu > 0 && api.memoryMb > 0); // real resources, not placeholders
  assert.ok(d.domains.some((dm) => dm.hostname === 'api.example.com'));
  await assert.rejects(() => call.project.detail({ projectId: 'nope/prod' }), /unknown project/);
});

test('project.addDomain attaches to the spec; route:true needs confirm (never live-calls CF)', async () => {
  const { call } = caller(owner);
  const imp = await call.project.import({ yaml: DETAIL_YAML.replace('detailtest', 'adddomain') });
  if (!imp.ok) throw new Error('import failed');
  const add = await call.project.addDomain({ projectId: imp.id, hostname: 'www.example.com', service: 'api' });
  if (!add.ok) throw new Error('addDomain failed');
  assert.equal(add.route, null); // spec-only path: no Cloudflare touched
  const d = await call.project.detail({ projectId: imp.id });
  assert.ok(d.domains.some((dm) => dm.hostname === 'www.example.com'));
  // Auto-handle via Cloudflare is a real account mutation — refused without confirm, before any CF
  // call. Critically, the refusal must NOT half-apply: the domain must NOT be attached to the spec.
  await assert.rejects(
    () => call.project.addDomain({ projectId: imp.id, hostname: 'x.example.com', service: 'api', route: true }),
    /confirm/,
  );
  const afterReject = await call.project.detail({ projectId: imp.id });
  assert.ok(!afterReject.domains.some((dm) => dm.hostname === 'x.example.com'), 'rejected route must not attach the domain');
  // A non-existent service is rejected.
  const bad = await call.project.addDomain({ projectId: imp.id, hostname: 'y.example.com', service: 'ghost' });
  assert.equal(bad.ok, false);
});
