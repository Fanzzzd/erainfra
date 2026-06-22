# Development Roadmap

This roadmap is intended for an AI coding agent to execute incrementally. Keep the repo working after every milestone.

## Milestone 0: Baseline

- Keep current tests passing.
- Add lint/typecheck scripts when dependencies are introduced.
- Keep docs and examples synchronized.

Acceptance:

```bash
npm test
./scripts/smoke.sh
```

## Milestone 1: Real API Foundation

Replace dependency-free API skeleton with production stack:

- Fastify.
- tRPC.
- Zod.
- Drizzle.
- Postgres.
- Auth scaffold.
- RBAC scaffold.
- Audit log table.

Acceptance:

- `/health` works.
- tRPC app/machine/deployment routers exist.
- Drizzle migrations run.
- Tests cover auth boundary and audit creation.

## Milestone 2: AppSpec and Database Model

Implement:

- AppSpec parser/validator.
- Project/environment/service CRUD.
- Domain CRUD.
- Secret write-only CRUD.
- Machine model.
- Network path model.

Acceptance:

- Example `examples/portless.yaml` imports successfully.
- Invalid AppSpec returns actionable errors.

## Milestone 3: Netmaker Integration

Implement `NetmakerNetworkProvider`:

- Create network.
- Enroll machine.
- Revoke machine.
- Rotate key.
- Pull peer/path state where available.
- Store node wg IP and container subnet.

Acceptance:

- Mock tests pass.
- Integration guide documents required Netmaker env vars.
- Agent install plan can enroll a node.

## Milestone 4: Agent MVP

Implement Go agent real functionality:

- Register with API.
- Heartbeat.
- Run install plan.
- Report resources.
- Manage systemd units for Portless-owned services.
- Run network benchmark.

Acceptance:

- Agent can run in dry-run mode locally.
- Agent tests cover command allowlist.
- API receives heartbeat.

## Milestone 5: Nomad + Consul Integration

Implement:

- Nomad job submit.
- Job status watch.
- Allocation log stream.
- Consul health read.
- Service catalog read.

Acceptance:

- Deploy sample app to a local/dev Nomad cluster.
- Logs stream to UI/API.
- Health status is accurate.

## Milestone 6: Cloudflare Integration

Implement:

- Cloudflare account/zone setup.
- Tunnel creation.
- DNS route creation.
- cloudflared token delivery to gateway agent.
- Gateway health display.

Acceptance:

- Create `api.example.com` route from UI/API.
- Render and apply cloudflared config.
- Show tunnel connector status.

## Milestone 7: Deploy Workflow

Implement Temporal workflows:

- Build image.
- Push image.
- Submit Nomad job.
- Wait for health.
- Drain old version.
- Auto-revert on failure.
- Persist deployment steps.

Acceptance:

- Deployment page updates live.
- Failed release keeps old version serving.
- Rollback works.

## Milestone 8: Dashboard UX

Implement Vite React UI:

- Overview.
- Apps.
- App detail.
- Machines.
- Fabric.
- Deployments.
- Logs.
- Domains.
- Settings.

Acceptance:

- 20 sample projects are manageable from overview.
- Each failed state has a reason, not just a red badge.

## Milestone 9: AI / MCP

Implement MCP server:

- list apps.
- health.
- deploy.
- rollback.
- logs.
- explain failed deployment.
- machine status.
- network status.

Acceptance:

- AI can inspect and propose actions.
- Dangerous actions require confirmation.
- Audit logs record tool calls.

## Milestone 10: Production Hardening

Implement:

- Backup/restore.
- Secret rotation.
- Agent auto-update policy.
- HA gateway mode.
- Relay mode.
- Monitoring and alerting.
- Documentation.

Acceptance:

- Failure drills pass.
- Security checklist passes.
- Install guide works on fresh machines.

