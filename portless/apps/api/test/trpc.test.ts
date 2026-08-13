import test from 'node:test';
import assert from 'node:assert/strict';
import { appRouter } from '../src/router.ts';
import { createCallerFactory } from '../src/trpc.ts';
import { InMemoryAuditLog } from '../src/audit.ts';
import type { Principal } from '../src/auth.ts';

const createCaller = createCallerFactory(appRouter);

function caller(principal: Principal | null) {
  const audit = new InMemoryAuditLog();
  return { call: createCaller({ principal, audit }), audit };
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
  await assert.rejects(() => call.agents.deploy({ agentId: 'n1', image: 'nginx', name: 'demo', confirm: true }), /permission/);
  const last = audit.list()[0];
  assert.equal(last.outcome, 'deny');
  assert.equal(last.meta?.permission, 'app.deploy');
});

test('agents.deploy requires confirm:true before touching any agent', async () => {
  const { call } = caller(owner);
  await assert.rejects(() => call.agents.deploy({ agentId: 'n1', image: 'nginx', name: 'demo' }), /confirm/);
});

test('agents.deployApp is RBAC-gated and validates the service set before touching any agent', async () => {
  const svc = [{ name: 'web', image: 'nginx' }];
  // viewer is denied by the app.deploy permission middleware (before the resolver runs)
  await assert.rejects(() => caller(viewer).call.agents.deployApp({ agentId: 'n1', app: 'flight', services: svc, confirm: true }), /missing permission/);

  const { call } = caller(owner);
  // confirm gate
  await assert.rejects(() => call.agents.deployApp({ agentId: 'n1', app: 'flight', services: svc }), /confirm:true required/);
  // duplicate service names
  await assert.rejects(
    () => call.agents.deployApp({ agentId: 'n1', app: 'flight', services: [{ name: 'web', image: 'a' }, { name: 'web', image: 'b' }], confirm: true }),
    /service names must be unique/,
  );
  // a route with no port to proxy to
  await assert.rejects(
    () => call.agents.deployApp({ agentId: 'n1', app: 'flight', services: [{ name: 'web', image: 'a', route: 'flight' }], confirm: true }),
    /route but no port/,
  );
  // placement target must be a connected node (no agents connected in this test)
  await assert.rejects(
    () => call.agents.deployApp({ agentId: 'n1', app: 'flight', services: [{ name: 'web', image: 'a' }], confirm: true }),
    /not connected/,
  );
});

test('agents.linkService is RBAC-gated, confirm-gated, and checks both nodes are connected', async () => {
  const args = { name: 'dblink', provider: 'nodeB', providerPort: 5432, consumer: 'nodeA', localPort: 15432 };
  await assert.rejects(() => caller(viewer).call.agents.linkService({ ...args, confirm: true }), /missing permission/);
  const { call } = caller(owner);
  await assert.rejects(() => call.agents.linkService({ ...args }), /confirm:true required/);
  await assert.rejects(() => call.agents.linkService({ ...args, confirm: true }), /not connected/); // no agents in this test
});
