import test from 'node:test';
import assert from 'node:assert/strict';
import { MockNomadProvider, deploymentStatus } from '../src/runtime/nomad.ts';
import { MockConsulProvider, consulServiceName } from '../src/runtime/consul.ts';
import { orchestrateDeployment, rollbackDeployment, type DeployInput } from '../src/runtime/deploy.ts';
import type { Machine, PlacementDecision, ServiceSpec } from '../../../packages/core/src/index.ts';

// --- M5: providers ---

test('nomad mock submits allocations across unique nodes and maps status', async () => {
  const nomad = new MockNomadProvider();
  const { allocations } = await nomad.submitJob({ id: 'j1', replicas: 2, image: 'good' });
  assert.equal(allocations.length, 2);
  assert.notEqual(allocations[0].nodeId, allocations[1].nodeId); // unique-machine placement
  assert.equal(deploymentStatus(allocations), 'healthy');
});

test('consul naming convention + health defaults', async () => {
  const consul = new MockConsulProvider();
  assert.equal(consulServiceName('demo', 'prod', 'api'), 'api-demo-prod');
  assert.equal(await consul.health('api-demo-prod'), 'critical'); // unknown
  await consul.registerService({ name: 'api-demo-prod', address: 'a', port: 3000, tags: [] });
  assert.equal(await consul.health('api-demo-prod'), 'passing');
  assert.equal(consul.dnsName('api-demo-prod'), 'api-demo-prod.service.consul');
});

// --- M7: deployment workflow ---

const machines: Machine[] = [
  { id: 'm1', name: 'w1', roles: ['worker'], region: 'sg', wgIp: '10.88.0.11', containerSubnet: '10.210.1.0/24', cpuAvailable: 4, memoryMbAvailable: 8000, online: true },
  { id: 'm2', name: 'w2', roles: ['worker'], region: 'sg', wgIp: '10.88.0.12', containerSubnet: '10.210.2.0/24', cpuAvailable: 4, memoryMbAvailable: 8000, online: true },
];
const webService: ServiceSpec = { name: 'api', image: 'x', type: 'web', replicas: 2, port: 3000, cpu: 250, memoryMb: 256, healthPath: '/health' };
const placement: PlacementDecision = { service: 'api', machineIds: ['m1', 'm2'], warnings: [] };

function baseInput(over: Partial<DeployInput> = {}): DeployInput {
  return {
    project: 'demo',
    environment: 'prod',
    service: webService,
    machines,
    placement,
    release: 'r2',
    image: 'demo-api:r2',
    nomad: new MockNomadProvider(),
    consul: new MockConsulProvider(),
    zeroDowntime: true,
    previous: { release: 'r1' },
    ...over,
  };
}

test('healthy two-replica deploy goes live and drains the old release', async () => {
  const result = await orchestrateDeployment(baseInput());
  assert.equal(result.status, 'deployed');
  assert.equal(result.serving, 'r2');
  assert.ok(result.steps.find((s) => s.name === 'drain-old-release' && s.status === 'ok'));
});

test('zero-downtime is blocked for a single-replica service (no traffic touched)', async () => {
  const result = await orchestrateDeployment(
    baseInput({ service: { ...webService, replicas: 1 }, placement: { service: 'api', machineIds: ['m1'], warnings: [] } }),
  );
  assert.equal(result.status, 'blocked');
  assert.equal(result.serving, 'r1'); // old release still serving
});

test('broken release (unhealthy allocs) does NOT steal traffic and auto-reverts', async () => {
  const nomad = new MockNomadProvider();
  nomad.failImages.add('demo-api:r2'); // new release is broken
  const result = await orchestrateDeployment(baseInput({ nomad }));
  assert.equal(result.status, 'reverted');
  assert.equal(result.serving, 'r1'); // old release kept serving
  assert.ok(result.steps.find((s) => s.name === 'auto-revert'));
});

test('broken release detected by Consul health also reverts', async () => {
  const consul = new MockConsulProvider();
  consul.setHealth('api-demo-prod', 'critical'); // allocs run but health fails
  const result = await orchestrateDeployment(baseInput({ consul }));
  assert.equal(result.status, 'reverted');
  assert.equal(result.serving, 'r1');
});

test('rollback redeploys a known-good previous release', async () => {
  const result = await rollbackDeployment({
    project: 'demo',
    environment: 'prod',
    service: webService,
    machines,
    placement,
    nomad: new MockNomadProvider(),
    consul: new MockConsulProvider(),
    zeroDowntime: true,
    toRelease: 'r1',
    toImage: 'demo-api:r1',
    current: { release: 'r2' },
  });
  assert.equal(result.status, 'deployed');
  assert.equal(result.serving, 'r1');
});
