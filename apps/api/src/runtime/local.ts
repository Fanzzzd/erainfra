import { spawn, type ChildProcess } from 'node:child_process';
import { openSync, readFileSync, existsSync, mkdirSync, statSync, readSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// LocalRuntime manages REAL OS processes on this machine — the "this machine" runtime
// for managing running projects without a cluster. It spawns argv directly (never a
// shell), captures logs to disk, and does real HTTP health checks.
// ponytail: children are tied to the control-plane process and tracked in memory; for
// persistence across restarts run under launchd/systemd or the Docker adapter (same interface).

export interface LocalServiceSpec {
  name: string; // must be a portless-managed name
  command: string;
  args?: string[];
  port?: number;
  healthPath?: string;
  cwd?: string;
  env?: Record<string, string>;
}

export interface RunningProcess {
  name: string;
  pid: number;
  port?: number;
  healthPath?: string;
  status: 'running' | 'exited';
  exitCode?: number | null;
  startedAt: string;
  command: string;
  logFile: string;
}

interface Entry {
  proc: ChildProcess;
  meta: RunningProcess;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export class LocalRuntime {
  // Cap on how many trailing bytes of a log file we ever read into memory for a logs() call.
  private static readonly MAX_TAIL_BYTES = 256 * 1024;
  private entries = new Map<string, Entry>();
  private dir: string;

  constructor(dir = join(tmpdir(), 'portless-runtime')) {
    this.dir = dir;
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
  }

  deploy(spec: LocalServiceSpec): RunningProcess {
    if (!NAME_RE.test(spec.name)) throw new Error(`invalid name: ${spec.name}`);
    if (this.entries.get(spec.name)?.meta.status === 'running') {
      throw new Error(`already running: ${spec.name}`);
    }
    const logFile = join(this.dir, `${spec.name}.log`);
    const fd = openSync(logFile, 'a');
    const proc = spawn(spec.command, spec.args ?? [], {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdio: ['ignore', fd, fd], // argv only — no shell, no injection
      detached: false,
    });
    const meta: RunningProcess = {
      name: spec.name,
      pid: proc.pid ?? -1,
      port: spec.port,
      healthPath: spec.healthPath,
      status: 'running',
      startedAt: new Date().toISOString(),
      command: [spec.command, ...(spec.args ?? [])].join(' '),
      logFile,
    };
    const entry: Entry = { proc, meta };
    proc.on('exit', (code) => {
      meta.status = 'exited';
      meta.exitCode = code;
    });
    proc.on('error', () => {
      meta.status = 'exited';
      meta.exitCode = -1;
    });
    this.entries.set(spec.name, entry);
    return meta;
  }

  list(): RunningProcess[] {
    return [...this.entries.values()].map((e) => ({ ...e.meta }));
  }

  get(name: string): RunningProcess | undefined {
    const e = this.entries.get(name);
    return e ? { ...e.meta } : undefined;
  }

  // Drop an EXITED process from the list so it stops cluttering the Apps view. Refuses to forget a
  // still-running process (stop it first) — that would orphan the child instead of removing a record.
  forget(name: string): boolean {
    const e = this.entries.get(name);
    if (!e || e.meta.status === 'running') return false;
    this.entries.delete(name);
    return true;
  }

  // Tail the last N lines without reading the whole file: a noisy long-running process can grow a
  // multi-GB log, so we only ever read the final MAX_TAIL_BYTES from disk into memory.
  logs(name: string, lines = 100): string[] {
    const e = this.entries.get(name);
    if (!e) throw new Error(`unknown process: ${name}`);
    if (!existsSync(e.meta.logFile)) return [];
    const cap = Math.min(Math.max(lines, 1), 1000);
    const { size } = statSync(e.meta.logFile);
    const start = Math.max(0, size - LocalRuntime.MAX_TAIL_BYTES);
    const fd = openSync(e.meta.logFile, 'r');
    try {
      const buf = Buffer.allocUnsafe(size - start);
      readSync(fd, buf, 0, buf.length, start);
      const arr = buf.toString('utf8').split('\n').filter(Boolean);
      // If we started mid-file, the first slice may be a partial line — drop it.
      return (start > 0 ? arr.slice(1) : arr).slice(-cap);
    } finally {
      closeSync(fd);
    }
  }

  // Resolves only once the process has actually exited (SIGTERM, then SIGKILL after a grace
  // period if it ignores the signal). Awaiting this makes a fast redeploy of the same name safe.
  async stop(name: string, graceMs = 3000): Promise<void> {
    const e = this.entries.get(name);
    if (!e) throw new Error(`unknown process: ${name}`);
    if (e.meta.status !== 'running' || e.proc.exitCode !== null) {
      e.meta.status = 'exited';
      return;
    }
    const exited = new Promise<void>((resolve) => e.proc.once('exit', () => resolve()));
    try {
      e.proc.kill('SIGTERM');
    } catch {
      e.meta.status = 'exited';
      return;
    }
    const killer = setTimeout(() => {
      try {
        e.proc.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, graceMs);
    await exited;
    clearTimeout(killer);
    e.meta.status = 'exited';
  }

  async health(name: string, timeoutMs = 1000): Promise<'passing' | 'critical' | 'unknown'> {
    const e = this.entries.get(name);
    if (!e) throw new Error(`unknown process: ${name}`);
    if (e.meta.status !== 'running') return 'critical';
    if (!e.meta.port) return 'unknown';
    const url = `http://127.0.0.1:${e.meta.port}${e.meta.healthPath ?? '/'}`;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ac.signal });
      return res.ok ? 'passing' : 'critical';
    } catch {
      return 'critical';
    } finally {
      clearTimeout(t);
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((name) => this.stop(name).catch(() => {})));
  }
}

// Deployable templates — one-click real projects for the dashboard. Each renders to argv.
export interface AppTemplate {
  id: string;
  label: string;
  description: string;
  build(port: number): Omit<LocalServiceSpec, 'name'>;
}

export const APP_TEMPLATES: AppTemplate[] = [
  {
    id: 'static-web',
    label: 'Static web server',
    description: 'A real HTTP server (Node) serving a hello page on the chosen port.',
    build: (port) => ({
      command: process.execPath, // node
      args: [
        '-e',
        `require('http').createServer((q,s)=>{if(q.url==='/health'){s.writeHead(200);return s.end('ok')}s.writeHead(200,{'content-type':'text/html'});s.end('<h1>Portless local app</h1><p>Running on port '+${port}+'</p>')}).listen(${port},()=>console.log('listening on ${port}'))`,
      ],
      port,
      healthPath: '/health',
    }),
  },
];

export function buildFromTemplate(templateId: string, name: string, port: number): LocalServiceSpec {
  const tpl = APP_TEMPLATES.find((t) => t.id === templateId);
  if (!tpl) throw new Error(`unknown template: ${templateId}`);
  return { name, ...tpl.build(port) };
}
