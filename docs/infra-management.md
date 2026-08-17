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
    build: . # Dockerfile or Nixpacks auto-detect
    port: 3000
    route: true # → https://<app>.<your-domain>
    needs: [db] # injects DB_HOST / DB_PORT
  db:
    image: 127.0.0.1:61050/postgres:16 # from YOUR registry
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
PORTLESS_ZONE=example.com sh deploy/infra/hub.sh
```

That brings up the hub + dashboard (`https://portless.<zone>`), an OCI registry, a dedicated named
tunnel with a first-level wildcard (`*.<zone>` — Cloudflare's free Universal SSL covers exactly one
level), systemd units, and prints the enroll command.

**Nodes** (any Linux box; installs docker if missing, systemd-persisted):

```sh
curl -fsSL https://<hub>/agent.sh | sudo sh -s -- --token <plt_...> --name <name>   # token: dashboard Settings → API tokens (role: operator)
```

Windows: `deploy/infra/agent.ps1` (see `deploy/infra/WINDOWS.md`).

Both hand the install to the control plane's verified installer, which checks the agent binary
against a SHA-256 the control plane pins and refuses on a mismatch
([ADR 0006](adr/0006-one-onboarding-path-with-a-pinned-trust-root.md)). The bytes still come off the
hub — `ERAINFRA_INSTALL_URL` in the hub's env names the control plane the checksum comes from — so
self-hosted and air-gapped installs are unaffected. Enrolment without that setting refuses; it does
not fall back to the unchecked download these scripts used to do. The same command works from the
platform dashboard's **Machines → Add machine → Node**, which is now the one flow for both machine
kinds.

### Filling the hub's `/agent-bin` mirror

`deploy/infra/build-agents.sh` fills the directory the hub serves those bytes from. Two ways, and the
difference decides what happens on a box that is offline:

```sh
sh deploy/infra/build-agents.sh --from-release   # download the attested release assets, verified
sh deploy/infra/build-agents.sh                  # compile them here, on the pinned toolchain
```

`--from-release` is the one that cannot drift: it copies the exact bytes the control plane pins, and
refuses anything else. Compiling is the offline path, and it is byte-reproducible **only on the Go
toolchain the release used** — a patch release is enough to change the output. Both build paths
therefore set `GOTOOLCHAIN` explicitly from the `go` directive in the repository's `go.mod`, which is
also the version `setup-go` installs in CI; `packages/release/tests/go-toolchain.test.ts` fails if
those declarations ever disagree.

**On an air-gapped hub whose Go is not the pinned version, the compile deliberately fails.**
`GOTOOLCHAIN=go<pinned>` cannot download the toolchain with no network, so `build-agents.sh` stops
before it builds anything and names the toolchain in the error. That is the intended behaviour: the
alternative is silently producing bytes every Node then refuses at install time, which reads as
tampering and sends the operator to rebuild the mirror they just built correctly. Either install the
pinned Go on the hub, or fill the mirror with `--from-release` from a box that has the release.

### Node privilege boundary

Treat every Portless node as a privileged service boundary, not as an unprivileged sandbox. On
Linux, the `sudo` installer currently creates `portless-agent.service` without a `User=` directive,
so the agent runs as root. A foreground/non-root agent that can access the Docker socket (including
through membership in the `docker` group) is also effectively root-capable on that node; Docker-group
execution is **not** unprivileged isolation.

The control protocol reduces the exposed authority: `operator` credentials may deploy containers,
host operations require `agent.run`, host operations are resolved from a node-side allowlist, and
Docker flags that request host namespaces, bind mounts/sockets, devices, capabilities, or security
profile changes are rejected at both hub and node. Those checks limit remote requests; they do not
make a compromised hub, agent binary, Docker daemon, or privileged node account harmless. Use
dedicated nodes with a blast radius appropriate for the workloads and keep the hub/admin credentials
inside the same trust domain.

**Push-to-deploy**: create a GitHub App (webhook → `https://<hub>/webhook/github`), set
`PORTLESS_GH_*` on the hub, bind a repo (`portless bind owner/repo`). Public repos also work without
an App via `portless redeploy`.

## Develop

Run from the repository root — this is one workspace with the rest of EraInfra, so scope the
commands to the two packages rather than starting the whole platform.

```sh
pnpm install
pnpm --filter @erainfra/hub dev       # hub :8787
pnpm --filter @erainfra/hub-web dev   # dashboard (vite)
pnpm test                             # hermetic — no docker, no network, no infra
```

- `apps/hub` — hub: Fastify + tRPC control plane, data plane (wildcard ingress over agent WS),
  deploy pipeline (`runtime/appdeploy.ts`), failover, secrets, backups.
- `apps/infra-agent` — Go agent: outbound WS, docker deploys, builds, mesh links (dumbpipe/iroh).
- `packages/cli` — the `portless` CLI + MCP server. Zero dependencies.
- `apps/hub-web` — dashboard (React + shadcn).
- `deploy/infra/` — `hub.sh`, `agent.sh`, `image.sh` (build), `registry.sh`, `cli.sh`.
- `apps/hub/scripts/verify/` — the end-to-end harnesses (fresh box, multi-node, WSL, Windows,
  failover). Not run by `pnpm test`: they need docker and real machines.
