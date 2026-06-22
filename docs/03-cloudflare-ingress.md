# Cloudflare Ingress Design

Cloudflare is used for public ingress, DNS automation, and bootstrap endpoints. It should not be the default internal service data plane.

## User Requirement

The user needs:

- A Cloudflare account.
- A domain connected to Cloudflare.
- Machines that can make outbound HTTPS connections.

The user does not need:

- Public IPs for app machines.
- Open inbound ports.
- SSH exposed to the internet.
- A VPS, unless they want optional regional relays.

## Public Routing

```text
app.example.com
  -> Cloudflare DNS
  -> Cloudflare Tunnel
  -> cloudflared connector on gateway node
  -> Traefik/Caddy
  -> Consul healthy service
  -> WireGuard fabric
  -> target allocation
```

## Gateway Nodes

A gateway node runs:

- cloudflared.
- Traefik or Caddy.
- Consul agent.
- Portless agent.

Multiple gateway nodes can run connectors for the same tunnel to improve ingress availability.

## Tunnel Strategy

Prefer a small number of tunnels routed to the internal gateway layer instead of one tunnel per container:

```text
wildcard tunnel: *.example.com -> Traefik
service tunnel: api.example.com -> Traefik
panel tunnel: panel.example.com -> Portless API
agent tunnel: agent.example.com -> Portless API
```

Traefik/Caddy should route from Host header to Consul services. This keeps Cloudflare simple and keeps service health inside Portless/Nomad/Consul.

## Bootstrap Endpoints

Expose:

```text
https://panel.example.com
https://agent.example.com
https://install.example.com/install.sh
```

These can be backed by the same Portless API service.

## Cloudflare Automation Tasks

Portless should automate:

- Zone selection.
- Tunnel creation.
- DNS record creation.
- Wildcard route creation.
- cloudflared token distribution to gateway nodes.
- Tunnel health display.

## Worker Usage

Workers can optionally host install bootstrap logic, pre-auth checks, lightweight API proxy, or AI edge tools. Workers must not be used as the internal data-plane relay.

