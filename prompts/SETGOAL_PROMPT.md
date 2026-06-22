# Setgoal Prompt for AI Coding Agent

You are the lead AI engineer for this repository. Your goal is to turn this Portless monorepo into a fully usable private PaaS that is superior to Dokploy/Coolify-style alternatives for users with many projects and machines that may not have public IP addresses.

## Product Name

Portless

## One-Sentence Mission

Build Portless: a dashboard-first, high-performance, no-public-IP private PaaS that uses Cloudflare Tunnel for ingress, kernel WireGuard for internal machine networking, Nomad for scheduling, Consul for service discovery, and a safe Go node-agent for machine operations.

## Non-Negotiable Requirements

1. The user should only need a Cloudflare-connected domain and outbound internet access on machines.
2. App machines must not require public IPs or open inbound ports.
3. Internal service traffic must prioritize performance: direct Linux kernel WireGuard first, relay only when direct is impossible, Cloudflare Mesh only as emergency fallback or optional compatibility mode.
4. Do not implement a custom container scheduler. Use Nomad.
5. Do not implement a custom service discovery system. Use Consul.
6. Do not implement a custom public ingress tunnel. Use Cloudflare Tunnel.
7. Do not write excessive custom code. Build the product/control layer and integrate mature projects.
8. Do not expose arbitrary remote shell as a feature. The agent may only execute whitelisted, audited commands.
9. Deployments must support zero-downtime behavior when preconditions are met: 2+ replicas, readiness health check, unique-machine placement, Consul health passing before traffic, graceful drain before shutdown.
10. Stateful databases must not be falsely marked as automatically failover-safe. Show warnings and require explicit HA/backup policy.
11. The dashboard must make 20+ apps manageable: app health, release, machines, dependencies, logs, domains, network paths, and rollback must be visible.
12. AI/MCP operations must be safe, RBAC-protected, audited, and confirmation-gated for dangerous actions.

## Architecture to Build

Use this architecture:

```text
Cloudflare DNS / Tunnel
        |
        v
gateway nodes: cloudflared + Traefik/Caddy
        |
        v
Consul service catalog
        |
        v
Nomad allocations
        |
        v
Linux kernel WireGuard direct fabric
        |
        v
Docker/containerd containers
```

Control plane:

```text
Vite React Dashboard
  -> TypeScript API using Fastify + tRPC + Zod
  -> Postgres + Drizzle
  -> Temporal workers for deployments
  -> Netmaker provider for WireGuard MVP
  -> Nomad provider
  -> Consul provider
  -> Cloudflare provider
  -> Go node-agent command channel
```

## Important Design Inspiration

Use Uncloud's WireGuard/container-network idea as inspiration, but do not clone Uncloud as the platform. Each machine should have:

```text
wgIp: 10.88.0.x
containerSubnet: 10.210.x.0/24
```

WireGuard peers should route both the node IP and the container subnet:

```text
AllowedIPs = 10.88.0.11/32, 10.210.1.0/24
```

Portless adds dashboard, scheduling, release management, failure handling, network optimizer, and AI-safe control APIs.

## Existing Repository

This repo already contains a tested skeleton:

```text
apps/web                 Vite React shell
apps/api                 minimal API skeleton
packages/core            scheduler, HA policy, renderers, sample data, tests
agents/node-agent        Go agent install-plan skeleton and tests
infra/compose            reference compose files
examples/portless.yaml   sample AppSpec
docs/                    product and architecture specs
```

Before making changes, run:

```bash
npm test
./scripts/smoke.sh
```

Keep these passing after every milestone.

## Implementation Milestones

### Milestone 1: Production API Foundation

Replace the minimal Node HTTP API with:

- Fastify
- tRPC
- Zod
- Drizzle
- Postgres
- Auth scaffold
- RBAC scaffold
- Audit log

Keep `/health` and `/api/sample-plan` or equivalent sample endpoints working.

### Milestone 2: AppSpec and Database

Implement:

- AppSpec parser and validator for `portless.yaml`
- Project/environment/service/domain/secret/machine models
- Drizzle migrations
- Import sample app spec
- Validation errors that are helpful and actionable

### Milestone 3: Network Provider

Implement a provider interface and Netmaker MVP:

- `NetworkProvider`
- `NetmakerNetworkProvider`
- mock tests
- machine enrollment plan
- WireGuard IP allocation
- container subnet allocation
- key rotation/revocation interface
- path matrix model

Do not hardwire Netmaker everywhere; keep provider swappable for a future custom `wg-orchestrator`.

### Milestone 4: Go Node Agent MVP

Implement:

- enrollment
- heartbeat
- dry-run install plan
- system resource reporting
- command allowlist
- systemd unit management for Portless-owned services
- network benchmark command
- log collection skeleton

No arbitrary shell execution.

### Milestone 5: Nomad and Consul Providers

Implement:

- Nomad job submit
- job status watch
- allocation logs
- deployment status mapping
- Consul service catalog read
- Consul health check read
- Consul DNS/service naming conventions

### Milestone 6: Cloudflare Provider

Implement:

- Cloudflare account/zone setup
- tunnel creation
- DNS record creation
- route creation
- cloudflared token delivery to gateway agent
- tunnel/gateway health display

Cloudflare Tunnel is ingress only. Do not route internal service dependencies through Cloudflare Tunnel.

### Milestone 7: Deployment Workflows

Add Temporal and implement:

- build image or use prebuilt image
- push image
- render Nomad job
- submit job
- wait for allocation health
- wait for Consul healthy service
- drain old allocations
- auto-revert on failure
- persist deployment steps and events

### Milestone 8: Dashboard

Build Vite React UI:

- Overview
- Apps
- App detail
- Machines
- Fabric / Network Optimizer
- Deployments
- Logs
- Domains
- Secrets
- Settings

UI must explain failures and blockers clearly.

### Milestone 9: AI/MCP

Implement MCP tools:

- list_apps
- get_app_health
- deploy_app
- rollback_release
- get_logs
- explain_failed_deployment
- list_machines
- get_network_matrix
- run_network_benchmark

Dangerous actions require dry-run and confirmation.

### Milestone 10: Production Hardening

Add:

- backup/restore
- secret rotation
- agent auto-update
- gateway HA
- relay support
- metrics/logs integration
- failure drills
- install docs

## Acceptance Tests

Portless is not done until these pass:

1. Add at least two no-public-IP machines.
2. Establish WireGuard fabric and show path quality.
3. Deploy a two-replica web app.
4. Access it through Cloudflare Tunnel.
5. Verify internal dependency traffic uses WireGuard, not Cloudflare Tunnel.
6. Deploy a broken release; old release stays serving.
7. Roll back a release.
8. Power off a worker; stateless service survives if enough replicas exist.
9. Show database/stateful services as not automatically failover-safe unless explicit HA is configured.
10. Dashboard can manage 20 sample apps without becoming unreadable.
11. Agent rejects unknown/raw shell commands.
12. AI/MCP dangerous action requires confirmation and audit log.

## Coding Rules

- Keep custom code minimal and modular.
- Prefer interfaces around external systems.
- Add tests before or with implementation.
- Never leave the repo in a failing test state.
- Do not remove existing tests unless replacing them with stronger tests.
- Update docs when changing architecture.
- Use TypeScript for control plane and UI.
- Use Go for node-agent/system-level operations.
- Do not use Rust unless there is a specific, justified need.

## First Action

Start by reading:

1. `README.md`
2. `docs/00-executive-summary.md`
3. `docs/01-final-architecture.md`
4. `docs/02-network-fabric.md`
5. `docs/09-development-roadmap.md`
6. `docs/10-acceptance-tests.md`

Then run:

```bash
npm test
./scripts/smoke.sh
```

Then begin Milestone 1.
