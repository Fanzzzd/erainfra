# Move a zone's ingress from the Hub to gateway Nodes

Today `*.<zone>` points at the Hub's tunnel (`portless` unless `ERAINFRA_TUNNEL_NAME` changed it),
and the Hub proxies each request over the App Node's `/data` socket. After this runbook it points at
the `erainfra-gateway` tunnel, whose replicas run on gateway Nodes and reach Apps over
`erainfra-mesh` ([Gateway ingress](../infra-management.md#gateway-ingress-phase-3b)). The Hub's own
host (`portless.<zone>`) has its own DNS record and stays on the Hub's tunnel.
[retire-the-hub.md](retire-the-hub.md) runs this runbook as its steps 2 to 5.

## Where traffic breaks

The two paths never serve the same App at once:

- The Hub reaches an App only while the App's Node runs in Hub mode, because only the Hub-mode
  agent opens the `/data` socket the Hub proxies over (`apps/hub/src/server.ts`).
- A gateway reaches an App only once the App's Node runs `connect-convex` with a proven mesh
  endpoint.

So switching an App Node takes its Apps off the Hub, and they come back only when their DNS points
at the gateways. Do the switch and the DNS move together, in one window, and expect every App on
that Node to answer errors for its length: about a minute when the commands run back to back.
Gateway Nodes themselves run no Apps, so setting them up costs no traffic.

## Before you start

1. **Gateway Nodes run no Apps.** Two Nodes in different places give the tunnel two replicas, so
   one can fail. They run `connect-convex` with a sidecar
   ([Set up a Node](../infra-management.md#set-up-a-node)).
2. **Convex holds the Hub's current routes.** Re-run the Hub importer
   ([State in Convex](../infra-management.md#state-in-convex)) right before the window, and do not
   deploy through the Hub after it: a Hub deploy changes the Hub's `routes`, not Convex's.
3. **You have a Cloudflare origin cert for the zone** (`~/.cloudflared/cert.pem`) on each gateway
   Node. Run the DNS commands below on a gateway Node, as the user that ran `gateway.sh`: each
   passes the config it writes, `~/.cloudflared/config-erainfra-gateway.yml`. Without `--config`,
   `cloudflared tunnel route dns` reads a default config (`~/.cloudflared/config.yml`,
   `/etc/cloudflared/config.yml`) and routes to the tunnel that file names.
4. **You know which links drop when a gateway Node switches.** A Hub link stops when either of its
   Nodes leaves Hub mode, and Convex carries it only once both run `connect-convex`. List them
   with `erainfra links list | grep -F <node>`. Switch a Node whose links must not drop in the
   same window as the App Node at their other end.
5. **The Hub's own failover is off.** The Hub moves the Apps of a Hub-mode Node that has been
   disconnected for 20 seconds to another Hub-mode Node, with empty volumes. The installer stops
   Hub-mode agents on purpose here, so a Node you hold back in Hub mode would receive every App of
   the Node that switches. Set `PORTLESS_FAILOVER=0` in the Hub's env file and recreate its
   container ([retire-the-hub.md, Before you start](retire-the-hub.md#before-you-start), item 7).

## 1. Set up two or more gateway Nodes

On each gateway Node, run `deploy/infra/gateway.sh` with the same `ERAINFRA_ZONE` and tunnel name,
set `ERAINFRA_GATEWAY_ROUTES_FILE` for its Infra Agent, and mark it a gateway
([Set up a gateway Node](../infra-management.md#set-up-a-gateway-node)). Run the script as your
own user, not under `sudo`. It needs no checkout: take it from the release tag the Node's agent
came from. It finds the agent where `/install --role node --convex` put it:

```sh
curl -fsSLO "https://raw.githubusercontent.com/Fanzzzd/erainfra/v<version>/deploy/infra/gateway.sh"
ERAINFRA_ZONE=<zone> sh gateway.sh
sudo systemctl edit erainfra-node
#   [Service]
#   Environment=ERAINFRA_GATEWAY_ROUTES_FILE=/var/lib/erainfra-gateway/routes.json
sudo systemctl restart erainfra-node
erainfra nodes set-roles <name> gateway
```

Then check each one:

```sh
curl -s -H 'Host: localhost' http://127.0.0.1:61090/healthz   # {"ok":true,…}
cloudflared tunnel info erainfra-gateway                         # one connector per gateway Node
```

Routes whose Node is still in Hub mode are in the table with no upstream and answer 503 here.
Nothing public has moved yet.

## 2. Canary a test App

Deploy a test App through Convex on a gateway Node, with an image-only spec so nothing is built,
and give it its own DNS record. An explicit record beats the wildcard (hub.sh relies on the same
rule), so only this name moves:

```sh
erainfra deploy ./hello-retire --app hello-retire \
  --node <gateway node> --build-node <gateway node>
cloudflared tunnel --config ~/.cloudflared/config-erainfra-gateway.yml \
  route dns erainfra-gateway hello-retire.<zone>
```

[retire-the-hub.md, step 4](retire-the-hub.md#4-canary-through-a-gateway) has the spec. Check
`https://hello-retire.<zone>` from outside: pages, a large upload or download, and a WebSocket (the
Hub could not serve those). On the other gateway Node,
`curl -H 'Host: hello-retire.<zone>' http://127.0.0.1:61090/` reaches it over the mesh. The
gateway's journal (`journalctl -u erainfra-gateway`) logs upstream failures.

## 3. Switch the App Nodes and move the wildcard

Turn Convex's automatic failover off first:

```sh
npx convex env set --prod ERAINFRA_FAILOVER 0
```

The Apps on the App Nodes get a stored spec when you deploy them through Convex after this step,
and from then on failover would move them to a gateway Node with empty volumes the first time
their Node is silent for two minutes (a reboot, for example), then remove the old containers when
it comes back. Leave it off until there is a second Node that should run those Apps.

Prepare: re-run the importer, enroll each App Node and put its credential on it, and have the
DNS command typed on a gateway Node. Then, in one window:

1. On each App Node, switch to `connect-convex`:

   ```sh
   curl -fsSL https://<deployment>.convex.site/install | sudo bash -s -- \
     --role node --convex --credential-file ./<node>.credential --replace-hub-agent
   ```

   From the moment it stops `portless-agent.service`, the Hub can no longer serve this Node's Apps.

2. `erainfra nodes list` shows the Node `convex`, `online`, `MESH proven`. On a gateway Node, each
   of its Apps answers through the proxy:

   ```sh
   for app in <every route label>; do
     curl -s -o /dev/null -w "$app %{http_code}\n" -H "Host: $app.<zone>" http://127.0.0.1:61090/
   done
   ```

3. Move the wildcard, on a gateway Node:

   ```sh
   cloudflared tunnel --config ~/.cloudflared/config-erainfra-gateway.yml \
     route dns --overwrite-dns erainfra-gateway '*.<zone>'
   ```

This rewrites the proxied `*` CNAME to the gateway tunnel. Cloudflare answers visitors with its own
addresses either way, so no client DNS cache has to expire.

With several App Nodes you can move one Node at a time instead: switch it, then give each of its
App labels an explicit record to `erainfra-gateway`, as for the canary. Move the wildcard after the
last Node, then delete the explicit records.

Then delete the canary's record in the Cloudflare dashboard, so that the rollback below moves every
App at once. Check a few Apps from outside, and watch the gateway journals and `/healthz` on every
gateway Node for the next hour.

The gateways learn routes only from Convex. Deploy these Apps through Convex
([phase 3a](../infra-management.md#deploy-and-failover-from-convex-phase-3a)), whose pipeline and
failover write the route rows the gateways read. A route row whose port is not the one allocated to
that App on that Node is refused (503) rather than sent to whatever holds that port. A
single-container App the Hub deployed has no allocation and is served as long as nothing Convex
knows of holds its port: no allocation, no mesh link listener, and none of the host-service ports
([What Convex sends](../infra-management.md#what-convex-sends)).

## Roll back

The Hub serves an App only once its Node is back in Hub mode, so the App Node goes back first and
DNS second. Its Apps are down between the two commands.

1. Turn automatic failover off before any Node stops talking to Convex:
   `npx convex env set --prod ERAINFRA_FAILOVER 0`. Otherwise Convex treats the rolled-back Node as lost,
   moves its spec'd Apps elsewhere and queues `docker rm -f` of their containers there.
2. On each App Node:

   ```sh
   sudo systemctl disable --now erainfra-node
   { systemctl cat portless-agent; sudo cat /etc/portless/agent.env /etc/erainfra/agent.env 2>/dev/null; } |
     grep -E 'ERAINFRA_MESH_(SOCKET|BIN)'      # prints nothing: the Hub-mode agent runs links with dumbpipe
   sudo systemctl disable --now erainfra-mesh  # only if the grep printed nothing
   sudo systemctl enable --now portless-agent
   ```

   The sidecar keeps listening on the local ports of the links Convex gave it, which a dumbpipe
   link needs ([Roll back to Hub mode](../infra-management.md#roll-back-to-hub-mode)).

3. On the Hub's host, as the user that ran `hub.sh`, point the wildcard back at the Hub's tunnel
   with the config `hub.sh` wrote:

   ```sh
   cloudflared tunnel --config ~/.cloudflared/config-portless.yml \
     route dns --overwrite-dns portless '*.<zone>'
   ```

The Hub still has its `*.<zone>` ingress rule from hub.sh and proxies over `/data` again once the
Hub-mode agent reconnects. Remove any per-App records that point at `erainfra-gateway` as well.
Routes changed in Convex after the cutover (a deploy or failover, for example) are not in the Hub's
database; check `portless apps` after a rollback. Once `portless nodes` shows every Node connected,
turn the Hub's own failover back on: delete `PORTLESS_FAILOVER=0` from its env file and recreate
its container ([retire-the-hub.md](retire-the-hub.md#recreate-the-hub-container)).

## Retire the Hub's ingress

When the zone has run on the gateways long enough to trust them, the Hub's tunnel needs only its own
host. Leave the `*.<zone>` rule in `~/.cloudflared/config-portless.yml` alone until the Hub itself is
retired: it is harmless while no DNS record points the wildcard at that tunnel, and it is what makes
the rollback above a single DNS command.

## Remove a gateway Node

1. Remove the role: `erainfra nodes set-roles <name> --clear` (or `infra/nodes:setPlacementRoles`
   with `"roles":[]`). Its links and grants go on
   the next snapshot, and its routes file becomes an empty table.
2. `sudo systemctl disable --now erainfra-gateway-tunnel erainfra-gateway`. Its replica leaves the
   tunnel and Cloudflare sends its share to the other gateways.

Never remove the last gateway while the wildcard points at its tunnel; roll back first.
