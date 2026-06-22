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
const operator: Principal = { id: 'u-op', name: 'Op', roles: ['operator'] };

// A real-format WireGuard public key (44-char base64). Enrollment requires one — no placeholders.
const PK = 'HIgo9xNzJMWLKASShiTqIybxZ0U3wGLiUeJ1PKf8ykw=';

// The module-level fabric singleton is fresh per test file (node --test isolates files),
// so list starts with just this machine and grows only from these enrollments.

test('list always includes this real machine tagged self', async () => {
  const { call } = caller(viewer);
  const machines = await call.machines.list();
  assert.equal(machines[0].kind, 'self');
  assert.equal(machines[0].id, 'this-machine');
});

test('viewer and operator cannot enroll; the denial is audited', async () => {
  for (const p of [viewer, operator]) {
    const { call, audit } = caller(p);
    await assert.rejects(() => call.machines.enroll({ name: 'x1', region: 'sg', roles: ['worker'], publicKey: PK }), /permission/);
    assert.equal(audit.list()[0].meta?.permission, 'machine.enroll');
  }
});

test('owner enroll allocates a real WG IP + container subnet, audited, then appears in list', async () => {
  const { call, audit } = caller(owner);
  const res = await call.machines.enroll({ name: 'sg-worker-1', region: 'sg', roles: ['worker', 'database'], publicKey: PK });
  // Real allocation, not a placeholder.
  assert.match(res.machine.wgIp, /^10\.88\.0\.\d+$/);
  assert.match(res.machine.containerSubnet, /^10\.210\.\d+\.0\/24$/);
  assert.deepEqual(res.machine.roles, ['worker', 'database']);
  assert.equal(audit.list()[0].action, 'machine.enroll');
  assert.equal(audit.list()[0].outcome, 'success');

  const enrolled = (await call.machines.list()).find((m) => m.id === res.machine.id);
  assert.ok(enrolled, 'enrolled machine shows up in the list');
  assert.equal(enrolled!.kind, 'enrolled');
  assert.equal(enrolled!.wgIp, res.machine.wgIp);
});

test('invalid name is rejected before any allocation', async () => {
  const { call } = caller(owner);
  await assert.rejects(() => call.machines.enroll({ name: 'Bad Name!', region: 'sg', roles: ['worker'], publicKey: PK }));
});

test('enroll defaults to no roles; setRoles assigns several afterward', async () => {
  const { call, audit } = caller(owner);
  const { machine } = await call.machines.enroll({ name: 'sg-bare-1', region: 'sg', publicKey: PK });
  assert.deepEqual(machine.roles, []); // enrolled with no role

  const res = await call.machines.setRoles({ id: machine.id, roles: ['gateway', 'worker', 'relay'] });
  assert.deepEqual(res.machine.roles, ['gateway', 'worker', 'relay']);
  assert.equal(audit.list()[0].action, 'machine.setRoles');
  assert.equal(audit.list()[0].outcome, 'success');

  const row = (await call.machines.list()).find((m) => m.id === machine.id);
  assert.deepEqual(row!.roles, ['gateway', 'worker', 'relay']);

  // Empty array clears them.
  const cleared = await call.machines.setRoles({ id: machine.id, roles: [] });
  assert.deepEqual(cleared.machine.roles, []);
});

test('setRoles on an unknown machine is rejected and audited as failure', async () => {
  const { call, audit } = caller(owner);
  await assert.rejects(() => call.machines.setRoles({ id: 'm-nope', roles: ['worker'] }), /unknown machine/);
  assert.equal(audit.list()[0].outcome, 'failure');
});

test('viewer cannot setRoles', async () => {
  const { call } = caller(viewer);
  await assert.rejects(() => call.machines.setRoles({ id: 'm-1', roles: ['worker'] }), /permission/);
});

test('enroll requires a real WireGuard public key (no placeholder peers)', async () => {
  const { call } = caller(owner);
  await assert.rejects(() => call.machines.enroll({ name: 'no-key', region: 'sg', roles: ['worker'], publicKey: 'not-a-key' }), /public key/i);
});

test('revoking an unknown machine is rejected and audited as failure', async () => {
  const { call, audit } = caller(owner);
  await assert.rejects(() => call.machines.revoke({ id: 'm-does-not-exist', confirm: true }), /revocation failed/);
  const last = audit.list()[0];
  assert.equal(last.action, 'machine.revoke');
  assert.equal(last.outcome, 'failure');
});

test('revoke requires confirm:true, then removes the machine', async () => {
  const { call } = caller(owner);
  const { machine } = await call.machines.enroll({ name: 'sg-edge-1', region: 'home', roles: ['edge'], publicKey: PK });
  await assert.rejects(() => call.machines.revoke({ id: machine.id }), /confirm/);
  assert.ok((await call.machines.list()).some((m) => m.id === machine.id));

  await call.machines.revoke({ id: machine.id, confirm: true });
  assert.ok(!(await call.machines.list()).some((m) => m.id === machine.id));
});
