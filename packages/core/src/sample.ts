import type { AppSpec, Machine, NetworkPath } from './models.ts';

export const sampleMachines: Machine[] = [
  {
    id: 'machine-a',
    name: 'sg-core-1',
    roles: ['gateway', 'worker'],
    region: 'sg',
    wgIp: '10.88.0.10',
    containerSubnet: '10.210.0.0/24',
    cpuAvailable: 2000,
    memoryMbAvailable: 4096,
    online: true,
  },
  {
    id: 'machine-b',
    name: 'sg-db-1',
    roles: ['database', 'worker'],
    region: 'sg',
    wgIp: '10.88.0.11',
    containerSubnet: '10.210.1.0/24',
    cpuAvailable: 1500,
    memoryMbAvailable: 8192,
    online: true,
  },
  {
    id: 'machine-c',
    name: 'home-edge-1',
    roles: ['edge', 'worker'],
    region: 'sg-home',
    wgIp: '10.88.0.12',
    containerSubnet: '10.210.2.0/24',
    cpuAvailable: 1200,
    memoryMbAvailable: 2048,
    online: true,
  },
];

export const samplePaths: NetworkPath[] = [
  {
    from: 'machine-a',
    to: 'machine-b',
    kind: 'lan-direct',
    rttMs: 2,
    throughputMbps: 940,
    endpoint: '192.168.10.11:51820',
  },
  {
    from: 'machine-a',
    to: 'machine-c',
    kind: 'nat-punched-direct',
    rttMs: 24,
    throughputMbps: 320,
    endpoint: '203.0.113.44:51820',
  },
  {
    from: 'machine-b',
    to: 'machine-c',
    kind: 'regional-relay',
    rttMs: 35,
    throughputMbps: 280,
    endpoint: 'relay-sg.example.com:51820',
    relayId: 'relay-sg',
  },
];

export const sampleApp: AppSpec = {
  project: 'demo-shop',
  environment: 'prod',
  services: [
    {
      name: 'postgres',
      image: 'postgres:16-alpine',
      type: 'database',
      replicas: 1,
      port: 5432,
      cpu: 500,
      memoryMb: 1024,
      requiredRoles: ['database'],
    },
    {
      name: 'api',
      image: 'ghcr.io/example/demo-api:sha-abc123',
      type: 'web',
      replicas: 2,
      port: 3000,
      cpu: 250,
      memoryMb: 256,
      healthPath: '/health',
      dependencies: [{ service: 'postgres', latencySensitive: true }],
      avoidRoles: ['edge'],
    },
  ],
  domains: [{ hostname: 'api.example.com', service: 'api' }],
};
