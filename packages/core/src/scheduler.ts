import type { Machine, NetworkPath, PlacementDecision, PlacementInput } from './models.ts';

const PENALTY_OFFLINE = 1_000_000;
const PENALTY_UNDER_RESOURCE = 100_000;
const PENALTY_ROLE_MISS = 50_000;
const PENALTY_AVOID_ROLE = 10_000;
const PENALTY_SAME_MACHINE_REPLICA = 8_000;

function pathScore(machine: Machine, input: PlacementInput): number {
  const dependencies = input.service.dependencies ?? [];
  if (dependencies.length === 0 || !input.paths || !input.existingPlacements) return 0;

  let score = 0;
  for (const dep of dependencies) {
    const placed = input.existingPlacements[dep.service] ?? [];
    if (placed.length === 0) continue;

    const best = placed
      .map((depMachineId) => findPath(input.paths!, machine.id, depMachineId)?.rttMs ?? 500)
      .sort((a, b) => a - b)[0];

    score += dep.latencySensitive ? best * 10 : best;
  }

  return score;
}

function findPath(paths: NetworkPath[], a: string, b: string): NetworkPath | undefined {
  return paths.find((p) => (p.from === a && p.to === b) || (p.from === b && p.to === a));
}

function baseScore(machine: Machine, input: PlacementInput, alreadyChosen: Set<string>): number {
  let score = 0;

  if (!machine.online) score += PENALTY_OFFLINE;
  if (machine.cpuAvailable < input.service.cpu || machine.memoryMbAvailable < input.service.memoryMb) {
    score += PENALTY_UNDER_RESOURCE;
  }

  for (const role of input.service.requiredRoles ?? []) {
    if (!machine.roles.includes(role)) score += PENALTY_ROLE_MISS;
  }

  for (const role of input.service.avoidRoles ?? []) {
    if (machine.roles.includes(role)) score += PENALTY_AVOID_ROLE;
  }

  if (alreadyChosen.has(machine.id)) score += PENALTY_SAME_MACHINE_REPLICA;

  score -= machine.cpuAvailable * 5;
  score -= machine.memoryMbAvailable / 256;
  score += pathScore(machine, input);

  return score;
}

export function choosePlacements(input: PlacementInput): PlacementDecision {
  const warnings: string[] = [];
  const chosen = new Set<string>();
  const machineIds: string[] = [];

  for (let i = 0; i < input.service.replicas; i++) {
    const ranked = [...input.machines]
      .map((machine) => ({ machine, score: baseScore(machine, input, chosen) }))
      .sort((a, b) => a.score - b.score);

    const best = ranked[0];
    if (!best || best.score >= PENALTY_UNDER_RESOURCE) {
      warnings.push(`Replica ${i + 1} could not be placed on a healthy machine with enough resources.`);
      break;
    }

    chosen.add(best.machine.id);
    machineIds.push(best.machine.id);
  }

  if (machineIds.length < input.service.replicas) {
    warnings.push(`Requested ${input.service.replicas} replicas but placed ${machineIds.length}.`);
  }

  if (new Set(machineIds).size < machineIds.length) {
    warnings.push('Some replicas are on the same machine; zero-downtime failover is weaker.');
  }

  return {
    service: input.service.name,
    machineIds,
    warnings,
  };
}
