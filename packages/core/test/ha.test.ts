import test from 'node:test';
import assert from 'node:assert/strict';
import { choosePlacements, evaluateZeroDowntime } from '../src/index.ts';
import { sampleApp, sampleMachines, samplePaths } from '../src/sample.ts';

const postgres = sampleApp.services.find((service) => service.name === 'postgres')!;
const api = sampleApp.services.find((service) => service.name === 'api')!;

test('marks a two-replica API with health check as zero-downtime ready', () => {
  const postgresPlacement = choosePlacements({ machines: sampleMachines, service: postgres });
  const apiPlacement = choosePlacements({
    machines: sampleMachines,
    service: api,
    existingPlacements: { postgres: postgresPlacement.machineIds },
    paths: samplePaths,
  });

  const report = evaluateZeroDowntime({ service: api, placement: apiPlacement, machines: sampleMachines });
  assert.equal(report.ready, true);
  assert.equal(report.blockers.length, 0);
});

test('blocks single-replica web service without readiness health check', () => {
  const service = { ...api, replicas: 1, healthPath: undefined };
  const placement = choosePlacements({ machines: sampleMachines, service });
  const report = evaluateZeroDowntime({ service, placement, machines: sampleMachines });

  assert.equal(report.ready, false);
  assert.match(report.blockers.join('\n'), /At least two replicas/);
  assert.match(report.blockers.join('\n'), /readiness health path/);
});
