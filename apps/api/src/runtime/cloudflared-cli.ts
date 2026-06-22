import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Real Cloudflare Tunnel + domain management by wrapping the locally-installed `cloudflared`
// CLI. We reuse whatever auth the user already has on this machine — the origin cert at
// ~/.cloudflared/cert.pem (from `cloudflared tunnel login`) — so there is NO separate login.
// Commands are argv (never a shell string). Reads (list/info) are safe; writes (create tunnel,
// route dns) are mutating and gated behind confirm at the router layer.

export type CfOp =
  | { op: 'version' }
  | { op: 'list' }
  | { op: 'create'; name: string }
  | { op: 'routeDns'; tunnel: string; hostname: string };

// Pure: turn an operation into cloudflared argv. Tested without spawning anything.
export function buildCloudflaredArgs(op: CfOp): string[] {
  switch (op.op) {
    case 'version':
      return ['--version'];
    case 'list':
      return ['tunnel', 'list', '--output', 'json'];
    case 'create':
      return ['tunnel', 'create', op.name];
    case 'routeDns':
      // Creates a CNAME <hostname> -> <tunnelId>.cfargotunnel.com in the matching zone.
      return ['tunnel', 'route', 'dns', op.tunnel, op.hostname];
  }
}

export interface CfConnection {
  coloName: string;
  openedAt: string;
}
export interface CfTunnel {
  id: string;
  name: string;
  createdAt: string;
  connections: number;
  colos: string[];
  status: 'healthy' | 'inactive';
}

// Pure: parse `cloudflared tunnel list --output json` into our shape. A tunnel with at least
// one live connection is healthy; one with none is provisioned-but-not-running (inactive).
// Throws on unexpected shape rather than masking malformed output as "zero tunnels".
export function parseTunnelList(raw: string): CfTunnel[] {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('unexpected cloudflared output: expected a JSON array');
  const arr = parsed as Array<{
    id: string;
    name: string;
    created_at?: string;
    connections?: Array<{ colo_name?: string; opened_at?: string }> | null;
  }>;
  return arr
    .filter((t) => t && typeof t.id === 'string' && typeof t.name === 'string')
    .map((t) => {
    const conns = t.connections ?? [];
    const colos = [...new Set(conns.map((c) => c.colo_name).filter((c): c is string => !!c))];
    return {
      id: t.id,
      name: t.name,
      createdAt: t.created_at ?? '',
      connections: conns.length,
      colos,
      status: conns.length > 0 ? 'healthy' : 'inactive',
    };
  });
}

// Where cloudflared looks for the account origin cert. Its presence == "logged in".
export function originCertPath(): string {
  return process.env.TUNNEL_ORIGIN_CERT || join(homedir(), '.cloudflared', 'cert.pem');
}

export interface CfStatus {
  installed: boolean;
  authenticated: boolean;
  version: string | null;
  certPath: string;
}

function exec(args: string[], timeoutMs: number): Promise<{ ok: boolean; output: string; code: number | null }> {
  return new Promise((resolve) => {
    let child;
    try {
      // stdin closed (EOF); never inherit a shell.
      child = spawn('cloudflared', args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ ok: false, output: String((e as Error).message), code: null });
    }
    let out = '';
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child!.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, output: String(e.message), code: null });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // cloudflared writes warnings (version-outdated) to stderr; prefer stdout, fall back to stderr.
      const text = (out.trim() || err.trim()) + (timedOut ? `\n[timed out after ${timeoutMs}ms]` : '');
      resolve({ ok: !timedOut && code === 0, output: text, code });
    });
  });
}

export class CloudflaredCli {
  async status(): Promise<CfStatus> {
    const certPath = originCertPath();
    const v = await exec(buildCloudflaredArgs({ op: 'version' }), 5000);
    const version = v.ok ? v.output.split('\n')[0].replace(/^cloudflared version\s*/, '').trim() : null;
    return { installed: v.ok, authenticated: existsSync(certPath), version, certPath };
  }

  async tunnels(): Promise<CfTunnel[]> {
    const r = await exec(buildCloudflaredArgs({ op: 'list' }), 25_000);
    if (!r.ok) throw new Error(`cloudflared tunnel list failed: ${r.output}`);
    // Strip any leading warning lines so JSON.parse sees only the array.
    const start = r.output.indexOf('[');
    if (start < 0) throw new Error('cloudflared returned no JSON array (unexpected output)');
    return parseTunnelList(r.output.slice(start));
  }

  // Returns true iff a tunnel with this exact name already exists — used for create idempotency.
  async exists(name: string): Promise<boolean> {
    return (await this.tunnels()).some((t) => t.name === name);
  }

  async create(name: string): Promise<{ ok: boolean; output: string }> {
    const r = await exec(buildCloudflaredArgs({ op: 'create', name }), 30_000);
    return { ok: r.ok, output: r.output };
  }

  async routeDns(tunnel: string, hostname: string): Promise<{ ok: boolean; output: string }> {
    const r = await exec(buildCloudflaredArgs({ op: 'routeDns', tunnel, hostname }), 30_000);
    return { ok: r.ok, output: r.output };
  }
}
