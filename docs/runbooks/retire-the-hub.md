# Retire the Hub

After this runbook the infrastructure-management surface runs on Convex and the Nodes alone
([ADR 0016](../adr/0016-nodes-meet-over-iroh-and-keep-state-in-convex.md)): Node state, deploys,
failover, links, env and logs in Convex, public traffic at gateway Nodes, and operators on the
`erainfra` CLI and the EraInfra dashboard. The Hub container is stopped. Its data volume,
`portless-data`, is kept as the rollback source and is never deleted here.

## Check which deployment the CLI reaches

Run every `npx convex` command in this runbook from `packages/backend` of the release checkout.
The CLI finds the Convex project through `packages/backend/.env.local`, and on the owner's machine
that file names a dev deployment (`CONVEX_DEPLOYMENT=dev:…`). Without `--prod`, `npx convex env`
and `npx convex run` change that dev deployment and the live fleet never sees it. Every such
command below passes `--prod`. Add it to any you type yourself.

Before step 1, confirm what `--prod` reaches:

```sh
grep '^CONVEX_DEPLOYMENT=' .env.local      # dev:<name> is expected; --prod picks the same project's production
npx convex dashboard --prod --no-open      # https://dashboard.convex.dev/d/<production name>
npx convex env list --prod --names-only    # production's variables: CONTROLLER_TOKEN, SITE_URL, …
```

The name after `/d/` is the production deployment. Its URLs are `https://<name>.convex.cloud` and
`https://<name>.convex.site`, and `<deployment>` in every URL below is that name. It must be the
deployment the fleet talks to: on `oracle-singapore-1`,
`sudo grep -h CONVEX /etc/runner-center/profiles/*.env` shows `https://<name>.convex.site`
for every Profile. If the name differs, or `env list --prod` shows no `CONTROLLER_TOKEN`, stop:
`.env.local` belongs to another project. Each `env set --prod` ends its output with
`(on prod deployment <name>)`; check that it names the same deployment.

## Where traffic breaks, and for how long

The Hub serves `<app>.<zone>` only for Apps on a Node in Hub mode: it proxies each request over
that Node's `/data` socket (`apps/hub/src/server.ts`), which only the Hub-mode agent opens. A
gateway serves an App only when the App's Node runs `connect-convex` with a proven mesh endpoint.
No Node is reachable both ways at once.

So the moment an App Node leaves Hub mode, the Hub can no longer serve its Apps, and until
`*.<zone>` points at the gateways, nothing serves them. This runbook keeps that gap to one short,
planned window:

1. Nodes that run no Apps switch first and become the gateways. The Hub keeps serving everything.
2. A test App proves the gateway path end to end, through its own DNS record.
3. In one window, the App Node switches and `*.<zone>` moves to the gateways.

During step 3 every App on that Node answers errors from the Hub's tunnel. The window runs from
the moment the installer stops the Hub-mode agent until the DNS command returns: about a minute if
you run the commands back to back, and as long as you take if you stop to investigate. Requests and
WebSockets in flight through the Hub are cut. Pick a quiet time and tell the App owners.

On the current fleet: `work-remote` (ubuntu0) runs the Hub, every App, the registry, the job cache
and the Firecracker CI Worker; `oracle-singapore-1` runs the CI controllers; `bielcrystal-aliyun-1`
runs company services but no Apps. The two that run no Apps become the gateways. `work-remote` is
the App Node.

## What retiring the Hub loses

Read this before you start. Each item is something the Hub did that Convex does not, and what to do
instead.

| Lost                                                                                                      | Instead                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The AI chat transcript archive (`chat_*` tables, `portless chats`). The importer does not copy it (#180). | Copy the database when you stop the Hub (step 7). Transcripts are not control state and nothing in Convex reads them. To search them later, open the copy with `sqlite3`, or start the Hub again read-only from the kept volume. |
| `portless mcp`, the MCP server for AI agents.                                                             | No Convex equivalent ships yet. Agents run `erainfra … --format json`, which is a stable shape.                                                                                                                                  |
| Hub API tokens (`plt_…`) and Hub sessions. Not imported.                                                  | Mint dashboard API tokens (Settings, API tokens): `read` for scripts that only look, `admin` for deploys. People sign in to the dashboard with their imported Hub password.                                                      |
| Hub S3 backups (`portless backup`).                                                                       | Convex holds the state; use Convex's snapshot export for backups. Keep `ERAINFRA_SECRETS_MASTER_KEY` in a safe place: without it the stored secrets cannot be decrypted.                                                         |
| The Hub dashboard (`portless.<zone>`).                                                                    | The EraInfra dashboard: Nodes, Apps, Deployments and Links pages.                                                                                                                                                                |
| `portless bind`, `portless repos`, `portless redeploy`.                                                   | The importer copies the Hub's bindings. `erainfra git bind owner/name <branch> --app <app>` binds another (admin token); step 6 moves the webhook. `erainfra deploy --repo owner/name --branch <b>` replaces `redeploy`.         |
| Legacy dumbpipe links, and links to a Node still in Hub mode.                                             | Every Node runs `connect-convex` with a sidecar before step 7; `erainfra links list` must show `transport mesh` for every link.                                                                                                  |
| `/agent.sh`, `/cli.sh` and `/agent-bin` on the Hub host.                                                  | `/install --role node --convex` on the Convex site, and the GitHub Release (ADR 0006).                                                                                                                                           |

## Before you start

1. **The control plane runs a release that has this runbook's tools.** Deploy it from the release
   commit as [deploy-control-plane.md](deploy-control-plane.md) says. That release must pin the
   Infra Agent and `erainfra-mesh` (`AGENT_RELEASE.mesh` in `agentRelease.ts` is not empty), or
   `/install --role node --convex` refuses. Check with:

   ```sh
   curl -fsSL https://<deployment>.convex.site/install | bash -s -- --role node --help
   ```

   The usage must list `--convex`.

2. **Point Convex at the registry the Hub runs.** Builds push to `ERAINFRA_REGISTRY`, which has no
   default. On the Hub host, read the address the Hub uses:

   ```sh
   grep -h REGISTRY ~/portless-env/hub.env ~/erainfra-env/hub.env 2>/dev/null
   docker port portless-registry   # 5000/tcp -> 127.0.0.1:61050 by default
   ```

   Then, from `packages/backend`, set the same address:

   ```sh
   npx convex env set --prod ERAINFRA_REGISTRY 127.0.0.1:61050
   ```

   Do not set `ERAINFRA_REGISTRY_NODE` yet. It names the Node whose registry every other Node
   reaches over the mesh, and `work-remote` joins the mesh only in step 5, which sets it then.
   Until then nothing is built through Convex: the canary in step 4 is image-only. A deploy that
   builds, or pulls an image from `127.0.0.1:61050`, fails at planning, before anything is built,
   with a message naming `ERAINFRA_REGISTRY_NODE`: the address is loopback, so each Node would
   reach its own loopback, where no registry runs
   ([Image registry](../infra-management.md#image-registry-and-cross-node-links)).

3. **Set the App domain** so deploys report the URLs the gateways serve:
   `npx convex env set --prod ERAINFRA_APP_DOMAIN <zone>`.

4. **Have a Cloudflare origin cert for the zone** (`cloudflared login`, which writes
   `~/.cloudflared/cert.pem`) and `cloudflared` on each future gateway Node. Run the gateway DNS
   commands below on a gateway Node, as the user that ran `gateway.sh`: they pass the config it
   writes, `~/.cloudflared/config-erainfra-gateway.yml`. Without `--config`, `route dns` reads a
   default config (`~/.cloudflared/config.yml`, `/etc/cloudflared/config.yml`) and routes to the
   tunnel that file names, whatever tunnel the command names (`hub.sh` pins its own routes the
   same way). The rollback's command runs on `work-remote` with the config `hub.sh` wrote there.

5. **Leave Worker updates for another window.** `work-remote` is also the CI Worker. Re-running
   `/install --role worker-host` there refuses while any Firecracker VM runs, including the idle
   warm VMs the runtime keeps parked; drain it first as the refusal says
   ([firecracker-cutover.md](firecracker-cutover.md#2-provision-the-worker-host)). Nothing in this
   runbook touches the Worker, the controllers, the job cache or the registry container.

6. **Know when the control plane can be rolled back.** From step 2 on, Nodes run
   `connect-convex`, which needs the Node API that v0.2.0-rc.11 added. A control-plane rollback to
   v0.2.0-rc.10 leaves them without a control plane, so it waits until those Nodes are back in Hub
   mode ([deploy-control-plane.md, When a rollback is safe](deploy-control-plane.md#when-a-rollback-to-v020-rc10-is-safe)).

7. **Turn the Hub's own failover off.** The Hub moves the Apps of a Hub-mode Node that has been
   disconnected for 20 seconds to another Hub-mode Node, with empty volumes
   (`apps/hub/src/runtime/failover.ts`). From step 2 on, the installer stops Hub-mode agents on
   purpose: `work-remote`'s in step 5, while any Node you hold back in step 2 is still in Hub mode
   and would receive every App. On `work-remote`, add the setting to the Hub's env file:

   ```sh
   ENVFILE=$(ls ~/erainfra-env/hub.env ~/portless-env/hub.env 2>/dev/null | head -1); echo "$ENVFILE"
   grep -n FAILOVER "$ENVFILE"    # expect nothing; if a line is there, set it to 0 instead
   printf 'PORTLESS_FAILOVER=0\n' >> "$ENVFILE"
   ```

   Docker reads the env file only when it creates a container, so recreate the Hub's as
   [Recreate the Hub container](#recreate-the-hub-container) shows. Its last command prints `0`.
   Every App answers errors for the few seconds the Hub restarts, and the Hub-mode agents
   reconnect on their own. The rollback turns failover back on as its last step.

## 1. Copy the Hub into Convex

Set the secrets master key once, on production, from `packages/backend` as in
[Check which deployment the CLI reaches](#check-which-deployment-the-cli-reaches).
Every App secret Convex stores is encrypted under it, and a second key makes the first one's
secrets unreadable, so the command generates one only while none is set, and saves it to a file
only you can read before it sets it:

```sh
if current=$(npx convex env get --prod ERAINFRA_SECRETS_MASTER_KEY) && [ -z "$current" ]; then
  (umask 077 && openssl rand -hex 32 | tr -d '\n' > ~/erainfra-secrets-master-key)
  npx convex env set --prod ERAINFRA_SECRETS_MASTER_KEY --from-file ~/erainfra-secrets-master-key
else
  echo 'Not generated: the key is already set, or Convex could not be read. Keep the saved key.'
fi
unset current
```

`npx convex env get --prod` prints nothing for an unset variable and fails when it cannot reach the
deployment, so a repeat of this step never replaces a key. Move `~/erainfra-secrets-master-key`
into your password manager or another safe place, and delete it here.

The Hub keeps its database in SQLite WAL mode (`apps/hub/src/db.ts`): recent writes sit in a
`-wal` file beside the `.db` file until a checkpoint. A copy of the `.db` file alone misses them.
While the Hub runs, take a consistent snapshot with `VACUUM INTO` through the Hub's own Node.js,
then copy it and the secrets key out. The snapshot holds every account's password hash and every
secret, so each copy is created mode 0600, in a directory only you can enter:

```sh
mkdir -p -m 700 ~/hub-import && cd ~/hub-import
DB=$(docker exec portless-hub sh -c \
  'ls /data/erainfra-runtime/erainfra.db /data/portless-runtime/portless.db 2>/dev/null | head -1')
docker exec portless-hub sh -c 'rm -f /data/hub-import.db'
docker exec portless-hub node -e '
  process.umask(0o077);
  const { DatabaseSync } = require("node:sqlite");
  new DatabaseSync(process.argv[1]).exec("VACUUM INTO \x27/data/hub-import.db\x27");' "$DB"
docker run --rm -v portless-data:/data -v "$PWD":/out alpine sh -c \
  'umask 077 && cp /data/hub-import.db "$1" /out/ && chmod 600 /out/hub-import.db /out/secret.key &&
   rm /data/hub-import.db' _ "$(dirname "$DB")/secret.key"
sudo chown "$(id -u):$(id -g)" hub-import.db secret.key   # Docker wrote them as root
ls -l hub-import.db secret.key                            # -rw------- you, for both
```

Run the importer from the release checkout ([State in Convex](../infra-management.md#state-in-convex)).
Start with `--dry-run`; it writes nothing and lists every row the import would create, update, skip
or refuse:

```sh
CONVEX_URL=https://<deployment>.convex.cloud CONVEX_DEPLOY_KEY=<deploy key> \
  pnpm --filter @erainfra/backend import-hub-state \
    --db ~/hub-import/hub-import.db --secret-key ~/hub-import/secret.key --dry-run
```

`<deployment>` is the production name from the check above, and `<deploy key>` a production deploy
key (Convex dashboard, production deployment, Settings). The importer reads only these two and
ignores `.env.local`.

Drop `--dry-run` when it reports nothing refused. A row Convex refuses is reported, the rows around
it still apply, and the script exits non-zero. Two cases stop more than one row:

- The script itself refuses some Hub states before it sends anything, for example a secret scope
  that matches no App or more than one, or a route label two Apps claim or no gateway can serve.
  Then nothing is imported.
- A write that fails partway fails its whole batch, up to 200 rows, which Convex rolls back.
  Batches sent before it stay applied.

Either way, fix the cause on the Hub or in Convex and run it again.

The import is safe to repeat, and you repeat this whole step (snapshot, copy, import) before each
later step that moves a reader to Convex. It copies only what the Hub still owns. Once Convex
writes or deletes a row, that row is Convex's and every later import skips it, printing
`skipped … owned by Convex`:

- An App, with its routes and ports, becomes Convex's at its first deploy, failover or removal
  through Convex.
- An env variable, a link or a git binding becomes Convex's the first time Convex sets, adds,
  binds, removes or unbinds it, or a Convex run records its result on the binding.
- An account is copied once; Convex owns it from then on.

So a change made on the Hub to something Convex already owns is never imported. The
[ownership table](../infra-management.md#state-in-convex) lists every table. Delete the copies
afterwards (`rm -r ~/hub-import`); they hold every secret.

The Hub fails an App over by its primary Node and keeps each service's old Node in its App row,
while the App's node and its routes move. The importer places each routed service on its route's
Node, and once a route shows such a move, every other service of that App on the App's Node,
where the Hub redeployed it. It reports each such correction on the App's `created` or `updated`
line, and also every service it leaves off the App's Node. Read those lines: a redeploy that names
no Node keeps each service where the import put it.

Check what arrived:

```sh
erainfra nodes list    # every Hub Node, transport hub
erainfra apps list     # every App, status hub
erainfra links list    # every link, transport legacy for now
erainfra git bindings  # every branch the Hub deployed on push
```

## 2. Switch the Nodes that run no Apps

Do this for each Node that runs no Apps (`oracle-singapore-1` and `bielcrystal-aliyun-1` here), one
at a time. The Hub keeps serving every App throughout, because the App Node stays in Hub mode.

First, list the Hub's links that end on the Node. The Hub carries a link only while both of its
Nodes are in Hub mode, and Convex carries one only once both run `connect-convex`. So from this
step until `work-remote` switches in step 5, every link between this Node and `work-remote` is
down. That includes `registry-<node>`, the link the Hub made for a Node that once pulled from the
registry, and any link the company services on `bielcrystal-aliyun-1` use:

```sh
erainfra links list | grep -F oracle-singapore-1
```

A `registry-<node>` link alone is harmless here: nothing pulls on a gateway Node before step 5.
For any other link, ask whether what uses it can be down until step 5. If it cannot, do not
switch this Node now. Switch it right after `work-remote` in step 5, and run step 3 on it then;
one gateway is enough for the canary in step 4.

1. Enroll it and copy its credential to the Node. Never put the credential on a command line. The
   `umask` keeps the file 0600 from the start, and the `chmod` makes the copy on the Node private
   whatever its umask is:

   ```sh
   (umask 077 && erainfra nodes enroll oracle-singapore-1 > oracle-singapore-1.credential)
   scp oracle-singapore-1.credential oracle-singapore-1:
   ssh oracle-singapore-1 chmod 600 oracle-singapore-1.credential
   rm oracle-singapore-1.credential
   ```

2. On the Node, install the `connect-convex` agent and its sidecar. `--replace-hub-agent` stops and
   disables the Hub-mode `portless-agent.service` once the downloads verify, and keeps its unit
   file and its binary for a rollback. The new agent goes to
   `/usr/local/lib/erainfra/erainfra-node`. If the install fails after it stopped the Hub-mode
   unit, it starts that unit again and says so:

   ```sh
   curl -fsSL https://<deployment>.convex.site/install | sudo bash -s -- \
     --role node --convex --credential-file ./oracle-singapore-1.credential --replace-hub-agent
   rm oracle-singapore-1.credential
   ```

   The CI controllers on `oracle-singapore-1` are separate units; the installer does not touch
   them.

3. Within a minute `erainfra nodes list` shows the Node with transport `convex`, `online` and
   `MESH proven`. If not, `journalctl -u erainfra-node -n 50` says why.

Rolling one Node back is [Roll back to Hub mode](../infra-management.md#roll-back-to-hub-mode).

## 3. Make them gateways

On each of the two Nodes, set up the gateway proxy and its tunnel replica
([Set up a gateway Node](../infra-management.md#set-up-a-gateway-node)). Run it as your own user,
not under `sudo`: the script calls `sudo` itself and reads your `~/.cloudflared/cert.pem`. It
needs no checkout, only the script from the release tag the control plane pins
(`version` in `packages/backend/convex/agentRelease.ts`), and it finds the agent where step 2
installed it:

```sh
v=0.2.0-rc.11   # the pinned release
curl -fsSLO "https://raw.githubusercontent.com/Fanzzzd/erainfra/v$v/deploy/infra/gateway.sh"
ERAINFRA_ZONE=<zone> sh gateway.sh
sudo systemctl edit erainfra-node
#   [Service]
#   Environment=ERAINFRA_GATEWAY_ROUTES_FILE=/var/lib/erainfra-gateway/routes.json
sudo systemctl restart erainfra-node
erainfra nodes set-roles <name> gateway
```

Then on each gateway Node:

```sh
curl -s -H 'Host: localhost' http://127.0.0.1:61090/healthz   # {"ok":true,…}
cloudflared tunnel info erainfra-gateway                         # one connector per gateway Node
```

The route table lists every App with no upstream yet, so `curl -H 'Host: <app>.<zone>'` answers
503: their Node is still in Hub mode. That is expected until step 5. DNS has not moved, so visitors
still reach the Hub.

## 4. Canary through a gateway

Prove the whole gateway path with a test App on a gateway Node before any real App depends on it.
Use an image-only spec, so nothing is built and the registry is not involved. Pick an image the
Node can pull (Docker Hub may be slow or blocked from some regions; `docker pull` it there first to
check):

```sh
mkdir hello-retire && cat > hello-retire/erainfra.yaml <<'EOF'
services:
  web:
    image: traefik/whoami:v1.10
    port: 80
    route: true
EOF
erainfra deploy ./hello-retire --app hello-retire \
  --node oracle-singapore-1 --build-node oracle-singapore-1
# on a gateway Node:
cloudflared tunnel --config ~/.cloudflared/config-erainfra-gateway.yml \
  route dns erainfra-gateway hello-retire.<zone>
curl -fsS https://hello-retire.<zone>/
```

An explicit DNS record beats the `*.<zone>` wildcard, so only this name goes to the gateways. Also
request it on the other gateway Node, which reaches the App over the mesh:

```sh
curl -s -H 'Host: hello-retire.<zone>' http://127.0.0.1:61090/
```

While only test Apps run through Convex, check the rest of Convex's surface on them:

- **Logs.** `erainfra logs hello-retire` prints the container's last lines.
- **Failover.** Deploy a second test App, `hello-failover`, with two services, each pinned to one
  gateway Node with `node:` in its spec. Stop the agent on one of them
  (`sudo systemctl stop erainfra-node`). After about two and a half minutes
  `erainfra deployments list --app hello-failover` shows a `failover` run ending `done`, and both
  services run on the other Node. Start the agent again; it removes the moved container. Then
  `erainfra apps remove hello-failover --yes`. Only do this while no real App has a stored spec:
  failover moves every spec'd App off a silent Node, to any live Node, gateways included.

Keep `hello-retire` until step 6.

Now turn automatic failover off. Every real App runs on `work-remote`, and failover would move them
to a gateway Node with empty volumes the first time `work-remote` is silent for two minutes, a
reboot for example, and remove the old containers when it comes back:

```sh
npx convex env set --prod ERAINFRA_FAILOVER 0
```

Leave it off until there is a second Node that should run those Apps. That Node needs
`work-remote`'s CPU: an image built on `work-remote` is x86_64 only, so it cannot start on
`oracle-singapore-1`, which is aarch64.

## 5. Switch the App Node and move DNS, in one window

Get everything ready first, so the window holds only the commands that must be in it:

1. Stop changing anything through the Hub: no `portless deploy`, `env`, `link`, `bind` or account
   changes. Make every change with `erainfra` or the dashboard from now on.
2. Pause push-to-deploy. In the deploy GitHub App's settings, under Webhook, clear **Active** and
   save. A push the Hub deployed now would change what item 3 imports, and from the window on the
   Hub cannot reach `work-remote` at all, so its deploy would fail and the push would be lost.
   While the webhook is inactive GitHub sends nothing. Step 6 turns it on again at Convex and then
   deploys every bound branch from its head, so no push is missed.
3. Repeat step 1 (snapshot, copy, import), so Convex holds the Hub's last routes, ports and Apps.
4. Enroll `work-remote` and put its credential on it, as in step 2.1.
5. On a gateway Node, have this command typed and ready:
   `cloudflared tunnel --config ~/.cloudflared/config-erainfra-gateway.yml route dns --overwrite-dns erainfra-gateway '*.<zone>'`.

The window starts at the next command. On `work-remote`:

```sh
curl -fsSL https://<deployment>.convex.site/install | sudo bash -s -- \
  --role node --convex --credential-file ./work-remote.credential --replace-hub-agent
```

The installer downloads and verifies everything before it stops `portless-agent.service`; from
that moment the Hub answers errors for every App on `work-remote`. When it returns:

1. `erainfra nodes list` shows `work-remote` with transport `convex`, `online`, `MESH proven`.
2. On a gateway Node, each App answers through the proxy:

   ```sh
   for app in <every route label>; do
     curl -s -o /dev/null -w "$app %{http_code}\n" -H "Host: $app.<zone>" http://127.0.0.1:61090/
   done
   ```

3. Move the wildcard. On a gateway Node, the window ends when this returns:

   ```sh
   cloudflared tunnel --config ~/.cloudflared/config-erainfra-gateway.yml \
     route dns --overwrite-dns erainfra-gateway '*.<zone>'
   ```

Cloudflare answers visitors with its own addresses either way, so no client DNS cache has to
expire. Single-container Apps the Hub deployed are served without a redeploy, the same as Apps
with services.

Then check each App from outside, delete the `hello-retire` DNS record in the Cloudflare dashboard,
and watch `journalctl -u erainfra-gateway` and `/healthz` on both gateway Nodes for the next hour.
`portless.<zone>` keeps its own record and still reaches the Hub.

If an App answers 503 at a gateway in item 2, `erainfra apps view <app>` and the gateway's
`/healthz` route count show which route is missing. Roll back (below) rather than leave the window
open while you investigate.

Now that `work-remote` is on the mesh, name it as the registry Node, so builds on it push to its
registry and other Nodes pull from it over `registry-<node>` links:

```sh
npx convex env set --prod ERAINFRA_REGISTRY_NODE work-remote
```

If a Node was held back in step 2 because of a link, switch it now (step 2), then make it a
gateway (step 3).

## 6. Verify everything through Convex

From this step on, Convex is the authority. Run each check with the `erainfra` CLI, never
`portless`. Each check writes through Convex, and what it writes is Convex's from then on.

Do the first three in this order.

- **Set the deploy GitHub App's credentials.** A deploy from a private repository clones with a
  token Convex mints from them, so the deploys below fail without them. Set `ERAINFRA_GH_APP_ID`,
  `ERAINFRA_GH_APP_KEY` and `ERAINFRA_GH_WEBHOOK_SECRET` as
  [Push-to-deploy](../infra-management.md#push-to-deploy) shows.
- **Turn push-to-deploy back on, at Convex.** In the deploy GitHub App's settings, change the
  webhook URL from `https://<hub>/webhook/github` to
  `https://<deployment>.convex.site/github/webhook`, set **Active** again, and save. From then on
  pushes deploy from Convex, not the Hub. A binding copied from the Hub that names no deploy Node
  deploys where the App runs.
- **Deploy every real App once through Convex**, each bound one from its branch. That deploys the
  branch head, which includes every push made while the webhook was paused. Apps copied from the
  Hub have no stored spec, so `erainfra apps view <app>` says Convex cannot fail them over until
  they are deployed through it once. Name the Nodes every time, so no deploy lands anywhere else:

  ```sh
  # An App the Hub deployed from a bound branch (erainfra git bindings shows it):
  erainfra deploy --repo owner/name --branch main --app <app> \
    --node work-remote --build-node work-remote
  # An App deployed from a checkout:
  erainfra deploy ./path/to/checkout --app <app> --node work-remote --build-node work-remote
  ```

  Without `--node`, a deploy keeps an existing App on the Node it runs on and refuses if that Node
  is not connected, but naming it costs nothing. Each deploy is the moment that App becomes
  Convex's. A single-container App the Hub deployed with `-v` volumes needs a spec that mounts
  them, and a Convex service can only mount `<app>-<volume>`. Its first Convex deploy starts new
  containers beside the Hub's container `<app>`, which keeps running. Move its data to a volume of
  that form and remove the Hub's container first, as
  [Names and ownership](../infra-management.md#names-and-ownership) describes. The Infra Agent
  refuses to start the services on a volume the Hub's container still mounts. Gateways serve such
  an App without this step, so it can wait.

- **Links.** `erainfra links list` shows every link `mesh` and `active`, and each consumer reaches
  its provider on the surfaced port.
- **Env.** `erainfra env list <app>` shows the names the Hub had.
- **Push-to-deploy.** Push a commit to a bound branch; `erainfra deployments list --app <app>`
  shows a `git` run ending `done`. Bind any further branch with an admin token:

  ```sh
  erainfra git bind acme/web main --app web --build-node work-remote --deploy-node work-remote
  erainfra git bindings
  ```

- **Dashboard.** The Nodes, Apps, Deployments and Links pages show the same.

Then remove the test App: `erainfra apps remove hello-retire --yes`.

## 7. Stop the Hub, keep its data

Repeat step 1 with `--dry-run` once more. It should report nothing refused and nothing to create or
update; every App deployed in step 6 shows as `skipped … owned by Convex`. A row it would create or
update is a change someone made on the Hub after step 5 began. Drop `--dry-run` to copy it; the
import cannot overwrite anything Convex owns.

Then stop the Hub container and its tunnel connector, and copy the database files once the Hub is
stopped. With no writer left, the `.db` file together with its `-wal` and `-shm` files is the
complete state, transcripts included. Keep the copy elsewhere:

```sh
docker stop portless-hub
docker update --restart=no portless-hub
sudo systemctl disable --now portless-tunnel

mkdir -m 700 hub-final            # the copy holds every password hash
docker run --rm -v portless-data:/data:ro -v "$PWD/hub-final":/out alpine \
  sh -c 'cp -a /data/*-runtime/*.db* /out/'
sudo chown -R "$(id -u):$(id -g)" hub-final
```

`sqlite3 hub-final/portless.db` (or `erainfra.db`) opens it with the WAL applied. Do not delete
`portless-data`, `portless-registry` or the Hub's tunnel: they are the rollback source.

Leave the `portless-registry` container running: `ERAINFRA_REGISTRY_NODE` names this box, and it is
the image registry every build pushes to. Leave `portless.<zone>` in DNS; it answers 502 while the
Hub is stopped and costs nothing.

From now on:

- `portless` commands fail to reach the Hub. Use `erainfra` (`portless help` says so).
- Never run `deploy/infra/hub.sh` on this box again: it rebuilds the Hub from the checkout and
  restarts it with the old state. The rollback below starts the stopped container instead.
- Never `docker volume rm portless-data`. If disk space matters, archive the volume first and keep
  the archive with the Convex master key.

## Roll back

Until you delete `portless-data`, the Hub comes back with the state it had when it stopped. Work
done in Convex since then (deploys, env changes, links, removed Apps) is not in it.

The order matters. The Hub can serve an App only once its Node is back in Hub mode, so the App
Node goes back before DNS moves back. Between the two commands its Apps are down, as in step 5.

1. Make sure automatic failover is off before any Node stops talking to Convex:
   `npx convex env set --prod ERAINFRA_FAILOVER 0`. With it on, a Node you roll back looks lost: Convex
   moves its spec'd Apps to another Node and queues `docker rm -f` of their containers for when it
   reports again.
2. Start the Hub if it is stopped, and give it back the restart policy `hub.sh` gave it. Step 7 set
   it to `no`, and a Hub left that way stays down after the next reboot:

   ```sh
   docker start portless-hub
   docker update --restart unless-stopped portless-hub
   sudo systemctl enable --now portless-tunnel
   docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' portless-hub   # unless-stopped
   docker exec portless-hub printenv PORTLESS_FAILOVER                    # 0 until the last step
   ```

   Do not re-run `deploy/infra/hub.sh` for this. It rebuilds the Hub from whatever revision the
   checkout on this box is at now, not the one the Hub ran.

3. Put the App Node back in Hub mode, then immediately point the wildcard back at the Hub's tunnel.
   On `work-remote`:

   ```sh
   sudo systemctl disable --now erainfra-node
   { systemctl cat portless-agent; sudo cat /etc/portless/agent.env /etc/erainfra/agent.env 2>/dev/null; } |
     grep -E 'ERAINFRA_MESH_(SOCKET|BIN)'      # prints nothing: the Hub-mode agent runs links with dumbpipe
   sudo systemctl disable --now erainfra-mesh  # only if the grep printed nothing
   sudo systemctl enable --now portless-agent
   ```

   The `erainfra-mesh` sidecar keeps running when `erainfra-node` stops. It keeps every link
   Convex gave it, restores them from its state file when it restarts, and keeps listening on their
   local ports. A Hub-mode agent that runs its links with dumbpipe cannot bind those ports while it
   does, so stop the sidecar. If the grep printed a line, the Hub-mode agent drives the same
   sidecar: leave it running, and its next pass replaces Convex's links with the Hub's.

   `portless-agent.service` runs the binary it ran before step 5: `--convex` installed its own
   agent elsewhere. Then, on `work-remote` as the user that ran `hub.sh`, with the config it wrote:

   ```sh
   cloudflared tunnel --config ~/.cloudflared/config-portless.yml \
     route dns --overwrite-dns portless '*.<zone>'
   ```

   Remove any per-App records that point at `erainfra-gateway` as well.

4. Switch the gateway Nodes back to Hub mode
   ([Roll back to Hub mode](../infra-management.md#roll-back-to-hub-mode)), with the same sidecar
   check as item 3. Until they are back, the Hub's links to them stay down: on
   `oracle-singapore-1` that is `registry-oracle-singapore-1` (port 61050) and the link on port 60030. A control-plane rollback also waits for this item, since a Node on `connect-convex`
   needs the release that has the Node API. Revoke a Node's Convex credential
   (`erainfra nodes revoke <name>`) if it should leave the Convex mesh.
5. Redeploy through the Hub (`portless deploy` or `portless redeploy`) any App that changed in
   Convex after the cutover, and set again any env changed in Convex. Check `portless apps`.
6. Point the deploy GitHub App's webhook back at `https://<hub>/webhook/github`, with **Active**
   set, and bind on the Hub (`portless bind`) any branch bound in Convex after the cutover.
7. Turn the Hub's own failover back on, once `portless nodes` shows every Node connected. Delete
   the `PORTLESS_FAILOVER=0` line that [Before you start](#before-you-start) added to the Hub's env
   file, then recreate the container as below. Its last command then prints nothing.
8. Only now, if you need to, roll the control plane back
   ([deploy-control-plane.md](deploy-control-plane.md#when-a-rollback-to-v020-rc10-is-safe)).

## Recreate the Hub container

Docker reads `--env-file` only when it creates a container, so a change to the Hub's env file
takes effect only in a new container. This recreates `portless-hub` with the same image ID, mounts,
port, working directory and command it runs with now, and the env file as it is now. Run it on the
Hub's host, at a quiet moment: every App served through the Hub answers errors for the few seconds
it takes.

```sh
ENVFILE=$(ls ~/erainfra-env/hub.env ~/portless-env/hub.env 2>/dev/null | head -1)
rm -f ~/portless-hub.inspect.json                                  # a new file, so umask sets its mode
(umask 077 && docker inspect portless-hub > ~/portless-hub.inspect.json)  # 0600: it holds the Hub's secrets
IMAGE=$(docker inspect -f '{{.Image}}' portless-hub)
WORKDIR=$(docker inspect -f '{{.Config.WorkingDir}}' portless-hub)
PORT=$(docker inspect -f '{{with index .HostConfig.PortBindings "8787/tcp"}}{{(index . 0).HostIp}}:{{(index . 0).HostPort}}{{end}}' portless-hub)
MOUNTS=$(docker inspect -f '{{range .Mounts}}{{if eq .Type "volume"}}-v {{.Name}}:{{.Destination}} {{else}}-v {{.Source}}:{{.Destination}}{{if not .RW}}:ro{{end}} {{end}}{{end}}' portless-hub)
CMD=$(docker inspect -f '{{join .Config.Cmd " "}}' portless-hub)
printf '%s\n' "$ENVFILE" "$IMAGE" "$WORKDIR" "$PORT" "$MOUNTS" "$CMD"
```

Read the six lines before going on. With a Hub that `hub.sh` started they are the env file, an
image ID (`sha256:…`), `/srv/portless`, `127.0.0.1:61080`, three mounts (the bundle at
`/srv/portless:ro`, `/srv/agent-bin:ro` and `portless-data:/data`), and
`node --experimental-strip-types apps/hub/src/server.ts`. If any is empty, stop: this Hub was
started differently, and the command below would not reproduce it. Then:

```sh
docker rm -f portless-hub
docker run -d --name portless-hub --restart unless-stopped -p "$PORT:8787" $MOUNTS \
  -w "$WORKDIR" --env-file "$ENVFILE" "$IMAGE" $CMD
sleep 3
curl -fsS "http://$PORT/health" && echo && rm ~/portless-hub.inspect.json
docker exec portless-hub printenv PORTLESS_FAILOVER
```

`$MOUNTS` and `$CMD` are unquoted on purpose, so the shell splits them into separate arguments.
The Hub-mode agents reconnect within seconds. `~/portless-hub.inspect.json` holds the old
container's settings, including every secret in its environment, so it is created mode 0600 and
deleted once `/health` answers. If `/health` does not answer, `docker logs portless-hub` says why
and the file is kept for reference. Delete it once the Hub is back.
