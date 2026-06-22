// Consul provider for service discovery + health. We do NOT build a custom discovery
// system. MockConsulProvider backs tests; the real one (M10) reads the Consul catalog/health API.

export type HealthStatus = 'passing' | 'warning' | 'critical';

export interface ConsulService {
  name: string;
  address: string;
  port: number;
  tags: string[];
}

export interface ConsulProvider {
  registerService(svc: ConsulService): Promise<void>;
  deregisterService(name: string): Promise<void>;
  listServices(): Promise<ConsulService[]>;
  health(name: string): Promise<HealthStatus>;
  dnsName(name: string): string;
}

// Service naming convention: <service>-<project>-<environment>, resolvable in-cluster
// as <name>.service.consul. Keeping it conventional avoids a custom registry.
export function consulServiceName(project: string, environment: string, service: string): string {
  return `${service}-${project}-${environment}`;
}

export class MockConsulProvider implements ConsulProvider {
  private services = new Map<string, ConsulService>();
  private healthOverride = new Map<string, HealthStatus>();

  // test knob: force a service's health
  setHealth(name: string, status: HealthStatus): void {
    this.healthOverride.set(name, status);
  }

  async registerService(svc: ConsulService): Promise<void> {
    this.services.set(svc.name, svc);
  }
  async deregisterService(name: string): Promise<void> {
    this.services.delete(name);
    this.healthOverride.delete(name);
  }
  async listServices(): Promise<ConsulService[]> {
    return [...this.services.values()];
  }
  async health(name: string): Promise<HealthStatus> {
    return this.healthOverride.get(name) ?? (this.services.has(name) ? 'passing' : 'critical');
  }
  dnsName(name: string): string {
    return `${name}.service.consul`;
  }
}
