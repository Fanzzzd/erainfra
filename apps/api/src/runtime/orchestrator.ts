import { spawn } from 'node:child_process';

// Orchestration via locally-installed AI CLIs (Codex, Claude Code). We reuse whatever
// auth those CLIs already have on this machine — no separate login. Commands are built
// as argv (never a shell string). Default mode is read-only/plan so nothing is mutated
// without an explicit execute + confirm.

export type AgentKind = 'codex' | 'claude';
export type OrchestrationMode = 'plan' | 'execute';

export interface AgentCommand {
  cmd: string;
  args: string[];
}

// Pure: turn an orchestration request into argv for the chosen CLI.
export function buildAgentCommand(input: { agent: AgentKind; task: string; mode: OrchestrationMode; cwd?: string }): AgentCommand {
  if (input.agent === 'codex') {
    // codex exec runs headless; read-only sandbox for plan, workspace-write for execute.
    const sandbox = input.mode === 'execute' ? 'workspace-write' : 'read-only';
    const args = ['exec', '-s', sandbox, '--skip-git-repo-check'];
    if (input.cwd) args.push('-C', input.cwd);
    args.push(input.task);
    return { cmd: 'codex', args };
  }
  // Claude Code headless print mode; plan permission-mode does not edit files.
  const args = ['-p', input.task];
  args.push('--permission-mode', input.mode === 'execute' ? 'acceptEdits' : 'plan');
  return { cmd: 'claude', args };
}

export interface OrchestrationResult {
  agent: AgentKind;
  mode: OrchestrationMode;
  ok: boolean;
  output: string;
  durationMs: number;
}

export interface AgentAvailability {
  codex: boolean;
  claude: boolean;
}

export interface OrchestratorProvider {
  available(): Promise<AgentAvailability>;
  run(input: { agent: AgentKind; task: string; mode: OrchestrationMode; cwd?: string; timeoutMs?: number }): Promise<OrchestrationResult>;
}

// Strip likely-secret env vars before handing the environment to a local AI CLI. The CLIs
// authenticate from their own on-disk config (~/.codex, ~/.claude), so they don't need these —
// and an agent prompted to "print the environment" must not be able to exfiltrate control-plane
// secrets. ponytail: name-pattern denylist; tighten to an explicit allowlist if this leaks.
const SECRET_ENV_RE = /(TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|SESSION|COOKIE)/i;
const SECRET_ENV_PREFIX = /^(CF_|CLOUDFLARE_|AWS_|PORTLESS_DEV|PORTLESS_MCP|GITHUB_|OPENAI_|ANTHROPIC_)/i;
export function scrubEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (SECRET_ENV_RE.test(k) || SECRET_ENV_PREFIX.test(k)) continue;
    out[k] = v;
  }
  return out;
}

function exec(cmd: string, args: string[], opts: { cwd?: string; timeoutMs: number }): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    // stdin MUST be closed (EOF) — headless CLIs like codex/claude hang waiting on an open pipe.
    // env is scrubbed of secrets so an agent can't print control-plane credentials.
    const child = spawn(cmd, args, { cwd: opts.cwd, env: scrubEnv(process.env), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, output: String(e.message) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: !timedOut && code === 0, output: out.trim() || (timedOut ? `timed out after ${opts.timeoutMs}ms` : '') });
    });
  });
}

export class LocalCliOrchestrator implements OrchestratorProvider {
  async available(): Promise<AgentAvailability> {
    const [codex, claude] = await Promise.all([
      exec('codex', ['--version'], { timeoutMs: 5000 }).then((r) => r.ok),
      exec('claude', ['--version'], { timeoutMs: 5000 }).then((r) => r.ok),
    ]);
    return { codex, claude };
  }

  async run(input: { agent: AgentKind; task: string; mode: OrchestrationMode; cwd?: string; timeoutMs?: number }): Promise<OrchestrationResult> {
    const { cmd, args } = buildAgentCommand(input);
    const start = Date.now();
    // Agents can think for a long time — give them plenty of room (15 min default).
    const { ok, output } = await exec(cmd, args, { cwd: input.cwd, timeoutMs: input.timeoutMs ?? 900_000 });
    return { agent: input.agent, mode: input.mode, ok, output, durationMs: Date.now() - start };
  }
}
