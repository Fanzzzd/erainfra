# Portless — Handover

_Last updated: 2026-06-22 (mock-removal + real Publish pass)_

**Single-machine private PaaS**: deploy a process on a box you own (no public IP, no open
ports) and publish it to a public `https://*.trycloudflare.com` URL via Cloudflare Tunnel —
from one dashboard. Everything that ships is real and runs on a laptop. The multi-machine
mock apparatus (fabric/scheduler/cluster) was **deleted** — it pretended to do things it
couldn't.

- **Location:** `~/code/personal/portless`
- **git:** initialized 2026-06-22. Baseline commit = state before mock removal.

---

## What it actually does (all real, all laptop-runnable)

1. **Projects** — declarative `portless.yaml` specs + per-project topology graph. Import,
   add/remove domains (optionally route a real Cloudflare tunnel, confirm-gated), delete.
2. **Apps** — real OS processes via `LocalRuntime`: deploy from a template → live health →
   logs → **Publish** (public URL) → stop → clear. Dogfooded end-to-end.
3. **Publish** (the payoff, `runtime/quicktunnel.ts`) — `cloudflared tunnel --url
   http://127.0.0.1:<port>` per app: account-less, ephemeral, no DNS, no open ports.
   Returns a `*.trycloudflare.com` URL; confirm-gated + durable-audited before exposure.
4. **Cloudflare** — real `cloudflared` wrapper (reuses `~/.cloudflared/cert.pem`): list /
   create tunnels, route DNS (mutations confirm-gated).
5. **Orchestrate** — run local `codex` / `claude` CLIs (plan safe, execute confirm-gated, audited).
6. **Mesh** (`runtime/mesh.ts`) — link NAT'd machines over **iroh** via the `dumbpipe` sidecar
   (same spawn pattern as cloudflared). `mesh.share` exposes a local service (e.g. Postgres
   :5432) and returns a node **ticket**; `mesh.connect` dials that ticket and surfaces it on a
   local port as **transparent TCP** — no public IP, no open ports, no account. Dial-by-key
   (Ed25519); iroh hole-punches or relays automatically. Identity is **stable across restarts**
   (`persistentSecret` → `IROH_SECRET`, per-link key under `PORTLESS_STATE_DIR`). Confirm-gated +
   durably audited like publish. Self-host the relay by setting `IROH_RELAY_URL` (can ride a CF tunnel).
   **One-liner bootstrap** (`deploy/mesh-node.sh`, served at `GET /mesh-node.sh`): `curl -fsSL
   https://<hub>/mesh-node.sh | sh -s -- share 5432` on one box, `… connect <ticket> 15432` on
   another — downloads a **prebuilt** dumbpipe (no Rust), persists a stable key, and `share` prints
   the exact `connect` line for the other box. The served script is URL-templated to point at the hub.

Real RBAC (4 perms: app.read / app.deploy / agent.run / audit.read) + bearer auth (dev
posture; prod ships no token, fails closed) + durable JSONL audit + dry-run/confirm envelope.

---

## Run it

```bash
cd ~/code/personal/portless
pnpm install
pnpm dev          # turbo: API (:8787) + dashboard (Vite) in parallel
```

Run in **your own terminal** — background servers spawned by an AI tool get reaped (SIGTERM
143/144); a plainly-launched process stays up. Dev mode auto-uses the bundled `owner-dev-token`.
Vite defaults to :5173 (collides with other Vite apps) — `pnpm --filter @portless/web dev -- --port 4173`.

### Deploy to a server (stable, your domain)

`deploy/install.sh` (run **on the server**): single-origin (the API serves the dashboard +
`/trpc` on one port) behind a **dedicated Cloudflare named tunnel** + your domain, protected by
**Cloudflare Access**. No quick tunnels, no open ports. See `deploy/README.md`.

```bash
PORTLESS_HOSTNAME=portless.yourdomain.com ./deploy/install.sh
```

The API serves the web build when `PORTLESS_WEB_DIR` points at `apps/web/dist` (built with
`VITE_PORTLESS_TOKEN=<token>`); `NODE_ENV=production` makes auth fail-closed, and
`PORTLESS_DEV_TOKENS` re-supplies the one real owner token. **Can't deploy from this Mac**: its
VPN/fake-IP proxy breaks cloudflared↔Cloudflare API (`api.cloudflare.com` → `198.18.x`, EOF).

---

## Verified (this pass)

- `pnpm typecheck` clean (api + web). `pnpm build` clean (web, 1796 modules).
- `pnpm test`: **72 api** + core + Go green (64 + 6 mesh + 2 mesh-serve).
- **Mesh e2e** (`prototypes/relay-experiments/verify-mesh.ts`): real `MeshManager` share→connect of
  a loopback echo service through iroh = **50/50 byte-for-byte**, twice, with an **identical NodeId
  across restarts** (stable ticket). ~107ms here because this Mac's VPN forces the n0 relay path.
- **One-liner bootstrap e2e** (`deploy/mesh-node.sh`): forced the **prebuilt** download (PATH without
  cargo) → real Mach-O binary → share→connect→**25/25 byte-for-byte**, stable NodeId, clean teardown.
  Gotcha found+fixed: a curl `--max-time` readiness probe was *destructive* (abrupt RST tore the
  fresh link down) → switched to a non-destructive `nc -z` scan with a fixed-sleep fallback.
- **Real end-to-end through the HTTP API**: `local.deploy` → process serves on :7801 →
  `local.publish` → `https://sisters-wrote-remarks-pci.trycloudflare.com` → **fetched over the
  public internet, returned the app's HTML** → `local.unpublish` → publicUrl cleared. Audit durable.

---

## What was deleted (was mock / fake-infra theater)

- API: `runtime/{nomad,consul,deploy,secrets,hostinfo,netprobe}.ts`, `network/{netmaker,provider}.ts`,
  the `machines` / `network` / `deployments` routers, `app.deploy`/`app.rollback` (the
  "recorded-no-cluster" mock).
- core: `{nomad,scheduler,ha,wireguard}.ts` (cluster placement / WG rendering for infra that didn't exist).
- web: `Machines.tsx`, `Fabric.tsx` pages + nav.
- All their tests; trimmed dead RBAC perms (machine/network/secret/rollback).

MCP tools now reflect the real surface only: `list_apps`, `get_app_health`, `get_logs`,
`list_processes`, `deploy_app` (→ local.deploy), `publish_app` (→ local.publish).

---

## Gotchas (read before editing)

- **Quick tunnels are safe to live-test** (account-less, ephemeral) — unlike `cloudflare.routeDns`
  / `createTunnel`, which mutate the user's real CF account. Don't live-test those.
- **`codex exec` / `claude -p` hang on open stdin** → redirect `< /dev/null`.
- **TS parameter properties** (`constructor(private x)`) break `node --experimental-strip-types` — use explicit fields.
- Tests are **hermetic** (in-memory, no infra). Publish tests cover the pure arg/URL parsing +
  the guard paths (confirm / not-running) — they never spawn cloudflared.
- The published cloudflared child is in the API's process group, so Ctrl-C on the API takes its
  tunnels down too. (No explicit reaper — `// ponytail`.)

---

## Suggested next steps

1. Real session/cookie auth (the one substantive deferred design decision — bearer token is dev posture).
2. More deploy templates (currently just `static-web`); a "deploy a local dir / git repo" template
   would make Publish genuinely useful day-to-day.
3. If a real multi-box need ever appears, re-introduce a fabric **backed by something that runs**
   (real WireGuard / Tailscale), not a mock allocator.
