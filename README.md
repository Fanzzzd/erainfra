# Portless

Portless is an integration-first private PaaS for machines that may not have public IP addresses.

**Mission:** Deploy anywhere. Open no ports. Keep internal traffic fast.

Portless keeps custom code intentionally small:

- **Cloudflare Tunnel**: public ingress and bootstrap endpoint.
- **Netmaker / Linux kernel WireGuard**: high-performance machine-to-machine network.
- **Nomad**: scheduling, rolling deployments, rescheduling, rollback.
- **Consul**: service discovery and health checks.
- **Traefik or Caddy**: HTTP routing from Cloudflare Tunnel to healthy internal services.
- **Portless control plane**: dashboard, AppSpec model, deployment workflows, placement policy, network path policy, audit API, MCP tools.
- **Portless node-agent**: controlled machine install/heartbeat/maintenance logic.

This repository is a tested starting point plus a complete product/agent build plan. It is meant to be handed to an AI coding agent with `prompts/SETGOAL_PROMPT.md`.

## Run Tests

Requires Node.js 22+, Go 1.23+, and pnpm 9+.

```bash
pnpm install   # installs API deps (Fastify, tRPC, Zod, Drizzle)
npm test
./scripts/smoke.sh
```

## Dev API

```bash
npm run api:dev
curl http://localhost:8787/health
curl http://localhost:8787/api/sample-plan
```

## Dashboard (shadcn/ui)

Run the API and the dashboard, then open http://localhost:5173:

```bash
npm run api:dev                      # control plane on :8787
pnpm --filter @portless/web dev      # dashboard on :5173 (proxies /trpc to the API)
```

The **Projects** page manages real running processes on this machine: deploy a
template, watch live HTTP health, tail logs, and stop — no cluster or Docker required
(see `apps/api/src/runtime/local.ts`).

## Important Docs

```text
docs/00-executive-summary.md       Product summary and principles
docs/01-final-architecture.md      Final architecture
docs/02-network-fabric.md          WireGuard/Netmaker/relay design
docs/03-cloudflare-ingress.md      Cloudflare Tunnel design
docs/04-runtime-and-scheduler.md   Nomad/Consul runtime design
docs/05-node-agent.md              Go agent design
docs/06-data-model.md              Product data model
docs/07-ui-ux.md                   Dashboard design
docs/08-security-and-safety.md     Security and AI safety
docs/09-development-roadmap.md     Incremental build plan
docs/10-acceptance-tests.md        Done criteria
docs/11-why-portless-wins.md       Product differentiation target
docs/12-api-and-mcp-contracts.md   API/MCP shape
docs/13-agent-implementation-playbook.md AI coding guide
prompts/SETGOAL_PROMPT.md          Full prompt for setgoal
prompts/SHORT_SETGOAL_PROMPT.md    Short prompt for setgoal
AGENT_TASKS.yaml                   Machine-readable milestone manifest
```

## Repo Layout

```text
apps/web                 Vite React dashboard shell
apps/api                 Fastify + tRPC + Zod control-plane API (auth/RBAC/audit scaffold)
packages/core            AppSpec, scheduler, HA policy, WireGuard/Nomad/Cloudflare renderers
agents/node-agent        Go agent skeleton and install plan logic
infra/compose            Example integration compose files
examples/portless.yaml   Example app spec
prompts                  AI-agent prompts
.agent                   Agent goal metadata
```

## Why Not Put the Data Plane on Cloudflare Mesh?

Cloudflare Tunnel is excellent for public ingress without a public IP, but internal service traffic should use direct Linux kernel WireGuard when performance matters. Portless uses Cloudflare for entry/bootstrap and uses Netmaker or a future custom WireGuard orchestrator for the internal data plane.

Cloudflare Mesh can be supported later as an emergency fallback or compatibility mode, but not as the default internal path.

