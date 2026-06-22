import type { MachineRole, NetworkPath, WireGuardPeer } from '../../../../packages/core/src/index.ts';

export interface EnrollMachineInput {
  name: string;
  roles: MachineRole[];
  region: string;
  publicKey: string;
}

export interface EnrolledMachine {
  id: string;
  name: string;
  roles: MachineRole[];
  region: string;
  wgIp: string; // 10.88.0.x
  containerSubnet: string; // 10.210.x.0/24
  publicKey: string;
}

// Swappable network backend. NetmakerNetworkProvider is the MVP; a future custom
// wg-orchestrator implements the same interface. The control plane only knows this.
export interface NetworkProvider {
  enrollMachine(input: EnrollMachineInput): Promise<EnrolledMachine>;
  revokeMachine(machineId: string): Promise<void>;
  rotateKey(machineId: string, newPublicKey: string): Promise<EnrolledMachine>;
  // Roles are metadata assigned after enrollment (a machine can carry several); empty clears them.
  setRoles(machineId: string, roles: MachineRole[]): Promise<EnrolledMachine>;
  listMachines(): Promise<EnrolledMachine[]>;
  // Peer list for a machine: every other peer, routing both its node IP and container subnet.
  peersFor(machineId: string): Promise<WireGuardPeer[]>;
  recordPath(path: NetworkPath): Promise<void>;
  pathMatrix(): Promise<NetworkPath[]>;
  bestPath(from: string, to: string): Promise<NetworkPath | undefined>;
}

// Path priority — lower is better (same order as the WireGuard renderer / docs).
const PATH_RANK: Record<NetworkPath['kind'], number> = {
  'same-machine': 0,
  'lan-direct': 1,
  'public-ipv6-direct': 2,
  'public-ipv4-direct': 3,
  'nat-punched-direct': 4,
  'regional-relay': 5,
  'cloudflare-mesh-fallback': 6,
};

export function comparePaths(a: NetworkPath, b: NetworkPath): number {
  if (PATH_RANK[a.kind] !== PATH_RANK[b.kind]) return PATH_RANK[a.kind] - PATH_RANK[b.kind];
  return a.rttMs - b.rttMs;
}
