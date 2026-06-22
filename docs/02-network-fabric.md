# Network Fabric Design

## Goal

Create a high-performance private machine network for machines that may not have public IP addresses or open inbound ports.

Cloudflare Tunnel solves public ingress, but it does not solve fast machine-to-machine traffic. Cloudflare Mesh is useful as a fallback or optional compatibility layer, but it should not be the default data plane when performance is the priority.

## Default Data Plane

Use Linux kernel WireGuard.

MVP implementation uses Netmaker to reduce custom code:

```text
Portless API -> Netmaker API -> netclient -> kernel WireGuard
```

Netmaker handles network membership and WireGuard configuration. Portless adds product-level policy, path scoring, scheduling, UI, and deployment integration.

## Path Priority

Portless should maintain a path matrix between all machines and choose the best available path:

1. Same machine / localhost.
2. Same LAN direct.
3. Public IPv6 direct WireGuard.
4. Public IPv4 direct WireGuard.
5. NAT-punched direct WireGuard.
6. Nearest self-managed regional relay.
7. Cloudflare Mesh emergency fallback.

The default internal dependency path should never be Cloudflare Mesh if a direct or faster self-managed relay path exists.

## Uncloud-Inspired Container Subnet Routing

Portless should borrow the strongest part of Uncloud's WireGuard design: each machine gets a node WireGuard IP and a per-machine container subnet.

Example:

```text
machine-a:
  wgIp: 10.88.0.10
  containerSubnet: 10.210.0.0/24

machine-b:
  wgIp: 10.88.0.11
  containerSubnet: 10.210.1.0/24
```

WireGuard peer routes include both:

```text
AllowedIPs = 10.88.0.11/32, 10.210.1.0/24
```

This allows containers on different machines to communicate across the fabric without forcing all traffic through public ingress.

## NAT Reality

Direct WireGuard cannot always be established. If both sides are behind strict NAT or CGNAT and punching fails, a relay is required. Portless should be honest and automatic:

- Try all direct candidates.
- Benchmark latency, throughput, loss, and jitter.
- Use relay only when direct is impossible or slower.
- Show exactly why a path uses relay.
- Generate router/port-forward/IPv6 recommendations when direct path is possible with user action.

## Regional Relay Strategy

Relays should be optional and self-managed. They should run near users and provide high-performance fallback:

```text
relay-sg
relay-hk
relay-tyo
relay-lax
relay-fra
```

Each relay can run:

- WireGuard relay/router.
- STUN endpoint.
- Benchmark endpoint.
- Portless relay-agent.

Relays should not run user workloads by default.

## Network Optimizer UI

The dashboard should show:

```text
machine-a <-> machine-b
  active: lan-direct
  rtt: 2ms
  throughput: 940Mbps
  loss: 0.0%
  status: optimal

machine-b <-> machine-c
  active: regional-relay
  rtt: 35ms
  throughput: 280Mbps
  warning: direct path failed due to strict NAT
  recommendation: enable IPv6 or open UDP 51820
```

## Provider Interface

The API should define a provider boundary:

```ts
interface NetworkProvider {
  enrollMachine(input): Promise<EnrollmentResult>
  revokeMachine(machineId): Promise<void>
  rotateMachineKey(machineId): Promise<void>
  listPeers(): Promise<NetworkPeer[]>
  getPathMatrix(): Promise<PathMatrix>
  applyRoutes(plan): Promise<void>
}
```

Implementations:

- NetmakerNetworkProvider for MVP.
- PortlessWireGuardProvider later.
- CloudflareMeshProvider only as fallback or optional mode.

