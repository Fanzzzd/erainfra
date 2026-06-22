# Runtime, Scheduling, and Service Discovery

## Why Nomad + Consul

Portless prioritizes performance and simplicity under a non-standard networking constraint. Nomad and Consul fit this better than forcing every deployment into a full Kubernetes overlay stack.

Nomad handles:

- Container scheduling.
- Rolling deployments.
- Rescheduling on node failure.
- Restart policies.
- Resource constraints.
- Update strategy and auto-revert.

Consul handles:

- Service registration.
- Health checks.
- Service discovery.
- DNS for internal dependencies.

Traefik/Caddy handles:

- HTTP routing.
- Only sending traffic to healthy instances.
- Hostname to service mapping.

## Placement Model

Portless scheduler should add product-level placement before submitting Nomad jobs.

Inputs:

- Machine roles.
- Machine online/offline status.
- CPU/memory/disk availability.
- Service dependencies.
- Network path matrix.
- Required roles and avoided roles.
- Stateful/sticky service policies.
- Region and latency preferences.

Outputs:

- Candidate machine set.
- Warnings and blockers.
- Nomad constraints and affinities.
- HA readiness score.

## Zero-Downtime Model

A web/API service is zero-downtime ready only if:

- replicas >= 2.
- readiness health check exists.
- replicas are spread across unique machines.
- at least one healthy old replica remains while new replicas start.
- new replicas pass Consul health checks before routing.
- old replicas deregister from Consul before shutdown.
- graceful shutdown and drain delay are configured.

Database services are never automatically zero-downtime unless a database-specific HA mode is configured.

## Deployment Lifecycle

```text
build image
push image
render Nomad job
submit job
wait for new allocations
wait for Consul health
update route visibility
wait for drain
stop old allocations
mark release stable
```

If new allocation fails:

```text
keep old allocations serving
mark release failed
surface logs and health check errors
allow rollback or retry
```

## Internal DNS

Services should reference each other through Consul DNS:

```text
api.service.consul
postgres.service.consul
redis.service.consul
```

The dashboard must discourage hardcoded machine IPs for app dependencies.

