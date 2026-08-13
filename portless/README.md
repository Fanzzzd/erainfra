# portless

Deploy to **your own machines** — no public IP, no open ports, no third-party PaaS.

A hub (control plane + dashboard) runs on one box behind a Cloudflare tunnel. Agents on your other
machines dial **out** to it over WSS, so everything works behind NAT/firewalls. Apps get automatic
`https://<app>.<your-domain>` URLs, served through the hub's single tunnel and reverse-proxied to
whichever node runs them.

```
   browser ──https──▶ Cloudflare ──tunnel──▶ hub ──ws──▶ agent(node A) ──▶ containers
   git push ─webhook─▶  hub: build → registry → deploy → route            │
   portless deploy ──▶                                        mesh (iroh) ┴── agent(node B)
```

Everything is self-hosted: your registry (`registry:2`), your S3 for backups, your GitHub App for
push-to-deploy. Builds use your Dockerfile, or [Nixpacks](https://nixpacks.com) when there isn't one.

## Use it

```sh
curl -fsSL https://<hub>/cli.sh | sh          # install the CLI (needs node >= 20)
portless login https://<hub>                  # sign in with your hub account (email+password)

portless deploy                               # deploy the current directory → live URL
portless apps                                 # what's running, where, with URLs
portless logs my-app                          # container logs
portless env my-app set DATABASE_URL=...      # encrypted secrets
portless link gpu-box:8080 web-box            # reach gpu-box:8080 from web-box at 127.0.0.1:8080
                                              #   (P2P mesh, no tunnel; persisted + self-healing)
```

AI agents get the same capabilities, typed, over MCP: `claude mcp add portless -- portless mcp`.

## portless.yaml

How a project deploys is written in the project — the platform executes it deterministically:

```yaml
services:
  web:
    build: .            # Dockerfile or Nixpacks auto-detect
    port: 3000
    route: true         # → https://<app>.<your-domain>
    needs: [db]         # injects DB_HOST / DB_PORT
  db:
    image: 127.0.0.1:61050/postgres:16   # from YOUR registry
    port: 5432
    volumes: [pgdata:/var/lib/postgresql/data]
    # node: other-box   # optional placement; needs: wires cross-node over the mesh (iroh)
```

No `portless.yaml` → single service, built from the repo root, routed at the app name.

Same-node services reach each other by name (per-app docker network). Cross-node `needs:` are wired
over an encrypted P2P mesh link (hole-punched when possible) — the database never touches a public
domain. If a node dies, its apps auto-redeploy onto a survivor and the routes flip (stateless only).

## Stand up the infrastructure

**Hub** (a Linux box with docker + cloudflared + a CF origin cert):

```sh
PORTLESS_ZONE=example.com sh deploy/hub.sh
```

That brings up the hub + dashboard (`https://portless.<zone>`), an OCI registry, a dedicated named
tunnel with a first-level wildcard (`*.<zone>` — Cloudflare's free Universal SSL covers exactly one
level), systemd units, and prints the enroll command.

**Nodes** (any Linux box; installs docker if missing, systemd-persisted):

```sh
curl -fsSL https://<hub>/agent.sh | sudo sh -s -- --token <plt_...> --name <name>   # token: dashboard Settings → API tokens (role: operator)
```

Windows: `deploy/agent.ps1` (see `deploy/WINDOWS.md`).

**Push-to-deploy**: create a GitHub App (webhook → `https://<hub>/webhook/github`), set
`PORTLESS_GH_*` on the hub, bind a repo (`portless bind owner/repo`). Public repos also work without
an App via `portless redeploy`.

## Develop

```sh
pnpm install
pnpm dev        # api :8787 + dashboard (vite)
pnpm test       # hermetic — no docker, no network, no infra
```

- `apps/api` — hub: Fastify + tRPC control plane, data plane (wildcard ingress over agent WS),
  deploy pipeline (`runtime/appdeploy.ts`), failover, secrets, backups.
- `agents/node-agent` — Go agent: outbound WS, docker deploys, builds, mesh links (dumbpipe/iroh).
- `packages/cli` — the `portless` CLI + MCP server. Zero dependencies.
- `apps/web` — dashboard (React + shadcn).
- `deploy/` — `hub.sh`, `agent.sh`, `image.sh` (build), `registry.sh`, `cli.sh`.
