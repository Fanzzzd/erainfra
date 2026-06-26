// Vercel serverless function: serve the Portless installer scripts (mesh-node.sh, registry.sh,
// image.sh) with THIS deployment's base URL templated in (the `<hub>` placeholder), so the commands
// they print point back here. Mirrors the hub's Fastify route (apps/api/src/server.ts). Canonical
// scripts live in deploy/*.sh — single source of truth, bundled via vercel.json `includeFiles`.
//
// Why this works on serverless when the rest of Portless doesn't: serving an installer is a pure,
// stateless request → response. The stateful control plane (which spawns dumbpipe/zot and holds
// links) runs on a real box — but the mesh + image store need none of that, only these URLs.
//
// ESM (the repo is "type":"module"); Vercel runs it as an ESM function.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ALLOWED = new Set(['mesh-node.sh', 'mesh-node.ps1', 'registry.sh', 'image.sh']);
const cache = {};

function script(name) {
  if (cache[name]) return cache[name];
  // Vercel runs functions with cwd = deployment root (where includeFiles lands); fall back to a
  // path relative to this file.
  for (const p of [join(process.cwd(), 'deploy', name), join(here, '../deploy', name)]) {
    try { cache[name] = readFileSync(p, 'utf8'); return cache[name]; } catch { /* try next */ }
  }
  throw new Error('not bundled');
}

export default function handler(req, res) {
  const name = new URL(req.url, 'http://x').searchParams.get('name') || '';
  if (!ALLOWED.has(name)) {
    res.statusCode = 404;
    res.setHeader('content-type', 'text/plain');
    res.end('not found\n');
    return;
  }
  let body;
  try {
    body = script(name);
  } catch {
    res.statusCode = 500;
    res.setHeader('content-type', 'text/plain');
    res.end(`${name} not available\n`);
    return;
  }
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const base = `${proto}://${host}`;
  res.setHeader('content-type', name.endsWith('.ps1') ? 'text/plain; charset=utf-8' : 'text/x-shellscript; charset=utf-8');
  res.setHeader('cache-control', 'public, max-age=300');
  res.end(body.split('<hub>').join(base));
}
