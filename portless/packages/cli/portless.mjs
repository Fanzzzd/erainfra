#!/usr/bin/env node
// portless — the CLI for your private PaaS. Zero dependencies, Node >= 20.
//
//   portless login <hub-url>        sign in with your hub account (or --token for a pre-made token)
//   portless deploy [dir]           deploy a project directory → live https URL
//   portless apps                   what's deployed, where, and its URLs
//   portless logs <app> [service]   tail an app's container logs
//   portless env <app> ...          list / set K=V / unset K (encrypted at rest)
//   portless nodes                  connected machines
//   portless repos                  git bindings (push-to-deploy)
//   portless link a:5432 b          surface a's port 5432 on node b (P2P mesh, no tunnel)
//   portless links / unlink <name>  list / remove mesh links
//   portless redeploy <app>         rebuild + redeploy a bound repo
//   portless remove <app>           tear an app down everywhere
//   portless backup [now|list]      control-plane backups to your S3
//   portless open <app>             open the app's URL in a browser
//   portless chats ...              archive + full-text search Claude Code / Codex sessions
//   portless mcp                    serve these capabilities to an AI agent over MCP (stdio)
//
// Config lives in ~/.portless/config.json; PORTLESS_HUB / PORTLESS_TOKEN override it.
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { homedir, hostname } from 'node:os';
import { join, resolve, basename, dirname } from 'node:path';
import { createInterface } from 'node:readline';

const VERSION = '1.0.0';
const CONFIG_PATH = join(homedir(), '.portless', 'config.json');

// ---------- output helpers -------------------------------------------------------------------
const isTTY = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  dim: (s) => (isTTY ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s) => (isTTY ? `\x1b[1m${s}\x1b[0m` : s),
  green: (s) => (isTTY ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s) => (isTTY ? `\x1b[31m${s}\x1b[0m` : s),
  yellow: (s) => (isTTY ? `\x1b[33m${s}\x1b[0m` : s),
  cyan: (s) => (isTTY ? `\x1b[36m${s}\x1b[0m` : s),
};
const ok = (msg) => console.log(`${c.green('✓')} ${msg}`);
const die = (msg) => {
  console.error(`${c.red('✗')} ${msg}`);
  process.exit(1);
};

// One-line, in-place progress (falls back to plain lines when piped).
function stageLine(text) {
  if (isTTY) process.stdout.write(`\r\x1b[2K${c.cyan('…')} ${text}`);
  else console.log(`… ${text}`);
}
function stageDone() {
  if (isTTY) process.stdout.write('\r\x1b[2K');
}

function table(rows, headers) {
  if (rows.length === 0) return;
  const all = [headers, ...rows];
  const widths = headers.map((_, i) => Math.max(...all.map((r) => String(r[i] ?? '').replace(/\x1b\[[0-9;]*m/g, '').length)));
  const pad = (s, w) => String(s ?? '') + ' '.repeat(Math.max(0, w - String(s ?? '').replace(/\x1b\[[0-9;]*m/g, '').length));
  console.log(headers.map((h, i) => c.dim(pad(h, widths[i]))).join('  '));
  for (const r of rows) console.log(r.map((v, i) => pad(v, widths[i])).join('  '));
}

// ---------- config + transport ---------------------------------------------------------------
function loadConfig() {
  let file = {};
  try {
    file = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch { /* no config yet */ }
  return {
    hub: process.env.PORTLESS_HUB_URL ?? process.env.PORTLESS_HUB ?? file.hub,
    token: process.env.PORTLESS_TOKEN ?? file.token,
  };
}

function requireConfig() {
  const cfg = loadConfig();
  if (!cfg.hub || !cfg.token) die(`not connected to a hub — run: portless login https://your-hub  (or set PORTLESS_HUB + PORTLESS_TOKEN)`);
  return cfg;
}

async function rpc(cfg, path, input, { method = 'POST' } = {}) {
  const url =
    method === 'GET'
      ? `${cfg.hub}/trpc/${path}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`
      : `${cfg.hub}/trpc/${path}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${cfg.token}`, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
      body: method === 'POST' ? JSON.stringify(input ?? {}) : undefined,
    });
  } catch (e) {
    throw new Error(`cannot reach the hub at ${cfg.hub} (${e.cause?.code ?? e.message})`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message ?? `${path} → HTTP ${res.status}`);
  return body.result?.data;
}
const query = (cfg, path, input) => rpc(cfg, path, input, { method: 'GET' });
const mutate = (cfg, path, input) => rpc(cfg, path, input);

function prompt(question, { hidden = false } = {}) {
  if (!hidden) {
    return new Promise((res) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
      rl.question(question, (a) => {
        rl.close();
        res(a.trim());
      });
    });
  }
  // Hidden input (tokens): raw mode, no echo. Enter finishes, Ctrl-C aborts, backspace edits.
  process.stderr.write(question);
  return new Promise((res) => {
    const wasRaw = process.stdin.isRaw ?? false;
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    let buf = '';
    const onData = (chunk) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          process.stdin.setRawMode?.(wasRaw);
          process.stdin.pause();
          process.stdin.removeListener('data', onData);
          process.stderr.write('\n');
          return res(buf.trim());
        }
        if (ch === '\u0003') {
          process.stderr.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    process.stdin.on('data', onData);
  });
}

// ---------- arg parsing (tiny, predictable) ---------------------------------------------------
function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[a.slice(2)] = argv[++i];
      else flags[a.slice(2)] = true;
    } else if (a === '-n' && i + 1 < argv.length) {
      flags.lines = argv[++i];
    } else if (a === '-y') {
      flags.yes = true;
    } else {
      pos.push(a);
    }
  }
  return { flags, pos };
}

// ---------- source packing --------------------------------------------------------------------
// Prefer `git archive HEAD` (exactly the committed tree — respects .gitignore by construction);
// fall back to tar with the obvious excludes for non-git directories.
function packSource(dir) {
  const inGit = spawnSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], { stdio: 'pipe' }).status === 0;
  if (inGit) {
    const dirty = execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
    if (dirty) console.error(c.yellow(`! uncommitted changes are NOT included (git archive deploys HEAD)`));
    return execFileSync('git', ['-C', dir, 'archive', '--format=tar.gz', 'HEAD'], { maxBuffer: 512 * 1024 * 1024 });
  }
  // COPYFILE_DISABLE stops macOS bsdtar from smuggling AppleDouble ._* files into the tarball
  // (nixpacks chokes on them).
  return execFileSync(
    'tar',
    ['-czf', '-', '--exclude=node_modules', '--exclude=.git', '--exclude=dist', '--exclude=.turbo', '--exclude=._*', '-C', dir, '.'],
    { maxBuffer: 512 * 1024 * 1024, env: { ...process.env, COPYFILE_DISABLE: '1' } },
  );
}

async function uploadSource(cfg, dir) {
  const tarball = packSource(dir);
  const res = await fetch(`${cfg.hub}/upload`, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/gzip' },
    body: tarball,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ?? `upload → HTTP ${res.status}`);
  return { buildId: body.buildId, bytes: body.bytes };
}

async function waitForDeploy(cfg, deployId, onStage) {
  for (;;) {
    const d = await query(cfg, 'apps.status', { deployId });
    onStage?.(d);
    if (d.stage === 'done' || d.stage === 'failed') return d;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// Deploy a directory end to end. Shared by `portless deploy` and the MCP deploy tool.
async function deployDir(cfg, dir, { app, port, node, buildNode } = {}, onStage) {
  const target = resolve(dir ?? '.');
  if (!existsSync(target) || !statSync(target).isDirectory()) throw new Error(`not a directory: ${target}`);
  const name = (app ?? basename(target)).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw new Error(`cannot derive an app name from "${basename(target)}" — pass --app`);
  onStage?.({ stage: 'packing', detail: `packing ${target}` });
  const { buildId, bytes } = await uploadSource(cfg, target);
  onStage?.({ stage: 'uploaded', detail: `uploaded ${(bytes / 1024 / 1024).toFixed(1)}MB` });
  const started = await mutate(cfg, 'upload.deploy', {
    buildId,
    app: name,
    ...(port ? { port: Number(port) } : {}),
    ...(node ? { node } : {}),
    ...(buildNode ? { buildNode } : {}),
    confirm: true,
  });
  return waitForDeploy(cfg, started.deployId, onStage);
}


// ---------- AI chat transcripts (Claude Code / Codex CLI) --------------------------------------
// Both CLIs journal every session as append-only JSONL. We parse them into plain user/assistant
// text messages and sync each session to the hub (chats.ingest replaces the whole session, so
// re-sending a grown file is idempotent). Tool calls/results and reasoning blocks are skipped —
// the archive is for reading and searching what was SAID, not replaying the run.
const CHAT_TEXT_CAP = 100_000; // per-message cap; giant pasted blobs get truncated, search survives

function listJsonlFiles(dir) {
  const out = [];
  const walk = (d) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const f = join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(f);
    }
  };
  walk(dir);
  return out;
}

const cap = (t) => (t.length > CHAT_TEXT_CAP ? `${t.slice(0, CHAT_TEXT_CAP)}\n…[truncated]` : t);
const mkTitle = (msgs) => msgs.find((m) => m.role === 'user')?.text.split('\n')[0].slice(0, 120);

// Claude Code: ~/.claude/projects/<slug>/<session-uuid>.jsonl. Real user prompts have a STRING
// message.content; assistant lines carry content blocks (keep text, skip thinking/tool_use);
// user lines whose content is an array are tool results / interruption markers — skip the former.
function parseClaudeFile(file) {
  const id = basename(file, '.jsonl');
  const messages = [];
  let project, startedAt, updatedAt;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type !== 'user' && d.type !== 'assistant') continue;
    const m = d.message;
    if (!m || d.isMeta) continue;
    project ??= d.cwd;
    let text = '';
    let model;
    if (d.type === 'user') {
      if (typeof m.content === 'string') text = m.content;
      else if (Array.isArray(m.content)) text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      if (/^<[a-z-]+>/.test(text.trim()) || text.startsWith('[Request interrupted')) text = ''; // injected wrappers, not the human
    } else {
      model = m.model;
      if (Array.isArray(m.content)) text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    }
    text = text.trim();
    if (!text) continue;
    startedAt ??= d.timestamp;
    updatedAt = d.timestamp ?? updatedAt;
    messages.push({ seq: messages.length, role: d.type, model, at: d.timestamp, text: cap(text) });
  }
  return { session: { id, source: 'claude', host: hostname(), project, title: mkTitle(messages), startedAt, updatedAt }, messages };
}

// Codex CLI: ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl. Messages ride response_item
// payloads; role "developer" is injected instructions, and the first "user" items are AGENTS.md /
// permission wrappers — skip anything that reads like scaffolding rather than the human.
function parseCodexFile(file) {
  const messages = [];
  let id, project, model, startedAt, updatedAt;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const p = d.payload ?? {};
    if (d.type === 'session_meta') {
      id = p.id ?? p.session_id ?? id;
      project = p.cwd ?? project;
      startedAt = p.timestamp ?? d.timestamp ?? startedAt;
      continue;
    }
    if (d.type === 'turn_context') {
      model = p.model ?? model;
      project ??= p.cwd;
      continue;
    }
    if (d.type !== 'response_item' || p.type !== 'message') continue;
    if (p.role !== 'user' && p.role !== 'assistant') continue; // developer = injected instructions
    let text = (Array.isArray(p.content) ? p.content : [])
      .filter((b) => b.type === 'input_text' || b.type === 'output_text' || b.type === 'text')
      .map((b) => b.text).join('\n').trim();
    if (p.role === 'user' && (/^<[a-z_ -]+>/i.test(text) || text.startsWith('# AGENTS.md'))) continue; // scaffolding
    if (!text) continue;
    updatedAt = d.timestamp ?? updatedAt;
    messages.push({ seq: messages.length, role: p.role, model: p.role === 'assistant' ? model : undefined, at: d.timestamp, text: cap(text) });
  }
  const fallbackId = basename(file, '.jsonl').replace(/^rollout-/, '');
  return { session: { id: id ?? fallbackId, source: 'codex', host: hostname(), project, title: mkTitle(messages), startedAt, updatedAt }, messages };
}

// Incremental sync: remember each file's size; re-parse + re-send only when it changed.
const CHAT_STATE_PATH = join(homedir(), '.portless', 'chats-sync.json');

async function syncChats(cfg, { verbose = false } = {}) {
  let state = {};
  try { state = JSON.parse(readFileSync(CHAT_STATE_PATH, 'utf8')); } catch { /* first run */ }
  const targets = [
    { root: join(homedir(), '.claude', 'projects'), parse: parseClaudeFile },
    { root: join(homedir(), '.codex', 'sessions'), parse: parseCodexFile },
  ];
  let sent = 0, skipped = 0, empty = 0, failed = 0;
  for (const t of targets) {
    if (!existsSync(t.root)) continue;
    for (const file of listJsonlFiles(t.root)) {
      const size = statSync(file).size;
      if (state[file]?.size === size) { skipped++; continue; }
      let parsed;
      try { parsed = t.parse(file); } catch (e) {
        failed++;
        if (verbose) console.error(c.yellow(`! ${file}: ${e.message}`));
        continue;
      }
      if (parsed.messages.length === 0) { state[file] = { size }; empty++; continue; }
      try {
        await mutate(cfg, 'chats.ingest', parsed);
        state[file] = { size, sessionId: parsed.session.id };
        sent++;
        if (verbose) console.log(`  ${parsed.session.source} ${parsed.session.id.slice(0, 8)} ${parsed.messages.length} msgs`);
        else stageLine(`synced ${sent} session${sent === 1 ? '' : 's'}…`);
      } catch (e) {
        failed++;
        console.error(c.yellow(`! ${basename(file)}: ${e.message}`));
      }
    }
  }
  stageDone();
  mkdirSync(dirname(CHAT_STATE_PATH), { recursive: true });
  writeFileSync(CHAT_STATE_PATH, JSON.stringify(state), { mode: 0o600 });
  return { sent, skipped, empty, failed };
}

// ---------- commands ---------------------------------------------------------------------------
const commands = {
  async login({ flags, pos }) {
    const hub = (pos[0] ?? '').replace(/\/+$/, '');
    if (!hub) die('usage: portless login https://portless.example.com [--token <token> | --email <email>]');
    let token = flags.token;
    if (!token) {
      // Default flow: sign in with your hub account; the hub mints a personal API token for this
      // machine (revocable later in Settings → API tokens). --token skips this for pre-made tokens.
      const email = flags.email ?? (await prompt('email: '));
      if (!email) die('an email (or --token) is required');
      const password = await prompt('password: ', { hidden: true });
      const res = await fetch(`${hub}/auth/cli-token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password, name: `cli @${hostname()}` }),
      }).catch((e) => die(`cannot reach ${hub}: ${e.message}`));
      const body = await res.json().catch(() => ({}));
      if (!res.ok) die(`login failed: ${body.error ?? res.status}`);
      token = body.token;
    }
    const cfg = { hub, token };
    const nodes = await query(cfg, 'agents.list').catch((e) => die(`login failed: ${e.message}`));
    mkdirSync(join(homedir(), '.portless'), { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    ok(`connected to ${hub} (${nodes.length} node${nodes.length === 1 ? '' : 's'} online) — saved to ~/.portless/config.json`);
  },

  async nodes({ flags }) {
    const cfg = requireConfig();
    const nodes = await query(cfg, 'agents.list');
    if (flags.json) return console.log(JSON.stringify(nodes, null, 2));
    if (!nodes.length) {
      console.log('no nodes connected. Enroll one:');
      console.log(c.cyan(`  curl -fsSL ${cfg.hub}/agent.sh | sudo sh -s -- --token <node-token> --name <name>`));
      return;
    }
    table(nodes.map((n) => [n.id, n.version ?? '-', c.green('online'), n.connectedAt]), ['NODE', 'VERSION', 'STATUS', 'CONNECTED AT']);
  },

  async deploy({ flags, pos }) {
    const cfg = requireConfig();
    const t0 = Date.now();
    const d = await deployDir(cfg, pos[0], { app: flags.app, port: flags.port, node: flags.node, buildNode: flags['build-node'] }, (p) =>
      stageLine(p.detail ?? p.stage),
    );
    stageDone();
    if (d.stage === 'failed') die(`deploy failed (${d.detail}): ${d.error ?? ''}`);
    ok(`deployed ${c.bold(d.app)} in ${Math.round((Date.now() - t0) / 1000)}s`);
    for (const url of d.urls) console.log(`  ${c.cyan(url)}`);
  },

  async apps({ flags }) {
    const cfg = requireConfig();
    const apps = await query(cfg, 'apps.list');
    if (flags.json) return console.log(JSON.stringify(apps, null, 2));
    if (!apps.length) return console.log(`nothing deployed yet — try: portless deploy`);
    const rows = [];
    for (const a of apps)
      for (const s of a.services)
        rows.push([
          a.app,
          s.name,
          s.node,
          s.url ?? c.dim('internal'),
          s.route ? (s.online ? c.green('online') : c.red('offline')) : c.dim('-'),
        ]);
    table(rows, ['APP', 'SERVICE', 'NODE', 'URL', 'STATUS']);
  },
  status(a) {
    return commands.apps(a);
  },

  async logs({ flags, pos }) {
    const cfg = requireConfig();
    const [app, service] = pos;
    if (!app) die('usage: portless logs <app> [service] [-n lines]');
    const r = await query(cfg, 'apps.logs', { app, ...(service ? { service } : {}), lines: Number(flags.lines ?? 100) });
    console.log(c.dim(`# ${r.container} on ${r.node}`));
    process.stdout.write(r.output.endsWith('\n') || !r.output ? r.output : r.output + '\n');
  },

  async env({ flags, pos }) {
    const cfg = requireConfig();
    const [app, action, ...rest] = pos;
    if (!app) die('usage: portless env <app> [set K=V ... | unset K]');
    if (!action) {
      const vars = await query(cfg, 'env.list', { app });
      if (flags.json) return console.log(JSON.stringify(vars, null, 2));
      if (!vars.length) return console.log(`no env vars for ${app}`);
      table(vars.map((v) => [v.key, c.dim(v.preview)]), ['KEY', 'VALUE']);
    } else if (action === 'set') {
      const vars = {};
      for (const kv of rest) {
        const eq = kv.indexOf('=');
        if (eq <= 0) die(`not K=V: ${kv}`);
        vars[kv.slice(0, eq)] = kv.slice(eq + 1);
      }
      if (!Object.keys(vars).length) die('usage: portless env <app> set KEY=value [KEY2=value2 ...]');
      await mutate(cfg, 'env.set', { app, vars });
      ok(`set ${Object.keys(vars).join(', ')} — takes effect on the next deploy (portless redeploy ${app})`);
    } else if (action === 'unset') {
      if (!rest[0]) die('usage: portless env <app> unset KEY');
      await mutate(cfg, 'env.unset', { app, key: rest[0] });
      ok(`removed ${rest[0]} — takes effect on the next deploy`);
    } else {
      die(`unknown env action "${action}" (use: set / unset, or no action to list)`);
    }
  },

  async repos({ flags }) {
    const cfg = requireConfig();
    const list = await query(cfg, 'git.list');
    if (flags.json) return console.log(JSON.stringify(list, null, 2));
    if (!list.length) return console.log('no git bindings — bind one in the dashboard, or: portless bind owner/repo --app <name>');
    table(
      list.map((b) => [
        `${b.repo}@${b.branch}`,
        b.name,
        b.lastStatus ? (b.lastStatus.ok ? c.green(`ok ${b.lastStatus.sha.slice(0, 7)}`) : c.red(`failed: ${b.lastStatus.stage}`)) : c.dim('never'),
      ]),
      ['REPO', 'APP', 'LAST DEPLOY'],
    );
  },

  async bind({ flags, pos }) {
    const cfg = requireConfig();
    const repo = pos[0];
    if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) die('usage: portless bind owner/repo [--branch main] [--app name] [--port 3000]');
    const name = flags.app ?? repo.split('/')[1].toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const b = await mutate(cfg, 'git.bind', {
      repo,
      branch: flags.branch ?? 'main',
      name,
      ...(flags.port ? { port: Number(flags.port) } : {}),
      confirm: true,
    });
    ok(`bound ${repo}@${b.branch} → app "${b.name}" — deploy with: portless redeploy ${b.name}`);
  },

  async redeploy({ pos }) {
    const cfg = requireConfig();
    const app = pos[0];
    if (!app) die('usage: portless redeploy <app>');
    const list = await query(cfg, 'git.list');
    const b = list.find((x) => x.name === app);
    if (!b) die(`no git binding named "${app}" (portless repos to list; for directories use portless deploy)`);
    const t0 = Date.now();
    const { deployId } = await mutate(cfg, 'git.deployNow', { id: b.id, confirm: true });
    const d = await waitForDeploy(cfg, deployId, (p) => stageLine(p.detail ?? p.stage));
    stageDone();
    if (d.stage === 'failed') die(`deploy failed (${d.detail}): ${d.error ?? ''}`);
    ok(`deployed ${c.bold(app)} in ${Math.round((Date.now() - t0) / 1000)}s`);
    for (const url of d.urls) console.log(`  ${c.cyan(url)}`);
  },

  async remove({ flags, pos }) {
    const cfg = requireConfig();
    const app = pos[0];
    if (!app) die('usage: portless remove <app> [-y]');
    if (!flags.yes) {
      const a = await prompt(`remove ${app} (containers, routes, links)? [y/N] `);
      if (a.toLowerCase() !== 'y') return console.log('aborted');
    }
    const r = await mutate(cfg, 'apps.remove', { app, confirm: true });
    ok(`removed ${app}${r.stopped ? '' : ' (its node was offline — containers may linger there)'}`);
  },

  async backup({ flags, pos }) {
    const cfg = requireConfig();
    const action = pos[0] ?? 'list';
    if (action === 'now') {
      const r = await mutate(cfg, 'backup.now', { confirm: true });
      ok(`backed up → ${r.key} (${r.bytes} bytes)`);
    } else if (action === 'list') {
      const conf = await query(cfg, 'backup.config');
      if (!conf.configured) return console.log('backups not configured — set PORTLESS_BACKUP_S3_* on the hub');
      const list = await query(cfg, 'backup.list');
      if (flags.json) return console.log(JSON.stringify(list, null, 2));
      if (!list.length) return console.log(`no backups yet in ${conf.bucket} — run: portless backup now`);
      table(list.map((b) => [b.key, String(b.size), b.lastModified]), ['KEY', 'BYTES', 'MODIFIED']);
    } else {
      die('usage: portless backup [now|list]');
    }
  },

  async open({ pos }) {
    const cfg = requireConfig();
    const app = pos[0];
    if (!app) die('usage: portless open <app>');
    const apps = await query(cfg, 'apps.list');
    const url = apps.flatMap((a) => a.services).find((s) => s.url && (s.route === app || s.name === app))?.url
      ?? apps.find((a) => a.app === app)?.services.find((s) => s.url)?.url;
    if (!url) die(`no URL for "${app}"`);
    console.log(url);
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawnSync(opener, [url], { stdio: 'ignore' });
  },

  // AI conversation archive: sync local Claude Code / Codex transcripts to the hub, then search
  // them from anywhere. `autosync` installs a launchd (macOS) / systemd (Linux) timer.
  async chats({ flags, pos }) {
    const sub = pos[0] ?? 'list';
    if (sub === 'sync') {
      const cfg = requireConfig();
      const r = await syncChats(cfg, { verbose: !!flags.verbose });
      const st = await query(cfg, 'chats.stats');
      ok(`synced ${r.sent} changed session(s) (${r.skipped} unchanged, ${r.empty} empty, ${r.failed} failed) — hub now has ${st.sessions} sessions / ${st.messages} messages`);
    } else if (sub === 'list') {
      const cfg = requireConfig();
      const sessions = await query(cfg, 'chats.sessions', { ...(flags.source ? { source: flags.source } : {}), ...(flags.project ? { project: flags.project } : {}), limit: Number(flags.limit ?? 25) });
      if (flags.json) return console.log(JSON.stringify(sessions, null, 2));
      if (!sessions.length) return console.log('no chat sessions on the hub yet — run: portless chats sync');
      table(sessions.map((x) => [x.id.slice(0, 8), x.source, String(x.messageCount), (x.project ?? '').split('/').slice(-2).join('/'), (x.title ?? '').slice(0, 60), (x.updatedAt ?? '').slice(0, 16)]),
        ['ID', 'SOURCE', 'MSGS', 'PROJECT', 'TITLE', 'UPDATED']);
    } else if (sub === 'search') {
      const cfg = requireConfig();
      const q = pos.slice(1).join(' ');
      if (!q) die('usage: portless chats search <query>');
      const hits = await query(cfg, 'chats.search', { q, limit: Number(flags.limit ?? 15) });
      if (flags.json) return console.log(JSON.stringify(hits, null, 2));
      if (!hits.length) return console.log('no matches');
      for (const h of hits) {
        console.log(`${c.bold(h.session.id.slice(0, 8))} ${c.dim(`${h.session.source} · ${h.role} · ${(h.at ?? '').slice(0, 16)} · ${(h.session.project ?? '').split('/').pop() ?? ''}`)}`);
        console.log(`  ${h.snippet.replaceAll('\n', ' ')}`);
      }
      console.log(c.dim(`\nfull session: portless chats show <id>`));
    } else if (sub === 'show') {
      const cfg = requireConfig();
      const id = pos[1];
      if (!id) die('usage: portless chats show <session-id (or 8-char prefix)>');
      let full = id;
      if (id.length < 32) {
        const all = await query(cfg, 'chats.sessions', { limit: 500 });
        const m = all.find((x) => x.id.startsWith(id));
        if (!m) die(`no session starting with "${id}"`);
        full = m.id;
      }
      const { session, messages } = await query(cfg, 'chats.messages', { id: full });
      if (flags.json) return console.log(JSON.stringify({ session, messages }, null, 2));
      console.log(`${c.bold(session.title ?? session.id)} ${c.dim(`(${session.source} · ${session.project ?? ''} · ${messages.length} msgs)`)}\n`);
      for (const m of messages) {
        const who = m.role === 'user' ? c.cyan('you') : c.green(m.model ?? 'assistant');
        console.log(`${who} ${c.dim((m.at ?? '').slice(0, 16))}\n${m.text}\n`);
      }
    } else if (sub === 'parse') {
      // debug: parse a transcript locally without uploading
      const file = pos[1];
      if (!file) die('usage: portless chats parse <file.jsonl>');
      const parsed = file.includes('.codex') || basename(file).startsWith('rollout-') ? parseCodexFile(file) : parseClaudeFile(file);
      console.log(JSON.stringify(parsed, null, 2));
    } else if (sub === 'autosync') {
      requireConfig(); // fail early if not logged in
      const bin = process.argv[1];
      if (process.platform === 'darwin') {
        const plist = join(homedir(), 'Library', 'LaunchAgents', 'ai.portless.chats-sync.plist');
        mkdirSync(dirname(plist), { recursive: true });
        writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>ai.portless.chats-sync</string>
  <key>ProgramArguments</key><array>
    <string>${process.execPath}</string><string>${bin}</string><string>chats</string><string>sync</string>
  </array>
  <key>StartInterval</key><integer>900</integer>
  <key>StandardOutPath</key><string>/tmp/portless-chats-sync.log</string>
  <key>StandardErrorPath</key><string>/tmp/portless-chats-sync.log</string>
</dict></plist>
`);
        spawnSync('launchctl', ['unload', plist], { stdio: 'ignore' });
        const r = spawnSync('launchctl', ['load', plist], { stdio: 'pipe' });
        if (r.status !== 0) die(`launchctl load failed: ${r.stderr}`);
        ok(`autosync installed — every 15 min via launchd (${plist})`);
      } else {
        console.log('add to crontab (crontab -e):');
        console.log(c.cyan(`*/15 * * * * ${process.execPath} ${bin} chats sync >>/tmp/portless-chats-sync.log 2>&1`));
      }
    } else {
      die('usage: portless chats [sync|list|search <q>|show <id>|autosync]');
    }
  // 内网互连：portless link <provider>:<port> <consumer>[:<localPort>] — consumer 节点上出现
  },
  // 127.0.0.1:<localPort>，流量走 iroh P2P 直连（NAT 打洞，不经 hub、不经 tunnel）。
  async link({ flags, pos }) {
    const cfg = requireConfig();
    const [src, dst] = pos;
    const m = /^([^:]+):(\d+)$/.exec(src ?? '');
    if (!m || !dst) die('usage: portless link <provider-node>:<port> <consumer-node>[:<local-port>] [--name X]');
    const [consumer, localPortStr] = dst.split(':');
    const r = await mutate(cfg, 'mesh.link', {
      provider: m[1],
      providerPort: Number(m[2]),
      consumer,
      ...(localPortStr ? { localPort: Number(localPortStr) } : {}),
      ...(flags.name ? { name: flags.name } : {}),
      confirm: true,
    });
    ok(`${c.bold(consumer)} can now reach ${c.bold(src)} at ${c.cyan(r.address)} (containers: ${r.containerAddress}) — link "${r.name}", auto-healed`);
  },

  async links({ flags }) {
    const cfg = requireConfig();
    const list = await query(cfg, 'mesh.list');
    if (flags.json) return console.log(JSON.stringify(list, null, 2));
    if (!list.length) return console.log('no mesh links — create one: portless link <node>:<port> <node>');
    table(
      list.map((l) => [l.name, `${l.provider}:${l.providerPort}`, `${l.consumer} @127.0.0.1:${l.localPort}`, l.online ? c.green('online') : c.red('node offline'), c.dim(l.createdBy ?? '-')]),
      ['LINK', 'FROM', 'SURFACED ON', 'STATUS', 'BY'],
    );
  },

  async unlink({ flags, pos }) {
    const cfg = requireConfig();
    const name = pos[0];
    if (!name) die('usage: portless unlink <name> [-y]');
    if (!flags.yes) {
      const a = await prompt(`remove mesh link ${name} (both ends torn down)? [y/N] `);
      if (a.toLowerCase() !== 'y') return console.log('aborted');
    }
    await mutate(cfg, 'mesh.unlink', { name, confirm: true });
    ok(`unlinked ${name}`);
  },

  async mcp() {
    await serveMcp();
  },

  version() {
    console.log(`portless ${VERSION}`);
  },

  help() {
    console.log(`${c.bold('portless')} ${VERSION} — deploy to your own machines, no public IP needed

${c.bold('setup')}
  login <hub-url>                 sign in (email+password, or --token X) -> ~/.portless/config.json
  nodes                           connected machines (+ how to enroll more)

${c.bold('deploy')}
  deploy [dir] [--app name] [--node N] [--build-node N] [--port P]
                                  pack a directory → build → run → https URL
                                  (reads portless.yaml in the directory when present)
  bind owner/repo [--branch B] [--app name] [--port P]
                                  bind a GitHub repo (push-to-deploy via webhook)
  redeploy <app>                  rebuild + redeploy a bound repo
  remove <app> [-y]               tear an app down everywhere

${c.bold('mesh')}
  link <node>:<port> <node>[:<port>]
                                  surface a port from one node on another (P2P, no tunnel),
                                  e.g. portless link gpu-box:8080 web-box — auto-healed forever
  links                           every mesh link + status
  unlink <name> [-y]              tear a link down on both ends

${c.bold('operate')}
  apps | status [--json]          everything deployed, with URLs and liveness
  logs <app> [service] [-n 100]   container logs
  env <app> [set K=V ...|unset K] encrypted env vars (applied on next deploy)
  repos                           git bindings + last deploy status
  backup [now|list]               control-plane backup to your own S3
  open <app>                      open the app's public URL

${c.bold('ai')}
  chats sync                      archive local Claude Code + Codex transcripts to the hub
  chats [search <q>|show <id>]    browse / full-text search every past AI session
  chats autosync                  keep syncing automatically (launchd/cron, every 15 min)
  mcp                             MCP server over stdio (for Claude Code / Codex):
                                  claude mcp add portless -- portless mcp`);
  },
};

// ---------- MCP server (stdio, newline-delimited JSON-RPC 2.0) ---------------------------------
// The whole point: an AI agent gets typed, deterministic capabilities — deploy/status/logs/env —
// instead of improvising SSH. Thin bridge: every tool is one hub API call (deploy adds packing).
const MCP_TOOLS = [
  {
    name: 'portless_status',
    description: 'List every deployed app: services, nodes, public URLs, online/offline.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (cfg) => query(cfg, 'apps.list'),
  },
  {
    name: 'portless_nodes',
    description: 'List connected deploy nodes (machines enrolled in the mesh).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (cfg) => query(cfg, 'agents.list'),
  },
  {
    name: 'portless_deploy',
    description:
      'Deploy a local project directory to the platform: packs the source, builds it (portless.yaml or auto-detect), runs it, returns the live https URL. Takes minutes for first builds.',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'absolute path of the project directory' },
        app: { type: 'string', description: 'app name (default: directory name)' },
        port: { type: 'number', description: 'container port — ONLY for projects without portless.yaml' },
        node: { type: 'string', description: 'target node (default: first connected)' },
      },
      required: ['dir'],
      additionalProperties: false,
    },
    handler: async (cfg, args) => {
      const d = await deployDir(cfg, args.dir, args);
      if (d.stage === 'failed') throw new Error(`deploy failed (${d.detail}): ${d.error ?? ''}`);
      return { app: d.app, urls: d.urls };
    },
  },
  {
    name: 'portless_redeploy',
    description: 'Rebuild + redeploy an app bound to a git repo (fresh clone of its branch).',
    inputSchema: { type: 'object', properties: { app: { type: 'string' } }, required: ['app'], additionalProperties: false },
    handler: async (cfg, args) => {
      const list = await query(cfg, 'git.list');
      const b = list.find((x) => x.name === args.app);
      if (!b) throw new Error(`no git binding named "${args.app}"`);
      const { deployId } = await mutate(cfg, 'git.deployNow', { id: b.id, confirm: true });
      const d = await waitForDeploy(cfg, deployId);
      if (d.stage === 'failed') throw new Error(`deploy failed (${d.detail}): ${d.error ?? ''}`);
      return { app: d.app, urls: d.urls };
    },
  },
  {
    name: 'portless_logs',
    description: "Tail an app's container logs from its node.",
    inputSchema: {
      type: 'object',
      properties: { app: { type: 'string' }, service: { type: 'string' }, lines: { type: 'number' } },
      required: ['app'],
      additionalProperties: false,
    },
    handler: async (cfg, args) => query(cfg, 'apps.logs', { app: args.app, ...(args.service ? { service: args.service } : {}), lines: args.lines ?? 100 }),
  },
  {
    name: 'portless_chats_search',
    description: 'Full-text search the archived Claude Code / Codex conversation history (all machines, all projects). Returns matching messages with snippets and session ids.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'search terms' }, limit: { type: 'number' } },
      required: ['query'],
      additionalProperties: false,
    },
    handler: async (cfg, args) => query(cfg, 'chats.search', { q: args.query, limit: args.limit ?? 15 }),
  },
  {
    name: 'portless_chats_get',
    description: 'Fetch one archived AI conversation (all its user/assistant messages) by session id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    handler: async (cfg, args) => query(cfg, 'chats.messages', { id: args.id }),
  },
  {
    name: 'portless_env_list',
    description: "List an app's env var KEYS (values are write-only, shown masked).",
    inputSchema: { type: 'object', properties: { app: { type: 'string' } }, required: ['app'], additionalProperties: false },
    handler: async (cfg, args) => query(cfg, 'env.list', { app: args.app }),
  },
  {
    name: 'portless_env_set',
    description: 'Set env vars / secrets on an app (encrypted at rest; applied on the next deploy).',
    inputSchema: {
      type: 'object',
      properties: { app: { type: 'string' }, vars: { type: 'object', additionalProperties: { type: 'string' } } },
      required: ['app', 'vars'],
      additionalProperties: false,
    },
    handler: async (cfg, args) => mutate(cfg, 'env.set', { app: args.app, vars: args.vars }),
  },
  {
    name: 'portless_remove',
    description: 'Tear an app down everywhere: containers, routes, cross-node links. Destructive.',
    inputSchema: { type: 'object', properties: { app: { type: 'string' } }, required: ['app'], additionalProperties: false },
    handler: async (cfg, args) => mutate(cfg, 'apps.remove', { app: args.app, confirm: true }),
  },
  {
    name: 'portless_link',
    description:
      'Wire two nodes over the P2P mesh: surface <provider>:<providerPort> on <consumer> at 127.0.0.1:<localPort> (containers: host.docker.internal). No public IP or tunnel; persisted and auto-healed.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'node that has the service' },
        providerPort: { type: 'number' },
        consumer: { type: 'string', description: 'node that wants the service' },
        localPort: { type: 'number', description: 'port on the consumer (default: providerPort)' },
        name: { type: 'string', description: 'stable link name (default: derived)' },
      },
      required: ['provider', 'providerPort', 'consumer'],
      additionalProperties: false,
    },
    handler: async (cfg, args) => mutate(cfg, 'mesh.link', { ...args, confirm: true }),
  },
  {
    name: 'portless_links',
    description: 'List every standalone mesh link (node-to-node port wiring) with liveness.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (cfg) => query(cfg, 'mesh.list'),
  },
  {
    name: 'portless_unlink',
    description: 'Tear down a mesh link on both ends and stop auto-healing it.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
    handler: async (cfg, args) => mutate(cfg, 'mesh.unlink', { name: args.name, confirm: true }),
  },
  {
    name: 'portless_backup_now',
    description: "Back up the hub's control-plane state (routes, secrets, bindings, audit) to the configured S3.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (cfg) => mutate(cfg, 'backup.now', { confirm: true }),
  },
];

async function serveMcp() {
  const cfg = requireConfig();
  const respond = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      continue;
    }
    const { id, method, params } = req;
    const reply = (result) => id !== undefined && respond({ jsonrpc: '2.0', id, result });
    const replyErr = (message, code = -32000) => id !== undefined && respond({ jsonrpc: '2.0', id, error: { code, message } });
    try {
      if (method === 'initialize') {
        reply({
          protocolVersion: params?.protocolVersion ?? '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'portless', version: VERSION },
        });
      } else if (method === 'tools/list') {
        reply({ tools: MCP_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      } else if (method === 'tools/call') {
        const tool = MCP_TOOLS.find((t) => t.name === params?.name);
        if (!tool) {
          replyErr(`unknown tool: ${params?.name}`, -32602);
          continue;
        }
        try {
          const result = await tool.handler(cfg, params?.arguments ?? {});
          reply({ content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] });
        } catch (e) {
          reply({ content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
        }
      } else if (method === 'ping') {
        reply({});
      } else if (id !== undefined) {
        replyErr(`method not supported: ${method}`, -32601);
      }
      // notifications (no id) are ignored by design
    } catch (e) {
      replyErr(e.message);
    }
  }
}

// ---------- main --------------------------------------------------------------------------------
const [, , cmd, ...rest] = process.argv;
const name = { '-h': 'help', '--help': 'help', '-v': 'version', '--version': 'version' }[cmd] ?? cmd ?? 'help';
const fn = commands[name];
if (!fn) die(`unknown command "${name}" — try: portless help`);
Promise.resolve(fn(parseArgs(rest))).catch((e) => die(e.message));
