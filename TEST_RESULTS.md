# Test Results

## Commands

```bash
pnpm install
npm test            # 53 Node tests + Go agent tests
./scripts/smoke.sh  # boots Fastify, curls /health + /api/sample-plan
cd apps/web && pnpm build   # dashboard production build
```

## Latest Result (all 10 milestone cores + real local runtime + shadcn UI)

- Node tests: **56 passed** — rbac, auth, audit, tRPC, drizzle schema, appspec,
  network provider, MCP tools, runtime (nomad/consul/deploy), cloudflare, secrets,
  **local process runtime (spawns a real server, HTTP health-checks it, stops it)**.
- Go agent tests: passed — install plan, allowlist, resources, heartbeat, benchmark.
- Smoke test: exit 0.
- Dashboard: **rebuilt with shadcn/ui (Tailwind v4)**; `vite build` succeeds.
- Verified live (real browser, http://localhost:5173):
  - All 5 pages render with **zero console errors**: Overview, Projects, Apps, Machines, Fabric.
  - **Manage real running projects on this machine**: deployed a process via the UI →
    it served HTML + `/health=ok` on its port → showed `running` + `passing` health,
    PID, uptime → `Stop` killed it. End-to-end through Fastify+tRPC.
  - Apps page renders 21 apps cleanly (live + 20 demo) — "20+ at a glance".
  - `GET /trpc/audit.list` unauthenticated → `401`; viewer `app.deploy` → `403`.
  - node-agent `op` rejects `sshd` (exit 1), allows `portless-nomad` (no raw shell).
  - Deployment workflow (mocks): broken release auto-reverts, old keeps serving; rollback works.

## Local runtime note

Docker Desktop's engine was degraded on this box (500s even on downgraded API), so the
"manage running projects on this machine" capability is built on a real **LocalRuntime**
process manager (`apps/api/src/runtime/local.ts`) that spawns argv directly (no shell),
captures logs to disk, and does real HTTP health checks. A Docker adapter slots behind the
same surface when the daemon recovers.

## Milestone Status

- [x] **M0** baseline — tests + smoke green.
- [x] **M1** production API foundation — Fastify + tRPC + Zod, auth/RBAC/audit,
      Drizzle schema, dangerous-op safety envelope (RBAC + audit + dry-run + confirm).
- [x] **M2** AppSpec parser/validator + domain models + init migration + import path.
- [x] **M3** NetworkProvider interface + Netmaker MVP (WG IP + container-subnet
      allocation, key rotation/revocation, peer routes, path matrix).
- [x] **M4** Go node-agent MVP — enrollment, heartbeat, resources, command allowlist
      (no raw shell), systemd guard (portless-* only), TCP benchmark.
- [x] **M5** Nomad + Consul providers (interface + mock; job submit/status/logs,
      unique-node placement, service catalog/health, naming convention).
- [x] **M6** Cloudflare provider (interface + mock; tunnel/DNS/route, gateway config,
      ingress-only guard, tunnel health).
- [x] **M7** Deployment workflow (Temporal-ready, runs on provider interfaces):
      zero-downtime preflight, health + Consul gates, drain-after-healthy,
      auto-revert, rollback — fully tested with mocks.
- [x] **M8** Dashboard — **shadcn/ui** (Tailwind v4): sidebar nav, Overview, Projects
      (real local process management: deploy dialog, live health, logs, stop), Apps
      (filterable, 20+), Machines, Fabric. Verified live in a real browser, no console errors.
- [x] **M9** MCP tools — 9 tools operating the tRPC API (never shell); dangerous
      actions inherit RBAC + dry-run/confirm + audit.
- [~] **M10** Hardening — secret rotation + backup/restore done & tested. Operational
      remainder below.

## What is mock vs live (honest scope)

Verified on this machine: the full control-plane logic, safety envelopes, Go agent,
and deployment state machine — all behind provider interfaces with mock backends.

NOT yet live (needs real infra, can't run on a laptop): actual Netmaker/WireGuard
fabric, real Nomad/Consul clusters, the Cloudflare API, a Temporal worker, and a
running Postgres (the API runs on in-memory stores; `0001_init.sql` is ready). Each
has a typed seam (`NetworkProvider`, `NomadProvider`, `ConsulProvider`,
`CloudflareProvider`, `Cipher`, repository/audit interfaces) so wiring the live
adapter is additive and does not change the tested core.

## M10 operational remainder (not code-verifiable here)

- Agent auto-update (version field exists on heartbeat; needs release channel).
- Gateway HA (run 2+ cloudflared gateways; Cloudflare load-balances).
- Relay support (relay role + path priority already modeled; needs deployed relays).
- Metrics/logs integration (Prometheus/Loki).
- Failure drills + complete install docs.
