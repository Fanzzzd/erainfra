# Final architecture

## Default mode

```text
Cloudflare DNS / Tunnel
        |
        v
Traefik/Caddy gateway on one or more nodes
        |
        v
Consul service catalog
        |
        v
Nomad allocations over kernel WireGuard
        |
        v
Docker/containerd containers on private machines
```

## Internal network

Portless uses a performance-first WireGuard fabric.

Path priority:

1. localhost / same machine
2. LAN direct
3. public IPv6 WireGuard direct
4. public IPv4 WireGuard direct
5. NAT-punched WireGuard direct
6. nearest self-hosted relay
7. Cloudflare Mesh emergency fallback only

## Uncloud-inspired idea

Each machine owns a machine subnet, for example:

```text
machine-a: 10.210.0.0/24
machine-b: 10.210.1.0/24
machine-c: 10.210.2.0/24
```

Containers on each host get unique IPs from that host's subnet. WireGuard peer routes include both the peer's node IP and its container subnet, so containers can communicate directly across hosts without exposing host ports.

## Runtime responsibilities

Portless owns:

- AppSpec model
- placement policy
- dependency-aware scheduling hints
- WireGuard route intent
- Nomad job rendering
- Cloudflare tunnel rendering
- dashboard/API/audit

External systems own:

- Netmaker: WireGuard key exchange, NAT traversal, relay fallback, netclient lifecycle
- Nomad: scheduling, rolling deploy, job state
- Consul: service registry, DNS, health checks
- Cloudflare Tunnel: public ingress with no public IP
- Traefik/Caddy: HTTP routing to healthy services
