import type { Machine, NetworkPath, WireGuardNodeConfig, WireGuardPeer } from './models.ts';

export interface KeyringEntry {
  machineId: string;
  privateKey: string;
  publicKey: string;
}

export function buildWireGuardConfig(input: {
  self: Machine;
  machines: Machine[];
  keyring: KeyringEntry[];
  paths: NetworkPath[];
  listenPort?: number;
}): WireGuardNodeConfig {
  const selfKey = input.keyring.find((key) => key.machineId === input.self.id);
  if (!selfKey) throw new Error(`Missing WireGuard key for ${input.self.id}`);

  const peers: WireGuardPeer[] = input.machines
    .filter((machine) => machine.id !== input.self.id)
    .map((machine) => {
      const key = input.keyring.find((entry) => entry.machineId === machine.id);
      if (!key) throw new Error(`Missing WireGuard key for ${machine.id}`);

      const path = findFastestPath(input.paths, input.self.id, machine.id);
      return {
        machineId: machine.id,
        publicKey: key.publicKey,
        endpoint: path?.endpoint,
        allowedIps: [`${machine.wgIp}/32`, machine.containerSubnet],
        persistentKeepalive: shouldKeepAlive(path?.kind) ? 25 : undefined,
      };
    });

  return {
    privateKey: selfKey.privateKey,
    address: `${input.self.wgIp}/32`,
    listenPort: input.listenPort ?? 51820,
    peers,
  };
}

function shouldKeepAlive(kind: NetworkPath['kind'] | undefined): boolean {
  return kind === 'nat-punched-direct' || kind === 'regional-relay' || kind === 'cloudflare-mesh-fallback';
}

function findFastestPath(paths: NetworkPath[], a: string, b: string): NetworkPath | undefined {
  return paths
    .filter((p) => (p.from === a && p.to === b) || (p.from === b && p.to === a))
    .sort((left, right) => {
      if (left.kind === right.kind) return left.rttMs - right.rttMs;
      return pathRank(left.kind) - pathRank(right.kind);
    })[0];
}

function pathRank(kind: NetworkPath['kind']): number {
  const order: Record<NetworkPath['kind'], number> = {
    'same-machine': 0,
    'lan-direct': 1,
    'public-ipv6-direct': 2,
    'public-ipv4-direct': 3,
    'nat-punched-direct': 4,
    'regional-relay': 5,
    'cloudflare-mesh-fallback': 6,
  };
  return order[kind];
}

export function renderWireGuardIni(config: WireGuardNodeConfig): string {
  const lines: string[] = [
    '[Interface]',
    `PrivateKey = ${config.privateKey}`,
    `Address = ${config.address}`,
    `ListenPort = ${config.listenPort}`,
    '',
  ];

  for (const peer of config.peers) {
    lines.push('[Peer]');
    lines.push(`# Machine = ${peer.machineId}`);
    lines.push(`PublicKey = ${peer.publicKey}`);
    lines.push(`AllowedIPs = ${peer.allowedIps.join(', ')}`);
    if (peer.endpoint) lines.push(`Endpoint = ${peer.endpoint}`);
    if (peer.persistentKeepalive) lines.push(`PersistentKeepalive = ${peer.persistentKeepalive}`);
    lines.push('');
  }

  return lines.join('\n').trimEnd() + '\n';
}
