import test from 'node:test';
import assert from 'node:assert/strict';
import { choosePlacements } from '../src/scheduler.ts';
import { sampleApp, sampleMachines, samplePaths } from '../src/sample.ts';

const postgres = sampleApp.services.find((service) => service.name === 'postgres')!;
const api = sampleApp.services.find((service) => service.name === 'api')!;

test('places database on a machine with database role', () => {
  const decision = choosePlacements({ machines: sampleMachines, service: postgres });
  assert.deepEqual(decision.machineIds, ['machine-b']);
  assert.deepEqual(decision.warnings, []);
});

test('places latency-sensitive API near postgres and avoids edge nodes', () => {
  const decision = choosePlacements({
    machines: sampleMachines,
    service: api,
    existingPlacements: { postgres: ['machine-b'] },
    paths: samplePaths,
  });

  assert.equal(decision.machineIds[0], 'machine-a');
  assert.equal(decision.machineIds.includes('machine-c'), false);
});
