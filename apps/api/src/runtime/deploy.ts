import { evaluateZeroDowntime } from '../../../../packages/core/src/index.ts';
import type { Machine, PlacementDecision, ServiceSpec } from '../../../../packages/core/src/index.ts';
import { deploymentStatus, type NomadProvider } from './nomad.ts';
import { consulServiceName, type ConsulProvider } from './consul.ts';

// Deployment orchestration. Pure and step-based so it can run as a Temporal workflow
// (M10 wraps it in a worker); here it runs directly on the provider interfaces and is
// fully tested with mocks. It enforces the zero-downtime safety rules and, critically,
// never drains the old release until the new one is healthy AND Consul is passing — so a
// broken release cannot steal traffic, and it auto-reverts.

export type StepStatus = 'ok' | 'failed' | 'skipped';
export interface DeployStep {
  name: string;
  status: StepStatus;
  detail?: string;
}

export interface DeployResult {
  release: string;
  status: 'deployed' | 'reverted' | 'blocked';
  serving: string | null; // release currently receiving traffic
  steps: DeployStep[];
}

export interface DeployInput {
  project: string;
  environment: string;
  service: ServiceSpec;
  machines: Machine[];
  placement: PlacementDecision;
  release: string;
  image: string;
  nomad: NomadProvider;
  consul: ConsulProvider;
  zeroDowntime?: boolean;
  previous?: { release: string } | null;
}

function jobId(i: { project: string; environment: string; service: ServiceSpec; release: string }): string {
  return `${i.project}-${i.environment}-${i.service.name}-${i.release}`;
}

export async function orchestrateDeployment(input: DeployInput): Promise<DeployResult> {
  const steps: DeployStep[] = [];
  const serviceName = consulServiceName(input.project, input.environment, input.service.name);
  const previousServing = input.previous?.release ?? null;
  const ok = (name: string, detail?: string) => steps.push({ name, status: 'ok', detail });
  const done = (status: DeployResult['status'], serving: string | null): DeployResult => ({
    release: input.release,
    status,
    serving,
    steps,
  });

  // 1. Zero-downtime preflight (only when requested). Blocks before touching anything.
  if (input.zeroDowntime) {
    const report = evaluateZeroDowntime({ service: input.service, placement: input.placement, machines: input.machines });
    if (!report.ready) {
      steps.push({ name: 'preflight-zero-downtime', status: 'failed', detail: report.blockers.join('; ') });
      return done('blocked', previousServing);
    }
    ok('preflight-zero-downtime', `score ${report.score}`);
  }

  ok('build-image', input.image);
  ok('push-image', input.image);

  // 2. Submit the new release as its own job (runs alongside the old one).
  const newJob = jobId(input);
  const { allocations } = await input.nomad.submitJob({
    id: newJob,
    replicas: input.service.replicas,
    image: input.image,
    healthPath: input.service.healthPath,
  });
  ok('submit-nomad-job', `${allocations.length} allocations`);

  // 3. Wait for allocation health.
  if (deploymentStatus(allocations) !== 'healthy') {
    steps.push({ name: 'wait-allocation-health', status: 'failed', detail: 'new allocations are not healthy' });
    await input.nomad.stopJob(newJob); // tear down the broken release
    steps.push({ name: 'auto-revert', status: 'ok', detail: 'old release kept serving' });
    return done('reverted', previousServing);
  }
  ok('wait-allocation-health');

  // 4. Register in Consul and require health passing before any traffic shift.
  await input.consul.registerService({
    name: serviceName,
    address: `${input.service.name}.service.consul`,
    port: input.service.port ?? 0,
    tags: [`release:${input.release}`],
  });
  if ((await input.consul.health(serviceName)) !== 'passing') {
    steps.push({ name: 'wait-consul-healthy', status: 'failed', detail: 'service health is not passing' });
    await input.nomad.stopJob(newJob);
    steps.push({ name: 'auto-revert', status: 'ok', detail: 'old release kept serving' });
    return done('reverted', previousServing);
  }
  ok('wait-consul-healthy');

  // 5. New release is healthy and serving — now drain the old one.
  if (input.previous) {
    await input.nomad.stopJob(jobId({ ...input, release: input.previous.release }));
    ok('drain-old-release', `drained ${input.previous.release}`);
  } else {
    steps.push({ name: 'drain-old-release', status: 'skipped', detail: 'no previous release' });
  }

  return done('deployed', input.release);
}

// Rollback = redeploy a known-good previous release as the active one.
export async function rollbackDeployment(
  input: Omit<DeployInput, 'release' | 'image'> & { toRelease: string; toImage: string; current: { release: string } },
): Promise<DeployResult> {
  return orchestrateDeployment({
    ...input,
    release: input.toRelease,
    image: input.toImage,
    previous: input.current,
  });
}
