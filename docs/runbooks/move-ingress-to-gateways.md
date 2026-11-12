# Move a zone's ingress from the Hub to gateway Nodes

This runbook ran on the owner's fleet on 2026-11-08, as steps 2 to 5 of
[retire-the-hub.md](retire-the-hub.md). Its full text is in the `v0.2.0-rc.19` tag, the last
release that carries the Hub ([ADR 0020](../adr/0020-the-hub-leaves-main.md)).

## What ran

1. Two Nodes that run no Apps switched to `connect-convex` and became gateway Nodes: each ran
   `deploy/infra/gateway.sh` and was marked `erainfra nodes set-roles <name> gateway`. Each runs a
   replica of the `erainfra-gateway` Cloudflare tunnel and reaches Apps over `erainfra-mesh`.
2. A test App answered through the gateways on its own DNS record.
3. In one window, the App Node switched to `connect-convex` and the wildcard moved:
   `cloudflared tunnel route dns --overwrite-dns erainfra-gateway '*.<zone>'`.

Since then `*.<zone>` points at the `erainfra-gateway` tunnel. The Hub's own host,
`portless.<zone>`, kept its record on the Hub's `portless` tunnel, which is disabled.
[Gateway ingress](../infra-management.md#gateway-ingress) describes how the gateways work, how to
add one, and how to remove one.

## Roll back

Roll back from the `v0.2.0-rc.19` tag, never from main: main's Infra Agent has no Hub mode. In
that checkout, follow `docs/runbooks/move-ingress-to-gateways.md`, "Roll back", or, to bring the
whole Hub back, `docs/runbooks/retire-the-hub.md`, "Roll back". The App Node goes back to Hub mode
first and DNS second, and its Apps are down between the two commands.
