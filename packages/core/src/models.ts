export type MachineRole = 'gateway' | 'worker' | 'database' | 'edge' | 'relay';

export interface Machine {
  id: string;
  name: string;
  roles: MachineRole[];
  region: string;
  wgIp: string;
  containerSubnet: string;
  cpuAvailable: number;
  memoryMbAvailable: number;
  online: boolean;
  labels?: Record<string, string>;
}

export interface Dependency {
  service: string;
  latencySensitive?: boolean;
}

export interface ServiceSpec {
  name: string;
  image: string;
  type: 'web' | 'worker' | 'cron' | 'database';
  replicas: number;
  port?: number;
  cpu: number;
  memoryMb: number;
  healthPath?: string;
  dependencies?: Dependency[];
  requiredRoles?: MachineRole[];
  avoidRoles?: MachineRole[];
}

export interface AppSpec {
  project: string;
  environment: string;
  services: ServiceSpec[];
  domains?: Array<{
    hostname: string;
    service: string;
  }>;
}

export type PathKind =
  | 'same-machine'
  | 'lan-direct'
  | 'public-ipv6-direct'
  | 'public-ipv4-direct'
  | 'nat-punched-direct'
  | 'regional-relay'
  | 'cloudflare-mesh-fallback';

export interface NetworkPath {
  from: string;
  to: string;
  kind: PathKind;
  rttMs: number;
  throughputMbps: number;
  endpoint?: string;
  relayId?: string;
}

export interface PlacementInput {
  machines: Machine[];
  service: ServiceSpec;
  existingPlacements?: Record<string, string[]>;
  paths?: NetworkPath[];
}

export interface PlacementDecision {
  service: string;
  machineIds: string[];
  warnings: string[];
}

export interface WireGuardPeer {
  machineId: string;
  publicKey: string;
  endpoint?: string;
  allowedIps: string[];
  persistentKeepalive?: number;
}

export interface WireGuardNodeConfig {
  privateKey: string;
  address: string;
  listenPort: number;
  peers: WireGuardPeer[];
}
