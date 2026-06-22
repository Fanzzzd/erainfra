import { spawn, type ChildProcess } from 'node:child_process';

// QuickTunnelManager exposes a locally-running app on a public https URL by wrapping
// `cloudflared tunnel --url http://127.0.0.1:<port>`. These are Cloudflare "quick tunnels":
// account-less, ephemeral *.trycloudflare.com URLs that need NO login, NO DNS, and NO open
// ports — so they're safe to start without touching the user's real Cloudflare account.
// This is the chain that makes Portless a real single-machine PaaS: deploy → publish → live.

// Pure: the cloudflared argv for a quick tunnel to a local port. Tested without spawning.
export function buildQuickTunnelArgs(port: number): string[] {
  return ['tunnel', '--url', `http://127.0.0.1:${port}`];
}

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

// Pure: extract the public URL cloudflared prints once the quick tunnel is up. Null until it appears.
export function parseQuickTunnelUrl(text: string): string | null {
  return text.match(URL_RE)?.[0] ?? null;
}

export interface QuickTunnel {
  name: string;
  port: number;
  url: string;
  startedAt: string;
}

interface Entry {
  proc: ChildProcess;
  info: QuickTunnel;
}

export class QuickTunnelManager {
  private entries = new Map<string, Entry>();

  list(): QuickTunnel[] {
    return [...this.entries.values()].map((e) => ({ ...e.info }));
  }

  get(name: string): QuickTunnel | undefined {
    const e = this.entries.get(name);
    return e ? { ...e.info } : undefined;
  }

  // Spawn a quick tunnel and resolve once cloudflared prints the public URL. Rejects on timeout
  // or if cloudflared exits before a URL appears. The child is kept so unpublish() can kill it;
  // if it dies on its own later, its entry is dropped so list()/get() stay honest.
  async publish(name: string, port: number, timeoutMs = 30_000): Promise<QuickTunnel> {
    if (this.entries.has(name)) throw new Error(`already published: ${name}`);
    let child: ChildProcess;
    try {
      // argv only (no shell); stdin closed; cloudflared logs the URL to stderr.
      child = spawn('cloudflared', buildQuickTunnelArgs(port), { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      throw new Error(`could not start cloudflared: ${(e as Error).message}`);
    }
    return await new Promise<QuickTunnel>((resolve, reject) => {
      let buf = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        reject(new Error(`timed out after ${timeoutMs}ms waiting for the quick tunnel URL`));
      }, timeoutMs);
      const onData = (d: Buffer) => {
        if (settled) return;
        buf += d.toString();
        const url = parseQuickTunnelUrl(buf);
        if (!url) return;
        settled = true;
        clearTimeout(timer);
        const info: QuickTunnel = { name, port, url, startedAt: new Date().toISOString() };
        this.entries.set(name, { proc: child, info });
        // Self-heal: if this tunnel process dies, forget it (unless it was already replaced).
        child.on('exit', () => {
          if (this.entries.get(name)?.proc === child) this.entries.delete(name);
        });
        resolve(info);
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.on('error', (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`cloudflared failed to start: ${e.message}`));
      });
      child.on('exit', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`cloudflared exited (${code}) before a public URL appeared`));
      });
    });
  }

  async unpublish(name: string): Promise<boolean> {
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
    for (const name of [...this.entries.keys()]) await this.unpublish(name);
  }
}
