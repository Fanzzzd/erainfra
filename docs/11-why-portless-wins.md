# Why Portless Should Beat Existing Alternatives

This document is a product target, not a marketing claim. The goal is to build a platform that beats the current alternatives for this specific user profile.

## Target User

- Has many small and medium projects.
- Uses several machines, some without public IPs.
- Wants a dashboard, not just CLI.
- Wants high-performance internal traffic.
- Wants zero-downtime deploys and failover.
- Wants AI-assisted operations.
- Accepts advanced infrastructure if setup is automated.

## Dokploy / Coolify Class

Strengths:

- Easy single-machine or simple multi-machine deployment.
- Good developer experience.
- Familiar Docker/Compose workflows.

Portless target advantages:

- First-class private machine fabric.
- Performance-aware scheduling.
- Built-in dependency latency visibility.
- No SSH-centric mental model.
- Better failover model via Nomad/Consul.
- Cloudflare ingress without public IPs.
- AI-safe platform API instead of shell-driven ops.

## Uncloud Class

Strengths:

- Elegant WireGuard-backed multi-machine Docker direction.
- Lightweight mental model.
- Good inspiration for per-machine container subnets.

Portless target advantages:

- Dashboard-first.
- Production deployment workflows.
- Rescheduling and failure handling.
- Release history and rollback.
- Network optimizer UI.
- Nomad/Consul runtime and health ecosystem.

## Kubernetes PaaS Class

Strengths:

- Mature orchestration.
- Rich ecosystem.
- GitOps and extensibility.

Portless target advantages:

- Less YAML exposure.
- Better fit for private/no-public-IP machines.
- Lower network-layer complexity.
- Easier to reason about host-level performance paths.
- Smaller product surface for personal/small-team fleet.

## Success Standard

Portless wins only if a user can:

1. Add machines with one command.
2. Deploy an app with a domain in minutes.
3. See exactly where every service runs.
4. See whether internal traffic is direct or relayed.
5. Deploy without downtime when preconditions are met.
6. Survive common node failures.
7. Roll back quickly.
8. Let AI inspect and operate safely.

