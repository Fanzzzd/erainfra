# Deploy and configure the control plane

The control plane is a Convex deployment: the backend functions plus the dashboard, which Convex
serves as static files from the same deployment. The README's [Quick start](../README.md#quick-start)
covers the first deploy. This page lists the deployment variables. Upgrading a deployment that
already runs a fleet is a cutover; follow
[Runbook: deploy the control plane](runbooks/deploy-control-plane.md).

Deploy the Convex backend and static dashboard:

```bash
cd packages/backend
npx convex deploy -y
pnpm run deploy --skip-convex
```

`pnpm run deploy:control-plane` at the root runs both halves, but `convex deploy` inside it asks
for confirmation on a dev deployment and fails in a shell that cannot prompt. For production, follow
[Runbook: deploy the control plane](runbooks/deploy-control-plane.md).

Set these deployment variables before production use, from `packages/backend` with
`npx convex env set --prod NAME value`. Without `--prod` the command sets them on the deployment
`.env.local` names, which is a dev deployment on a developer's checkout:

| Variable                  | Purpose                                                                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `SITE_URL`                | Canonical HTTPS dashboard origin.                                                                                                            |
| `BOOTSTRAP_SECRET`        | One-time first-admin bootstrap.                                                                                                              |
| `CONTROLLER_TOKEN`        | Long random bearer token shared only with scale-set controllers.                                                                             |
| `CONTROLLER_TOKEN_NEXT`   | Optional second controller token, accepted beside `CONTROLLER_TOKEN` during a rotation ([runbook](runbooks/operate-the-controller-host.md)). |
| `ALLOWED_REPOS`           | Legacy webhook allowlist; omit when that path is unused.                                                                                     |
| `RELAY_ACCESS_TOKEN`      | Secret a fleet relay sends to `/api/v1/relay/access`; omit without a fleet relay ([runbook](runbooks/run-a-fleet-relay.md)).                 |
| `RELAY_ACCESS_TOKEN_NEXT` | Optional second relay secret, accepted beside `RELAY_ACCESS_TOKEN` during a rotation.                                                        |

The dashboard creates short-lived, single-use Worker enrollment commands. Machine credentials are
stored in `~/.runner-center/agent/.env` with mode `600`; JIT configurations travel from Convex to the
Worker once and enter its runtime client through stdin, then cross a mode-`0660` Unix socket in an
HTTP request body. They never appear in argv or a host environment variable.
