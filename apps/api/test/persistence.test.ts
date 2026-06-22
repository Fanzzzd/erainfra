import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../src/projects.ts';

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

test('no persist path = in-memory only (hermetic, nothing written)', () => {
  const store = new ProjectStore([], undefined);
  assert.equal(store.add(SPEC('ephemeral')).ok, true);
  // A second store with no path doesn't see it — there is no shared file.
  assert.equal(new ProjectStore([], undefined).get('ephemeral/prod'), undefined);
});
