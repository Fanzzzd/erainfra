import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// MeshManager wires NAT'd machines together with iroh (via the `dumbpipe` CLI) so a service on
// one box (e.g. Postgres) is reachable from another with NO public IP and NO account: peers dial
// each other by a cryptographic node ticket (Ed25519 key), and iroh hole-punches or falls back to
// a relay automatically. We spawn `dumbpipe` as a sidecar — exactly like cloudflared in
// QuickTunnelManager — so there's no Rust to embed and the pattern matches the rest of the codebase.
//
// One link has two halves, on two machines:
//  - share(port):    `dumbpipe listen-tcp --host 127.0.0.1:<port>` on the box that HAS the service.
//                    It prints a ticket; hand that ticket to the other box.
//  - connect(t, lp): `dumbpipe connect-tcp --addr 127.0.0.1:<lp> <ticket>` on the box that WANTS
//                    the service; it appears on local 127.0.0.1:<lp> as transparent TCP.
//
// ponytail: default relay is iroh's public one (no account, no signup). To go fully self-hosted,
// set IROH_RELAY_URL in the process env to your own iroh-relay (which can ride a Cloudflare tunnel);
// dumbpipe inherits it. No code change needed.

// Pure argv (no shell). Tested without spawning.
export function buildShareArgs(port: number): string[] {
  return ['listen-tcp', '--host', `127.0.0.1:${port}`];
}

export function buildConnectArgs(ticket: string, localPort: number): string[] {
  return ['connect-tcp', '--addr', `127.0.0.1:${localPort}`, ticket];
}

// Pure: pull the node ticket dumbpipe prints once it's listening. dumbpipe echoes a ready-to-run
// `dumbpipe connect-tcp <ticket>` line; we take that token, else fall back to the first long
// base32 run on its own. Null until a ticket appears.
const AFTER_CONNECT_RE = /connect(?:-tcp)?\s+([a-z2-7]{48,})/i;
const BARE_TICKET_RE = /\b([a-z2-7]{64,})\b/i;
export function parseTicket(text: string): string | null {
  return text.match(AFTER_CONNECT_RE)?.[1] ?? text.match(BARE_TICKET_RE)?.[1] ?? null;
}

// Stable identity: a shared service's iroh NodeId must survive restarts so the other box can keep
// using the same ticket. We persist a 32-byte secret per link name and pass it via IROH_SECRET;
// iroh derives the same NodeId from it every time. (The ticket's address hints still change run to
// run, but iroh re-resolves the live address by NodeId through the relay, so an older ticket still
// connects.) Without this, every restart re-keys the box and you'd have to redistribute the ticket.
function meshStateDir(): string {
  return process.env.PORTLESS_STATE_DIR ?? join(homedir(), '.portless', 'mesh');
}

export function persistentSecret(name: string, dir = meshStateDir()): string {
  const file = join(dir, `${name}.key`);
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    const secret = randomBytes(32).toString('hex'); // iroh secret = 32 bytes / 64 hex chars
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, secret, { mode: 0o600 });
    return secret;
  }
}

export interface MeshLink {
  name: string;
  role: 'share' | 'connect';
  // share: the local service port being exposed. connect: the local port the remote is forwarded to.
  port: number;
  // share: the ticket to hand out. connect: the ticket we dialed.
  ticket: string;
  startedAt: string;
}

interface Entry {
  proc: ChildProcess;
  info: MeshLink;
}

export class MeshManager {
  private entries = new Map<string, Entry>();

  list(): MeshLink[] {
    return [...this.entries.values()].map((e) => ({ ...e.info }));
  }

  get(name: string): MeshLink | undefined {
    const e = this.entries.get(name);
    return e ? { ...e.info } : undefined;
  }

  // Expose local 127.0.0.1:<port> on the mesh; resolve with the ticket to hand to the other box.
  // Mirrors QuickTunnelManager.publish: keep the child so drop() can kill it; self-heal on exit.
  async share(name: string, port: number, timeoutMs = 30_000): Promise<MeshLink> {
    if (this.entries.has(name)) throw new Error(`link already exists: ${name}`);
    // Pin a stable NodeId for this service so its ticket stays valid across restarts.
    const child = this.spawnDumbpipe(buildShareArgs(port), { IROH_SECRET: persistentSecret(name) });
    return await new Promise<MeshLink>((resolve, reject) => {
      let buf = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        reject(new Error(`timed out after ${timeoutMs}ms waiting for the mesh ticket`));
      }, timeoutMs);
      const onData = (d: Buffer) => {
        if (settled) return;
        buf += d.toString();
        const ticket = parseTicket(buf);
        if (!ticket) return;
        settled = true;
        clearTimeout(timer);
        const info: MeshLink = { name, role: 'share', port, ticket, startedAt: new Date().toISOString() };
        this.register(name, child, info);
        resolve(info);
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      this.rejectOnEarlyExit(child, () => settled, (e) => { settled = true; clearTimeout(timer); reject(e); }, 'a ticket');
    });
  }

  // Dial a remote ticket and surface it on local 127.0.0.1:<localPort>. dumbpipe binds the local
  // listener at startup, so if the process is still alive after a short settle it's ready; if the
  // ticket is bad it exits fast and we reject.
  // ponytail: settle-timer readiness, not a parsed "listening" line — survives dumbpipe output
  // changes. Upgrade to parse a real ready marker if a version emits one we can rely on.
  async connect(name: string, ticket: string, localPort: number, settleMs = 1500): Promise<MeshLink> {
    if (this.entries.has(name)) throw new Error(`link already exists: ${name}`);
    const child = this.spawnDumbpipe(buildConnectArgs(ticket, localPort));
    return await new Promise<MeshLink>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const info: MeshLink = { name, role: 'connect', port: localPort, ticket, startedAt: new Date().toISOString() };
        this.register(name, child, info);
        resolve(info);
      }, settleMs);
      this.rejectOnEarlyExit(child, () => settled, (e) => { settled = true; clearTimeout(timer); reject(e); }, 'the local listener');
    });
  }

  async drop(name: string): Promise<boolean> {
    const e = this.entries.get(name);
    if (!e) return false;
    this.entries.delete(name);
    try {
      e.proc.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    return true;
  }

  async stopAll(): Promise<void> {
    for (const name of [...this.entries.keys()]) await this.drop(name);
  }

  private spawnDumbpipe(args: string[], env?: Record<string, string>): ChildProcess {
    try {
      // argv only (no shell); stdin closed so dumbpipe doesn't wait on it.
      return spawn('dumbpipe', args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    } catch (e) {
      throw new Error(`could not start dumbpipe: ${(e as Error).message}`);
    }
  }

  // Record a live link and forget it if its process later dies (unless it was already replaced).
  private register(name: string, child: ChildProcess, info: MeshLink) {
    this.entries.set(name, { proc: child, info });
    child.on('exit', () => {
      if (this.entries.get(name)?.proc === child) this.entries.delete(name);
    });
  }

  // Shared reject wiring: a spawn 'error' or an exit before we've settled is a startup failure.
  private rejectOnEarlyExit(child: ChildProcess, isSettled: () => boolean, fail: (e: Error) => void, waitingFor: string) {
    child.on('error', (e) => {
      if (isSettled()) return;
      fail(new Error(`dumbpipe failed to start: ${e.message}`));
    });
    child.on('exit', (code) => {
      if (isSettled()) return;
      fail(new Error(`dumbpipe exited (${code}) before ${waitingFor} was ready`));
    });
  }
}
