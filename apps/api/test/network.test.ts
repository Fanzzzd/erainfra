import test from 'node:test';
import assert from 'node:assert/strict';
import { NetmakerNetworkProvider, InMemoryNetmakerClient, Allocator } from '../src/network/netmaker.ts';
import type { NetworkProvider } from '../src/network/provider.ts';
import type { MachineRole } from '../../../packages/core/src/index.ts';

function makeProvider(): { provider: NetworkProvider; client: InMemoryNetmakerClient } {
  const client = new InMemoryNetmakerClient();
  return { provider: new NetmakerNetworkProvider(client), client };
}

const enroll = { roles: ['worker'] as MachineRole[], region: 'sg', publicKey: 'pk' };

test('enroll allocates sequential wgIp + container subnet and creates a netmaker node', async () => {
  const { provider, client } = makeProvider();
  const a = await provider.enrollMachine({ name: 'a', ...enroll });
  const b = await provider.enrollMachine({ name: 'b', ...enroll });
  assert.equal(a.wgIp, '10.88.0.11');
  assert.equal(a.containerSubnet, '10.210.1.0/24');
  assert.equal(b.wgIp, '10.88.0.12');
  assert.equal(b.containerSubnet, '10.210.2.0/24');
  assert.equal(client.nodes.size, 2);
});

test('revoke frees the address slot and deletes the node; re-enroll reuses it', async () => {
  const { provider, client } = makeProvider();
  const a = await provider.enrollMachine({ name: 'a', ...enroll });
  await provider.enrollMachine({ name: 'b', ...enroll });
  await provider.revokeMachine(a.id);
  assert.equal(client.nodes.size, 1);
  const c = await provider.enrollMachine({ name: 'c', publicKey: 'pk', roles: ['worker'], region: 'sg' });
  assert.equal(c.wgIp, '10.88.0.11'); // reused a's freed slot
});

test('failed node creation releases the allocated address (no pool leak)', async () => {
  const client = new InMemoryNetmakerClient();
  const orig = client.createNode.bind(client);
  let fail = true;
  client.createNode = async (i) => {
    if (fail) throw new Error('netmaker unreachable');
    return orig(i);
  };
  const provider = new NetmakerNetworkProvider(client);
  await assert.rejects(() => provider.enrollMachine({ name: 'a', ...enroll }));
  fail = false;
  const b = await provider.enrollMachine({ name: 'b', ...enroll });
  assert.equal(b.wgIp, '10.88.0.11'); // first slot was reclaimed, not leaked to .12
});

test('allocator release is idempotent (double-free cannot hand out colliding IPs)', () => {
  const a = new Allocator();
  const x = a.allocate();
  a.release(x.hostId, x.subnetId);
  a.release(x.hostId, x.subnetId); // double release must not duplicate the free slot
  const y = a.allocate();
  const z = a.allocate();
  assert.notEqual(y.wgIp, z.wgIp);
  assert.notEqual(y.containerSubnet, z.containerSubnet);
});

test('revoke drops fabric paths touching the machine (no stale topology)', async () => {
  const { provider } = makeProvider();
  const a = await provider.enrollMachine({ name: 'a', ...enroll });
  const b = await provider.enrollMachine({ name: 'b', ...enroll });
  await provider.recordPath({ from: a.id, to: b.id, kind: 'lan-direct', rttMs: 2, throughputMbps: 900 });
  assert.equal((await provider.pathMatrix()).length, 1);
  await provider.revokeMachine(a.id);
  assert.equal((await provider.pathMatrix()).length, 0);
});

test('rotateKey replaces the public key', async () => {
  const { provider } = makeProvider();
  const a = await provider.enrollMachine({ name: 'a', ...enroll });
  const rotated = await provider.rotateKey(a.id, 'pk2');
  assert.equal(rotated.publicKey, 'pk2');
  assert.equal((await provider.listMachines())[0].publicKey, 'pk2');
});

test('peers route both node /32 and container subnet, excluding self', async () => {
  const { provider } = makeProvider();
  const a = await provider.enrollMachine({ name: 'a', ...enroll });
  const b = await provider.enrollMachine({ name: 'b', ...enroll });
  const peers = await provider.peersFor(a.id);
  assert.equal(peers.length, 1);
  assert.equal(peers[0].machineId, b.id);
  assert.deepEqual(peers[0].allowedIps, ['10.88.0.12/32', '10.210.2.0/24']);
});

test('path matrix keeps the highest-priority path and resolves bestPath either direction', async () => {
  const { provider } = makeProvider();
  await provider.recordPath({ from: 'a', to: 'b', kind: 'regional-relay', rttMs: 30, throughputMbps: 100 });
  await provider.recordPath({ from: 'a', to: 'b', kind: 'lan-direct', rttMs: 2, throughputMbps: 900 });
  const best = await provider.bestPath('b', 'a'); // reverse direction
  assert.equal(best?.kind, 'lan-direct');
  assert.equal((await provider.pathMatrix()).length, 1); // relay replaced by better lan path
});
