import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../src/projects.ts';
import { NetmakerNetworkProvider, InMemoryNetmakerClient } from '../src/network/netmaker.ts';
import type { MachineRole } from '../../../packages/core/src/index.ts';

const SPEC = (name: string) =>
  `project: ${name}\nenvironment: prod\nservices:\n  - name: web\n    type: web\n    image: i\n    port: 80\n    resources: { cpu: 1, memoryMb: 1 }\n`;

test('imported projects survive a restart (persisted to disk, reloaded as imported)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'portless-persist-'));
  const file = join(dir, 'projects.json');
  try {
    const a = new ProjectStore(ProjectStore.exampleYamls(), file);
    assert.equal(a.add(SPEC('my-shop')).ok, true);
    assert.equal(a.sourceOf('my-shop/prod'), 'imported');

    // Fresh store, same file = a "restart". The import must come back, still tagged imported.
    const b = new ProjectStore(ProjectStore.exampleYamls(), file);
    assert.ok(b.get('my-shop/prod'), 'imported project reloaded after restart');
    assert.equal(b.sourceOf('my-shop/prod'), 'imported');
    // Seeds are still present (not duplicated/clobbered).
    assert.ok(b.get('demo-shop/prod'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('enrolled machines + allocations survive a restart (no IP reuse collision)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'portless-fabric-'));
  const file = join(dir, 'fabric.json');
  const enroll = { roles: ['worker'] as MachineRole[], region: 'sg', publicKey: 'pk' };
  try {
    const p1 = new NetmakerNetworkProvider(new InMemoryNetmakerClient(), 'portless', file);
    const a = await p1.enrollMachine({ name: 'a', ...enroll });
    assert.equal(a.wgIp, '10.88.0.11');

    // Restart: fresh provider + client, same file. The machine is restored...
    const p2 = new NetmakerNetworkProvider(new InMemoryNetmakerClient(), 'portless', file);
    const list = await p2.listMachines();
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'a');
    assert.equal(list[0].wgIp, '10.88.0.11');

    // ...and its address slot stays reserved, so the next enrollment can't collide on 10.88.0.11.
    const b = await p2.enrollMachine({ name: 'b', ...enroll });
    assert.notEqual(b.wgIp, a.wgIp);
    assert.equal(b.wgIp, '10.88.0.12');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no persist path = in-memory only (hermetic, nothing written)', () => {
  const store = new ProjectStore([], undefined);
  assert.equal(store.add(SPEC('ephemeral')).ok, true);
  // A second store with no path doesn't see it — there is no shared file.
  assert.equal(new ProjectStore([], undefined).get('ephemeral/prod'), undefined);
});
