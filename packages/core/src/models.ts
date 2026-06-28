export type MachineRole = 'gateway' | 'worker' | 'database' | 'edge' | 'relay';

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
