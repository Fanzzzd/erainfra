# Acceptance Tests

Portless is not complete until these tests pass.

## Baseline Code

```bash
npm test
./scripts/smoke.sh
```

## Network Tests

1. Add two machines on the same LAN.
   - Expected: path is `lan-direct`.
   - Expected: RTT is close to LAN baseline.

2. Add two machines behind NAT.
   - Expected: NAT punching attempted.
   - Expected: if direct path works, relay is not used.

3. Add one strict CGNAT machine.
   - Expected: relay fallback works.
   - Expected: dashboard explains why relay is used.

4. Disable relay.
   - Expected: affected paths show degraded/unavailable.
   - Expected: app placement avoids broken dependency paths.

## Deployment Tests

1. Deploy two-replica web API.
   - Expected: new release becomes healthy.
   - Expected: old release drains only after new health checks pass.

2. Deploy broken image.
   - Expected: new release fails.
   - Expected: old release stays serving.
   - Expected: error page shows allocation/log reason.

3. Rollback.
   - Expected: previous release becomes active.
   - Expected: audit log records rollback actor and reason.

## Failover Tests

1. Kill one app container.
   - Expected: Nomad restarts or replaces it.
   - Expected: Consul removes unhealthy instance until healthy.

2. Power off one worker machine.
   - Expected: services with enough replicas keep serving.
   - Expected: Portless reschedules missing replicas if policy allows.

3. Power off gateway node.
   - Expected: another gateway connector serves ingress if configured.

4. Power off database node.
   - Expected: dashboard does not pretend stateless failover is possible.
   - Expected: database-specific warning appears.

## UX Tests

1. Load 20 sample apps.
   - Expected: overview is readable.
   - Expected: sorting by unhealthy works.

2. Inspect an unhealthy app.
   - Expected: UI shows exact failing layer: build, allocation, health, route, network, dependency, or secret.

3. Inspect service dependencies.
   - Expected: UI shows RTT/path for each dependency.

## Security Tests

1. Developer role tries to drain machine.
   - Expected: denied.

2. Viewer tries to read secret value.
   - Expected: value is never returned.

3. MCP tries dangerous command without confirmation.
   - Expected: blocked.

4. Agent receives unknown command type.
   - Expected: rejected and audited.

