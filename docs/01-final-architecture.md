# Final Architecture

## High-Level System

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
Docker/containerd containers on arbitrary machines
```

Portless owns the control plane:

```text
Vite React Dashboard
        |
        v
TypeScript API / Control Plane
        |
        +--> Postgres metadata
        +--> Temporal deployment workflows
        +--> Netmaker API / future wg-orchestrator
        +--> Nomad API
        +--> Consul API
        +--> Cloudflare API
        +--> Go node-agent command channel
```

## Main Components

### Portless Console

The browser UI. It shows apps, machines, deployments, logs, domains, secrets, network path quality, failover readiness, and suggested actions.

### Portless API

The product API. It stores desired state, validates AppSpec, handles RBAC, exposes tRPC/REST endpoints, orchestrates workflows, and provides MCP tools later.

### Portless Worker

Temporal worker that runs long workflows:

- Build image.
- Push image.
- Render Nomad jobs.
- Submit jobs.
- Wait for healthy allocations.
- Update routing.
- Drain old allocations.
- Roll back on failure.
- Record audit trail.

### Portless Agent

A Go daemon installed on every machine. It performs whitelisted host operations:

- Register machine.
- Install/update netclient or future wg-agent.
- Install/update Nomad client.
- Install/update Consul agent.
- Install/update cloudflared when the node is a gateway.
- Report heartbeat and resources.
- Report network path benchmarks.
- Stream logs.
- Execute cordon/drain/restart actions with audit and confirmation.

### Network Backend

MVP: Netmaker-managed Linux kernel WireGuard.

Future: replace or complement Netmaker with a Portless `wg-orchestrator` if Netmaker becomes limiting.

### Runtime Backend

Nomad schedules containers. Consul registers services and health checks. Traefik/Caddy routes HTTP to healthy services from the Consul catalog.

## Deployment Data Flow

```text
User clicks Deploy
  -> Portless creates Release
  -> Temporal workflow starts
  -> Build image or use prebuilt image
  -> Push image to registry
  -> Render Nomad job
  -> Submit job
  -> Nomad starts new allocations
  -> Consul health checks pass
  -> Traefik routes to healthy instances
  -> Old allocations drain
  -> Release becomes stable
```

## Network Data Flow

Public request:

```text
user -> Cloudflare -> cloudflared -> Traefik -> Consul healthy service -> WireGuard path -> app container
```

Internal service request:

```text
api container -> postgres.service.consul -> WireGuard direct path -> database machine -> postgres container
```

Control plane request:

```text
node-agent -> Cloudflare Tunnel endpoint -> Portless API
```

