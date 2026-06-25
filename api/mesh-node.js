// Vercel serverless function: serve the mesh-node bootstrap with THIS deployment's URL templated
// in, so the `connect` one-liner the script prints points back here. Mirrors the hub's Fastify
// route (apps/api/src/server.ts) — the canonical script is deploy/mesh-node.sh, the single source
// of truth, bundled into this function via vercel.json `includeFiles`.
//
// Why this works on serverless when the rest of Portless doesn't: serving an installer is a pure,
// stateless request → response. The stateful control plane (which spawns dumbpipe/cloudflared and
// holds links) still runs on a real box — but the MESH itself needs none of that, only this URL.
//
// ESM (the repo is "type":"module"); Vercel runs it as an ESM function.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

let cached;
function script() {
  if (cached) return cached;
  // Vercel runs functions with cwd = deployment root (where includeFiles lands); fall back to a
  // path relative to this file just in case.
  for (const p of [join(process.cwd(), 'deploy/mesh-node.sh'), join(here, '../deploy/mesh-node.sh')]) {
    try { cached = readFileSync(p, 'utf8'); return cached; } catch { /* try next */ }
  }
  throw new Error('deploy/mesh-node.sh not bundled');
}

export default function handler(req, res) {
  let body;
  try {
    body = script();
  } catch {
    res.statusCode = 500;
    res.setHeader('content-type', 'text/plain');
    res.end('mesh-node.sh not available\n');
    return;
  }
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const self = `${proto}://${host}/mesh-node.sh`;
  res.setHeader('content-type', 'text/x-shellscript; charset=utf-8');
  res.setHeader('cache-control', 'public, max-age=300');
  res.end(body.split('<url>/mesh-node.sh').join(self));
}
