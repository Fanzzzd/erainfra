# Retire the Hub

After this runbook the infrastructure-management surface runs on Convex and the Nodes alone
([ADR 0016](../adr/0016-nodes-meet-over-iroh-and-keep-state-in-convex.md)): Node state, deploys,
failover, links, env and logs in Convex, public traffic at gateway Nodes, and operators on the
`erainfra` CLI and the EraInfra dashboard. The Hub container is stopped. Its data volume,
`portless-data`, is kept as the rollback source and is never deleted here.

Each step is reversible until the last one, and the Hub keeps working throughout: a Node in Hub
mode is untouched until you switch it, and the Hub serves ingress until DNS moves.

## What retiring the Hub loses

Read this before you start. Each item is something the Hub did that Convex does not, and what to do
instead.

| Lost                                                                                                      | Instead                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The AI chat transcript archive (`chat_*` tables, `portless chats`). The importer does not copy it (#180). | Export the database before stopping the Hub (step 5). Transcripts are not control state and nothing in Convex reads them. To search them later, open the copy with `sqlite3`, or start the Hub again read-only from the kept volume. |
| `portless mcp`, the MCP server for AI agents.                                                             | No Convex equivalent ships yet. Agents run `erainfra … --format json`, which is a stable shape.                                                                                                                                      |
| Hub API tokens (`plt_…`) and Hub sessions. Not imported.                                                  | Mint dashboard API tokens (Settings, API tokens): `read` for scripts that only look, `admin` for deploys. People sign in to the dashboard with their imported Hub password.                                                          |
| Hub S3 backups (`portless backup`).                                                                       | Convex holds the state; use Convex's snapshot export for backups. Keep `ERAINFRA_SECRETS_MASTER_KEY` in a safe place: without it the stored secrets cannot be decrypted.                                                             |
| The Hub dashboard (`portless.<zone>`).                                                                    | The EraInfra dashboard: Nodes, Apps, Deployments and Links pages.                                                                                                                                                                    |
| `portless bind`, `portless repos`, `portless redeploy`.                                                   | The importer copies the Hub's bindings. `erainfra git bind owner/name <branch> --app <app>` binds another (admin token); step 4 moves the webhook. `erainfra deploy --repo owner/name --branch <b>` replaces `redeploy`.             |
| Legacy dumbpipe links, and links to a Node still in Hub mode.                                             | Every Node runs `connect-convex` with a sidecar before step 5; `erainfra links list` must show `transport mesh` for every link.                                                                                                      |
| `/agent.sh`, `/cli.sh` and `/agent-bin` on the Hub host.                                                  | `/install --role node` on the Convex site and the GitHub Release (ADR 0006).                                                                                                                                                         |

## 1. Copy the Hub into Convex

On the Hub's host, set the secrets master key once and run the importer
([State in Convex](../infra-management.md#state-in-convex)). Start with `--dry-run`; it writes
nothing and lists every row the import would create, update, skip or refuse:

```sh
pnpm convex env set ERAINFRA_SECRETS_MASTER_KEY "$(openssl rand -hex 32)"   # first time only

DB=$(docker run --rm -v portless-data:/data:ro alpine sh -c \
  'ls /data/erainfra-runtime/erainfra.db /data/portless-runtime/portless.db 2>/dev/null | head -1')
docker run --rm -v portless-data:/data:ro -v "$PWD":/out alpine \
  cp "$DB" "$(dirname "$DB")/secret.key" /out/
CONVEX_URL=https://<deployment>.convex.cloud CONVEX_DEPLOY_KEY=<deploy key> \
  pnpm --filter @erainfra/backend import-hub-state \
    --db "$PWD/$(basename "$DB")" --secret-key "$PWD/secret.key" --dry-run
```

Drop `--dry-run` when it reports nothing refused. A run that refuses a row still applies every other
row, prints the refused ones and exits non-zero; fix them and run it again.

The import is safe to repeat, and you re-run it before each later step that moves a reader to
Convex. It copies only what the Hub still owns. Once Convex writes or deletes a row, that row is
Convex's and every later import skips it, printing `skipped … owned by Convex`:

- An App, with its routes and ports, becomes Convex's at its first deploy, failover or removal
  through Convex.
- An env variable, a link or a git binding becomes Convex's the first time Convex sets, adds,
  binds, removes or unbinds it, or a Convex run records its result on the binding.
- An account is copied once; Convex owns it from then on.

So a change made on the Hub to something Convex already owns is never imported. The
[ownership table](../infra-management.md#state-in-convex) lists every table. Delete the two copied
files afterwards; they hold every secret.

Check what arrived:

```sh
erainfra nodes list    # every Hub Node, transport hub
erainfra apps list     # every App, status hub
erainfra links list    # every link, transport legacy for now
erainfra git bindings  # every branch the Hub deployed on push
```

## 2. Enroll each Node and switch it to connect-convex

Do this one Node at a time, starting with one that runs nothing important. A Node stays in Hub mode
until you switch it, so the Hub keeps driving the rest.

1. Enroll it and store its credential on the Node:

   ```sh
   erainfra nodes enroll edge-1 > edge-1.credential
   scp edge-1.credential edge-1:/etc/erainfra-node.credential   # then chmod 0600 there
   ```

2. Give it the `erainfra-mesh` sidecar and start `connect-convex`, as
   [Set up a Node](../infra-management.md#set-up-a-node) describes. With the systemd sidecar from
   `/install --role node --mesh`, stop and disable `portless-agent.service` first: the two modes
   never drive one sidecar at once.
3. Within a minute `erainfra nodes list` shows the Node with transport `convex`, `online`, and
   `MESH proven`. Its Apps show status `running` in `erainfra apps list`.
4. Re-run the importer (step 1) after each switch, so Convex holds what the Hub last deployed.
   Nothing Convex has written is overwritten.

Once both ends of a link run `connect-convex`, `erainfra links list` shows that link with
transport `mesh`. When every Node is switched, every link must show `mesh` and state `active`.

Rolling one Node back is [Roll back to Hub mode](../infra-management.md#roll-back-to-hub-mode).

## 3. Move ingress to gateway Nodes

Follow [move-ingress-to-gateways.md](move-ingress-to-gateways.md): mark two or more Nodes
`erainfra nodes set-roles <name> gateway`, run `deploy/infra/gateway.sh` on each, canary one App,
then move `*.<zone>` to the `erainfra-gateway` tunnel. Its rollback is one DNS command while the Hub
runs.

## 4. Verify everything through Convex

From this step on, Convex is the authority. Before the first check:

1. Stop changing anything through the Hub: no `portless deploy`, `env`, `link`, `bind` or account
   changes. Make every change with `erainfra` or the dashboard.
2. Re-run the importer (step 1), so Convex holds the Hub's last state.

Run each check with the `erainfra` CLI logged in to the Convex site, never `portless`. Each check
writes through Convex, and what it writes is Convex's from then on: deploying an App makes the App
Convex's, and later imports skip it.

- **Deploy.** Deploy a small App and follow it to `done`, then open its URL through the gateways:

  ```sh
  erainfra deploy ./hello --app hello-retire --port 8080
  curl -fsS https://hello-retire.<zone>/
  ```

- **Deploy every real App once through Convex.** Apps copied from the Hub have no stored spec, so
  Convex cannot fail them over until they are deployed through it once. `erainfra apps view <app>`
  says so until then. Each deploy is the moment that App becomes Convex's. A single-container App the Hub deployed with `-v` volumes needs a spec that
  mounts them, and a Convex service can only mount `<app>-<volume>`. Its first Convex deploy starts
  new containers beside the Hub's container `<app>`, which keeps running. Move its data to a volume
  of that form and remove the Hub's container first, as
  [Names and ownership](../infra-management.md#names-and-ownership) describes. The Infra Agent
  refuses to start the services on a volume the Hub's container still mounts.
- **Failover.** On a test App spread over two Nodes, stop the Infra Agent on one Node. After about
  two and a half minutes `erainfra deployments list --app <app>` shows a `failover` run ending
  `done`, and the App answers from the other Node. Start the agent again.
- **Logs.** `erainfra logs hello-retire` prints the container's last lines, and a second read of the
  same request gets 404.
- **Links.** `erainfra links list` shows every link `mesh` and `active`, and each consumer reaches
  its provider on the surfaced port.
- **Env.** `erainfra env list <app>` shows the names the Hub had.
- **Push-to-deploy.** Set the deploy GitHub App's credentials in the Convex environment,
  `ERAINFRA_GH_WEBHOOK_SECRET` among them
  ([Push-to-deploy](../infra-management.md#push-to-deploy)), then change the App's webhook URL from
  `https://<hub>/webhook/github` to `https://<deployment>.convex.site/github/webhook`. From then on
  pushes deploy from Convex, not the Hub. Push a commit to a bound branch;
  `erainfra deployments list --app <app>` shows a `git` run ending `done`. Bind any further branch
  with an admin token, or `POST /api/v1/git/bindings`:

  ```sh
  erainfra git bind acme/web main --app web --build-node edge-1 --deploy-node edge-2
  erainfra git bindings
  ```

- **Dashboard.** The Nodes, Apps, Deployments and Links pages show the same.

Then remove the test App: `erainfra apps remove hello-retire --yes`.

## 5. Stop the Hub, keep its data

Run the importer with `--dry-run` once more. It should report nothing refused and nothing to create
or update; every App deployed in step 4 shows as `skipped … owned by Convex`. A row it would create
or update is a change someone made on the Hub after step 4 began. Drop `--dry-run` to copy it; the
import cannot overwrite anything Convex owns.

Then export the chat transcripts if anyone wants them, and stop the Hub container and its tunnel
connector. Do not delete `portless-data`, `portless-registry` or the Hub's tunnel: they are the
rollback source.

```sh
# The transcripts and everything else the Hub held, as one file you keep elsewhere.
docker run --rm -v portless-data:/data:ro -v "$PWD":/out alpine \
  sh -c 'cp /data/*-runtime/*.db /out/hub-final.db'

docker stop portless-hub
docker update --restart=no portless-hub
sudo systemctl disable --now portless-tunnel
```

Leave the `portless-registry` container running if `ERAINFRA_REGISTRY_NODE` names this box: it is
the image registry every Node pulls from. Leave `portless.<zone>` in DNS; it answers 502 while the
Hub is stopped and costs nothing.

From now on:

- `portless` commands fail to reach the Hub. Use `erainfra` (`portless help` says so).
- Never run `deploy/infra/hub.sh` on this box again unless you are rolling back: it restarts the
  Hub with the old state.
- Never `docker volume rm portless-data`. If disk space matters, archive the volume first and keep
  the archive with the Convex master key.

## Roll back

Until you delete `portless-data`, the Hub comes back with the state it had when it stopped. Work
done in Convex since then (deploys, env changes, links, removed Apps) is not in it.

1. Start the Hub: `docker start portless-hub && sudo systemctl enable --now portless-tunnel`, or
   re-run `deploy/infra/hub.sh`, which reuses the volume, the env file and the tunnel.
2. Point ingress back at the Hub's tunnel:
   `cloudflared tunnel route dns --overwrite-dns portless '*.<zone>'`
   ([move-ingress-to-gateways.md](move-ingress-to-gateways.md#roll-back)).
3. Switch Nodes back to Hub mode one at a time
   ([Roll back to Hub mode](../infra-management.md#roll-back-to-hub-mode)). Revoke a Node's Convex
   credential (`erainfra nodes revoke <name>`) if it should leave the Convex mesh.
4. Redeploy through the Hub (`portless deploy` or `portless redeploy`) any App that changed in
   Convex after the Hub stopped, and set again any env changed in Convex.
5. Point the deploy GitHub App's webhook back at `https://<hub>/webhook/github`, and bind on the Hub
   (`portless bind`) any branch bound in Convex after the Hub stopped.
