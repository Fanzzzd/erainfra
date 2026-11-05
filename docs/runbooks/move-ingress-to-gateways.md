# Move a zone's ingress from the Hub to gateway Nodes

Today `*.<zone>` points at the Hub's tunnel (`portless` unless `ERAINFRA_TUNNEL_NAME` changed it),
and the Hub proxies each request over the App Node's `/data` socket. After this runbook it points at
the `erainfra-gateway` tunnel, whose replicas run on gateway Nodes and reach Apps over
`erainfra-mesh` ([Gateway ingress](../infra-management.md#gateway-ingress-phase-3b)). The Hub's own
host (`portless.<zone>`) has its own DNS record and stays on the Hub's tunnel.

Rollback is one DNS command as long as the Hub keeps running, so keep it running until you are
done with this zone.

## Before you start

1. **Every routed App must run on a `connect-convex` Node with a sidecar.** A gateway reaches only
   Nodes with a proven endpoint. List the routes and their Nodes:

   ```sh
   npx convex run infra/apps:routes --identity '{"subject":"<users _id>|cli"}'
   npx convex run infra/nodes:list --identity '{"subject":"<users _id>|cli"}'
   ```

   Each route's `nodeId` needs an `endpointId` in `nodes:list`. A route that fails this check gets
   503 from the gateways after the cutover. Move its Node first, or leave the zone on the Hub.

2. **Convex must hold the Hub's current routes.** Re-run the Hub importer
   ([State in Convex](../infra-management.md#state-in-convex)) right before the cutover, and do not
   deploy through the Hub between the import and the cutover: a deploy changes the Hub's `routes`,
   not Convex's.
3. You need a Cloudflare origin cert for the zone (`~/.cloudflared/cert.pem`) on the machine where
   you run the DNS commands below.

## 1. Set up two or more gateway Nodes

On each gateway Node, run `deploy/infra/gateway.sh` with the same `ERAINFRA_ZONE` and tunnel name,
set `ERAINFRA_GATEWAY_ROUTES_FILE` for its Infra Agent, and mark it a gateway
([Set up a gateway Node](../infra-management.md#set-up-a-gateway-node)). Two Nodes in different
places give the tunnel two replicas, so one can fail.

Then, on each gateway Node, request every route through the proxy without involving DNS:

```sh
curl -s -H 'Host: localhost' http://127.0.0.1:61090/healthz
for app in web api; do   # every route label
  curl -s -o /dev/null -w "$app %{http_code}\n" -H "Host: $app.<zone>" http://127.0.0.1:61090/
done
cloudflared tunnel info erainfra-gateway   # one connector per gateway Node
```

Expect the same status codes the Hub returns for the same paths. A 503 means the route's Node is
not reachable over the mesh (see "Before you start", step 1).

## 2. Canary one App

An explicit DNS record beats the wildcard (hub.sh relies on the same rule), so you can move one App
first:

```sh
cloudflared tunnel route dns erainfra-gateway web.<zone>
```

Check `https://web.<zone>` from outside: pages, a large upload or download if the App has one,
and a WebSocket if it uses them (the Hub could not serve those). The gateway's journal
(`journalctl -u erainfra-gateway`) logs upstream failures.

To undo the canary, point that name back at the Hub's tunnel with
`cloudflared tunnel route dns --overwrite-dns portless web.<zone>`, or delete the record in the
Cloudflare dashboard so the wildcard applies again.

## 3. Cut over the wildcard

```sh
cloudflared tunnel route dns --overwrite-dns erainfra-gateway '*.<zone>'
```

This rewrites the proxied `*` CNAME to the gateway tunnel. Cloudflare answers visitors with its own
addresses either way, so no client DNS cache has to expire. Requests already in flight through the
Hub finish there.

Then delete the canary's explicit record from step 2 in the Cloudflare dashboard, so that the
rollback below moves every App at once.

Check a few Apps from outside, and watch the gateway journals and `/healthz` on every gateway Node
for the next hour. The Hub keeps serving its own host and stays ready for a rollback.

The gateways learn routes only from Convex. Deploy these Apps through Convex
([phase 3a](../infra-management.md#deploy-and-failover-from-convex-phase-3a)), whose pipeline and
failover write the route rows the gateways read. A deploy or failover on the Hub changes only the
Hub's database: re-run the Hub importer after any Hub deploy that adds or moves a route, or the
gateways keep sending that App's traffic to where Convex last saw it. A route row whose port is not
the one allocated to that App on that Node is refused (503) rather than sent to whatever holds
that port.

## Roll back

On the Hub box (or anywhere with the origin cert), point the wildcard back at the Hub's tunnel:

```sh
cloudflared tunnel route dns --overwrite-dns portless '*.<zone>'
```

The Hub still has its `*.<zone>` ingress rule from hub.sh and still proxies over `/data`, so
nothing else changes. Remove any per-App records that point at `erainfra-gateway` as well. Routes
changed in Convex after the cutover (failover, for example) are not in the Hub's database; check
`portless apps` after a rollback.

## Retire the Hub's ingress

When the zone has run on the gateways long enough to trust them, the Hub's tunnel needs only its own
host. Leave the `*.<zone>` rule in `~/.cloudflared/config-portless.yml` alone until the Hub itself is
retired: it is harmless while no DNS record points the wildcard at that tunnel, and it is what makes
the rollback above a single command.

## Remove a gateway Node

1. Remove the role: `infra/nodes:setPlacementRoles` with `"roles":[]`. Its links and grants go on
   the next snapshot, and its routes file becomes an empty table.
2. `sudo systemctl disable --now erainfra-gateway-tunnel erainfra-gateway`. Its replica leaves the
   tunnel and Cloudflare sends its share to the other gateways.

Never remove the last gateway while the wildcard points at its tunnel; roll back first.
