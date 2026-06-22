import type { Machine, PlacementDecision, ServiceSpec } from './models.ts';

export interface ZeroDowntimeReport {
  ready: boolean;
  score: number;
  blockers: string[];
  warnings: string[];
}

export function evaluateZeroDowntime(input: {
  service: ServiceSpec;
  placement: PlacementDecision;
  machines: Machine[];
}): ZeroDowntimeReport {
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (input.service.type !== 'web') {
    warnings.push('Zero-downtime checks are optimized for web/API services; workers and stateful services need custom drain logic.');
  }

  if (input.service.type === 'database') {
    blockers.push('Database services are stateful and cannot be treated as automatically zero-downtime without a database-specific HA plan.');
  }

  if (input.service.replicas < 2) {
    blockers.push('At least two replicas are required for zero-downtime deployment and node failover.');
  }

  if (!input.service.healthPath && input.service.type === 'web') {
    blockers.push('A readiness health path is required before Portless can safely add a new replica to traffic.');
  }

  const uniqueMachines = new Set(input.placement.machineIds);
  if (uniqueMachines.size < input.service.replicas) {
    blockers.push('Replicas must be spread across unique machines for node-level failover.');
  }

  const placedMachines = input.placement.machineIds
    .map((machineId) => input.machines.find((machine) => machine.id === machineId))
    .filter(Boolean) as Machine[];

  if (placedMachines.length < input.service.replicas) {
    blockers.push('Not all requested replicas are placed on known machines.');
  }

  if (placedMachines.some((machine) => !machine.online)) {
    blockers.push('At least one placed machine is offline.');
  }

  if (placedMachines.some((machine) => machine.roles.includes('edge'))) {
    warnings.push('At least one replica is on an edge machine; use this only for non-critical workloads or extra capacity.');
  }

  const score = Math.max(0, 100 - blockers.length * 30 - warnings.length * 8);
  return {
    ready: blockers.length === 0,
    score,
    blockers,
    warnings,
  };
}
