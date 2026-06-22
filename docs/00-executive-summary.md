# Portless Executive Summary

Portless is a private PaaS for machines that may have no public IP address. The product goal is to make a fleet of arbitrary machines feel like one high-performance application platform while keeping custom code as small as possible.

The core promise:

> Deploy anywhere. Open no ports. Keep the data path fast.

Portless is not a new container scheduler, not a new VPN protocol, and not a Kubernetes clone. It is an integration-first control plane that combines mature projects:

- Cloudflare Tunnel for public ingress and bootstrap access.
- Netmaker-managed Linux kernel WireGuard for high-performance machine-to-machine networking.
- Nomad for scheduling, rolling deployment, rescheduling, and rollback.
- Consul for service discovery and health checks.
- Traefik or Caddy for HTTP routing to healthy internal services.
- Docker/containerd for runtime.
- Postgres for Portless metadata.
- Temporal for durable deployment workflows.
- A small Go node agent for installation, health, networking, and controlled host actions.
- A Vite + React + TypeScript dashboard.

Portless should compete with Dokploy, Coolify, Komodo, Uncloud-like tools, and self-hosted PaaS alternatives by solving the hardest missing piece: high-performance private networking between machines that do not expose inbound ports.

## Product Differentiation

Existing self-hosted PaaS tools are usually optimized for one of these models:

1. A single Docker host.
2. Docker Swarm or Compose over SSH.
3. Kubernetes and GitOps.
4. Hosted platform abstractions.
5. CLI-first multi-machine Docker experiments.

Portless targets a different shape:

- The user has 20+ apps and several machines.
- Many machines are behind NAT or CGNAT.
- The user can own a Cloudflare-connected domain.
- The user wants real machine interconnect, not just public ingress.
- The user wants zero-downtime deploys, failover, logs, dependencies, and a dashboard.
- The user accepts complex configuration if scripts and AI automate it.
- Internal performance matters; Cloudflare Mesh is acceptable only as fallback, not as the primary data plane.

## Non-Negotiable Design Principles

1. Performance-first internal networking.
   - Internal service traffic should prefer direct kernel WireGuard paths.
   - Cloudflare is not the default internal data path.

2. No mandatory public IP for app machines.
   - Cloudflare Tunnel handles public ingress.
   - WireGuard fabric handles private inter-machine traffic.
   - Regional relay nodes are fallback only when direct paths fail.

3. Minimal custom code.
   - Do not rewrite Nomad, Consul, WireGuard, Traefik, or Cloudflare Tunnel.
   - Write the product layer, policy engine, agent glue, UI, API, and automation.

4. No arbitrary shell as a product API.
   - The agent has whitelisted operations only.
   - Dangerous actions require RBAC, audit logs, dry-run, and confirmation.

5. AI-native but safe.
   - AI agents operate Portless APIs and MCP tools.
   - AI should not SSH into machines or mutate random files directly.

6. Honest HA.
   - Stateless services can fail over.
   - Stateful databases need explicit HA, backup, restore, and placement policies.
   - Portless must explain when zero downtime or failover is unsafe.

