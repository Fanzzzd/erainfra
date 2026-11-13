# ADR 0020: The Hub leaves main; rollback uses the last tag that carries it

- Status: Accepted; implemented 2026-11-12
- Date: 2026-11-12
- Owners: EraInfra
- Related: [ADR 0004](0004-portless-is-a-feature-not-a-second-product.md),
  [ADR 0006](0006-one-onboarding-path-with-a-pinned-trust-root.md),
  [ADR 0016](0016-nodes-meet-over-iroh-and-keep-state-in-convex.md)

## Context

ADR 0016 moved Node state, deploys, failover, links, ingress and the operator surface from the Hub
into Convex. The owner's fleet retired its Hub on 2026-11-08
([retire-the-hub.md](../runbooks/retire-the-hub.md)). Read on 2026-11-12:

- `npx convex data nodes --prod` lists 3 Nodes. All run Infra Agent 0.2.0-rc.15 and heartbeat to
  Convex (`lastSeenAt` within the last minute). No Node is driven by a Hub.
- The Hub's public host answers HTTP 530. Its container is stopped.

Main still carried the Hub and everything only it used: `apps/hub`, `apps/hub-web`, `apps/docs`
(the Portless documentation site, which describes only the Hub), `packages/cli` (the `portless`
CLI, which talks only to a Hub), the Infra Agent's Hub mode (`connect`, its data-plane socket and
the dumbpipe links), the Hub-era installers in `deploy/infra`, the `/install` and `/install.ps1`
Hub-mode Node paths, and the Convex importer that copied Hub state into Convex. That is about
21,000 lines. It cost a TypeScript 5 pin for `apps/docs`, a CI job that assembled and served the
Hub bundle on every pull request, and a frozen-identifier gate that kept guarding names nothing on
main reads.

## Decision

1. **Main stops carrying the Hub.** This change deletes the code above. The Infra Agent keeps one
   mode, `connect-convex`. `/install --role node` installs only that mode. `/install.ps1` has no
   Node role any more: on Windows it ran only Hub mode, and `connect-convex` needs Linux with
   systemd.
2. **Rollback uses a release tag, never main.** `v0.2.0-rc.19` is the last tag that carries the Hub.
   A rollback checks out that tag and follows its own `docs/runbooks/retire-the-hub.md`, "Roll
   back". Every piece that procedure needs is still on the hosts: the Hub's stopped container and
   its `portless-data` volume, and on each Node migrated from Hub mode the disabled
   `portless-agent.service`, `/etc/portless/agent.env` and the Hub-mode binary under
   `~/.portless/bin`. The control plane rolls back with the tag's
   `docs/runbooks/deploy-control-plane.md`.
3. **What a running system holds stays frozen** (CONTEXT.md rule 4). Main keeps reading or naming:
   - `portless-agent.service` and `erainfra-agent.service`: a rollback from the tag starts them
     again. `/install --role node` refused a Node where either was live, unless
     `--replace-hub-agent` stopped it. That migration left the installer on 2026-11-13, after every
     Node had moved to `connect-convex`. The installer now refuses the flag and never touches
     either unit.
   - `~/.portless` and `PORTLESS_PREFIX`: the Infra Agent's default prefix for the mesh control
     directory.
   - The `portless-registry` container and volume: the fleet's image registry
     (`ERAINFRA_REGISTRY=127.0.0.1:61050`). The Hub's installer started it; nothing else did.
     [infra-management.md](../infra-management.md#image-registry-and-cross-node-links) now
     carries the command that recreates it under the same names.
   - `portless-data`, `portless.db`, `/etc/portless/agent.env`: main no longer touches them, and a
     rollback needs them exactly as they are. Never rename or delete them.
   - `infra/hubPassword.ts`, every `legacyHubId` field and the `"hub-import"` Node source: imported
     accounts and Nodes hold them.
   - The `provenance` fields stay in the Convex schema, written by nothing, so a deploy cannot fail
     on the rows that carry them. The `hubImportTombstones` table left the schema on 2026-11-13,
     after its two rows were deleted in production.
4. **These frozen identifiers leave the tree.** Only the Hub, its installers, its CLI or its
   importer used them. The frozen-identifier gate in `.github/workflows/ci.yml` reads the block
   below and lets exactly these names leave; every other frozen name still fails it. The gate
   extracts names from text, so the list also holds the fragments it found in the Hub's prose and
   tests (`PORTLESS_GH_`, `PORTLESS_BACKUP_S3_`, `PORTLESS_REGISTRY_S3_`, `PORTLESS_X`).

   ```retired-identifiers
   PORTLESS_AGENT_BIN_DIR
   PORTLESS_AGENT_VERSION
   PORTLESS_APP_DOMAIN
   PORTLESS_APPS_FILE
   PORTLESS_AUDIT_FILE
   PORTLESS_BACKUP_INTERVAL_MIN
   PORTLESS_BACKUP_S3_
   PORTLESS_BACKUP_S3_ACCESS_KEY
   PORTLESS_BACKUP_S3_BUCKET
   PORTLESS_BACKUP_S3_ENDPOINT
   PORTLESS_BACKUP_S3_PREFIX
   PORTLESS_BACKUP_S3_REGION
   PORTLESS_BACKUP_S3_SECRET_KEY
   PORTLESS_BIND
   PORTLESS_BUILDS_DIR
   PORTLESS_CLI_FILE
   PORTLESS_DB_FILE
   PORTLESS_DEPLOY_DIR
   PORTLESS_DEV_AUTH
   PORTLESS_DEV_TOKENS
   PORTLESS_FAILOVER
   PORTLESS_FAILOVER_GRACE_MS
   PORTLESS_GH_
   PORTLESS_GH_APP_ID
   PORTLESS_GH_APP_KEY
   PORTLESS_GH_APP_KEY_FILE
   PORTLESS_GH_WEBHOOK_SECRET
   PORTLESS_HOSTNAME
   PORTLESS_HUB
   PORTLESS_HUB_BASE
   PORTLESS_HUB_HOST
   PORTLESS_HUB_PORT
   PORTLESS_HUB_URL
   PORTLESS_NODE_IMAGE
   PORTLESS_PORT
   PORTLESS_REG_PORT
   PORTLESS_REGISTRY
   PORTLESS_REGISTRY_BIND
   PORTLESS_REGISTRY_DATA
   PORTLESS_REGISTRY_NODE
   PORTLESS_REGISTRY_S3_
   PORTLESS_REGISTRY_S3_BUCKET
   PORTLESS_REGISTRY_S3_ENDPOINT
   PORTLESS_REGISTRY_S3_PREFIX
   PORTLESS_REGISTRY_S3_REGION
   PORTLESS_ROUTES_FILE
   PORTLESS_SECRET_KEY
   PORTLESS_SECRET_KEY_FILE
   PORTLESS_SECRETS_FILE
   PORTLESS_STATE_DIR
   PORTLESS_TOKEN
   PORTLESS_TUNNEL
   PORTLESS_TUNNEL_NAME
   PORTLESS_WEB_DIR
   PORTLESS_X
   PORTLESS_ZONE
   ```

5. **dumbpipe is gone.** ADR 0016's phase 1 kept dumbpipe for links whose other end had no sidecar,
   until a "contract" release. With the Hub gone no such link remains, and this change is that
   release: the Infra Agent's `mesh_legacy.go`, the Hub's link driver and the installers that
   fetched dumbpipe are deleted.

## Consequences

- A Hub-mode Node or Hub outside the owner's fleet stays on `v0.2.0-rc.19` or moves to Convex
  mode. Main has no upgrade path for it.
- The `portless` npm package and the `portless` CLI are no longer built from main.
- `erainfra nodes list` and the dashboard lose the `hub` transport and App status, and a link no
  longer reports a `legacy` transport. A Node that never heartbeated is offline; a link whose ends
  lack a proven mesh endpoint is pending.
- A rollback after this change loses the Convex-side work since the cutover, as the tag's runbook
  already says. Main cannot help with it, so the rollback window ends when the hosts no longer hold
  the pieces listed in decision 2.
