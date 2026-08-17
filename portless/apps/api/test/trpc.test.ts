import test from 'node:test';
import assert from 'node:assert/strict';
import { appRouter } from '../src/router.ts';
import { createCallerFactory } from '../src/trpc.ts';
import { InMemoryAuditLog } from '../src/audit.ts';
import type { Principal } from '../src/auth.ts';
import { agentGateway } from '../src/runtime/agents.ts';

const createCaller = createCallerFactory(appRouter);

function caller(principal: Principal | null) {
  const audit = new InMemoryAuditLog();
  return { call: createCaller({ principal, audit }), audit };
}

const owner: Principal = { id: 'u-owner', name: 'Owner', roles: ['owner'] };
const operator: Principal = { id: 'u-operator', name: 'Operator', roles: ['operator'] };
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

test('agents.deploy rejects dangerous Docker flag spellings before gateway.send', async (t) => {
  let sends = 0;
  const originalSend = agentGateway.send;
  agentGateway.send = (async () => {
    sends++;
    return { ok: true };
  }) as typeof agentGateway.send;
  t.after(() => { agentGateway.send = originalSend; });

  const forbidden = [
    ['--privileged'],
    ['--privileged', 'true'],
    ['--privileged=true'],
    ['--network', 'host'],
    ['--network=host'],
    ['--net', 'host'],
    ['--net=host'],
    ['--pid', 'host'],
    ['--pid=host'],
    ['--ipc', 'host'],
    ['--ipc=host'],
    ['--device', '/dev/kvm'],
    ['--device=/dev/kvm'],
    ['--cap-add', 'SYS_ADMIN'],
    ['--cap-add=SYS_ADMIN'],
    ['--security-opt', 'seccomp=unconfined'],
    ['--security-opt=seccomp=unconfined'],
    ['-v', '/:/host'],
    ['--volume=/var/run/docker.sock:/var/run/docker.sock'],
    ['--mount', 'type=bind,source=/etc,target=/host'],
    ['--mount=type=bind,source=/etc,target=/host'],
  ];
  const { call } = caller(operator);
  for (const args of forbidden) {
    await assert.rejects(
      () => call.agents.deploy({ agentId: 'n1', image: 'busybox', name: 'probe', args, confirm: true }),
      /docker args|not allowed|named-volume/i,
      args.join(' '),
    );
  }
  assert.equal(sends, 0);
});

test('agents.deploy preserves existing safe publish, env, named-volume, and mesh args', async (t) => {
  const sent: Record<string, unknown>[] = [];
  const originalSend = agentGateway.send;
  agentGateway.send = (async (_agentId, command) => {
    sent.push(command);
    return { ok: true };
  }) as typeof agentGateway.send;
  t.after(() => { agentGateway.send = originalSend; });

  const args = [
    '-e', 'PORT=8080',
    '-p', '8080:80',
    '-v', 'demo-data:/var/lib/data',
    '--add-host=host.docker.internal:host-gateway',
  ];
  await caller(operator).call.agents.deploy({ agentId: 'n1', image: 'busybox', name: 'demo', args, confirm: true });
  assert.deepEqual(sent[0], { cmd: 'deploy', image: 'busybox', name: 'demo', args, env: {}, port: undefined });
});

test('operator cannot run an agent command and is denied before gateway.send', async (t) => {
  let sends = 0;
  const originalSend = agentGateway.send;
  agentGateway.send = (() => {
    sends++;
    throw new Error('gateway.send must not be reached');
  }) as typeof agentGateway.send;
  t.after(() => { agentGateway.send = originalSend; });

  const { call, audit } = caller(operator);
  await assert.rejects(
    () => call.agents.run({ agentId: 'n1', operation: { name: 'disk.usage', args: {} }, confirm: true }),
    /missing permission: agent\.run/,
  );
  assert.equal(sends, 0);
  assert.equal(audit.list()[0]?.meta?.permission, 'agent.run');
});

test('agents.run rejects raw argv before gateway.send', async (t) => {
  let sends = 0;
  const originalSend = agentGateway.send;
  agentGateway.send = (async () => {
    sends++;
    return { ok: true };
  }) as typeof agentGateway.send;
  t.after(() => { agentGateway.send = originalSend; });

  const { call } = caller(owner);
  await assert.rejects(
    () => call.agents.run({ agentId: 'n1', argv: ['sh', '-c', 'id'], confirm: true } as never),
    /operation|unrecognized|invalid/i,
  );
  assert.equal(sends, 0);
});

test('agents.run forwards a typed operation instead of argv', async (t) => {
  const sent: Array<{ agentId: string; command: Record<string, unknown> }> = [];
  const originalSend = agentGateway.send;
  agentGateway.send = (async (agentId, command) => {
    sent.push({ agentId, command });
    return { ok: true, output: 'disk' };
  }) as typeof agentGateway.send;
  t.after(() => { agentGateway.send = originalSend; });

  const { call } = caller(owner);
  await call.agents.run({ agentId: 'n1', operation: { name: 'disk.usage', args: {} }, confirm: true });
  assert.deepEqual(sent, [{ agentId: 'n1', command: { cmd: 'operate', operation: { name: 'disk.usage', args: {} } } }]);
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
