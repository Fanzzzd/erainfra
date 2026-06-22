import { hostname, platform, arch, cpus, totalmem, networkInterfaces, uptime } from 'node:os';

// Real facts about THIS machine — the node the control plane actually runs on. Lets the
// dashboard show at least one genuinely-real fabric node (this laptop/server) instead of only
// demo peers. Everything here is read live from the OS.

export interface HostInfo {
  hostname: string;
  platform: string;
  arch: string;
  cpus: number;
  memoryGb: number;
  lanIp: string | null;
  uptimeHours: number;
}

// First non-internal IPv4 — the address this machine is actually reachable at on its LAN.
export function primaryLanIp(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

// Optional OS facts can throw in locked-down sandboxes/containers (e.g. os.uptime() EPERM).
// Listing THIS machine must never 500 over a missing convenience field, so each probe falls back.
function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export function hostInfo(): HostInfo {
  return {
    hostname: safe(hostname, 'unknown'),
    platform: safe(platform, 'unknown'),
    arch: safe(arch, 'unknown'),
    cpus: safe(() => cpus().length, 0),
    memoryGb: safe(() => Math.round((totalmem() / 1024 ** 3) * 10) / 10, 0),
    lanIp: safe(primaryLanIp, null),
    uptimeHours: safe(() => Math.round((uptime() / 3600) * 10) / 10, 0),
  };
}
