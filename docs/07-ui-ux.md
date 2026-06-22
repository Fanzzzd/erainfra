# UI / UX Plan

The UI must make 20+ projects manageable at a glance.

## Navigation

```text
Overview
Apps
Machines
Fabric
Deployments
Domains
Secrets
Logs
Incidents
Settings
```

## Overview Page

Show:

```text
Apps healthy / degraded / failed
Machines online / offline
Deployments in progress
Network paths degraded
Zero-downtime blockers
Incidents
```

## Apps Page

A table optimized for operations:

```text
App
Environment
Status
Release
Replicas
Machines
Dependencies
Last deploy
Actions
```

Actions:

```text
deploy
rollback
logs
metrics
open domain
explain status
```

## App Detail Page

Tabs:

```text
Overview
Services
Deployments
Logs
Metrics
Domains
Secrets
Dependencies
Placement
Settings
```

Must show:

- Current release.
- Health checks.
- Replica distribution by machine.
- Dependency RTT and path kind.
- Zero-downtime readiness.
- Why a service cannot fail over.

## Machines Page

Show:

```text
machine name
roles
region
agent status
WireGuard status
Nomad status
Consul status
resources
running services
network warnings
```

Actions:

```text
cordon
drain
uncordon
collect diagnostics
run benchmark
rotate key
promote gateway
```

## Fabric Page

This is a differentiator.

Show:

- Network topology.
- Path matrix.
- Direct vs relay vs fallback.
- RTT / throughput / loss.
- Recommendations.
- Service dependency quality.

## Deployment Page

Show step-by-step progress:

```text
✓ build image
✓ push image
✓ submit Nomad job
✓ allocation started on machine-a
✓ health check passed
✓ allocation started on machine-b
✓ health check passed
✓ old allocation drained
✓ release stable
```

Failure should show precise cause and suggested action.

