# Retire the Hub

This runbook ran on the owner's fleet on 2026-11-08. Its full text, with every command, is in the
`v0.2.0-rc.19` tag, the last release that carries the Hub. The Hub's code left main with
[ADR 0020](../adr/0020-the-hub-leaves-main.md), so this file records what ran, what the hosts still
hold, and how to roll back. It is not a procedure to run against main.

## What ran

1. The Hub importer copied the Hub's state into Convex: users, Nodes, Apps, routes, env, links and
   GitHub bindings. It did not copy the chat transcripts, the Hub's API tokens or its sessions.
2. The Nodes that run no Apps switched to `connect-convex`
   (`/install --role node --convex --credential-file <path> --replace-hub-agent`) and became the
   gateway Nodes ([move-ingress-to-gateways.md](move-ingress-to-gateways.md)).
3. A test App answered through a gateway on its own DNS record.
4. In one window, the App Node switched to `connect-convex` and `*.<zone>` moved to the
   `erainfra-gateway` tunnel.
5. The deploy GitHub App's webhook moved to Convex, and every App, link and Node was checked
   through Convex (`erainfra apps view`, `erainfra links list`, `erainfra git bindings`).
6. The Hub stopped: `docker stop portless-hub`, its restart policy set to `no`, and
   `portless-tunnel` disabled. The database files were copied out of the stopped Hub.

## What the hosts still hold

- The Hub's host, which is also the App Node: the stopped `portless-hub` container, its
  `portless-data` volume (the rollback source; never delete it), the disabled `portless-tunnel`
  unit, and its env file under `~/portless-env/`. The `portless-registry` container still runs
  there: it is the fleet's image registry (`ERAINFRA_REGISTRY_NODE` names this Node).
- Every Node that ran in Hub mode: the disabled `portless-agent.service`,
  `/etc/portless/agent.env`, and the Hub-mode Infra Agent under `~/.portless/bin`.
- `portless.<zone>` in DNS. It answers errors while the Hub is stopped.

## Roll back

Roll back from the `v0.2.0-rc.19` tag, never from main. Main's `/install` has no Hub mode, and
main's Infra Agent has no `connect` command.

1. Check out the tag: `git checkout v0.2.0-rc.19`. Before any `npx convex` command, check which
   deployment the CLI reaches
   ([deploy-control-plane.md](deploy-control-plane.md#check-which-deployment-the-cli-reaches)).
2. Follow that checkout's `docs/runbooks/retire-the-hub.md`, "Roll back", in full. In short, it
   turns Convex failover off, starts the stopped Hub container, puts each Node back on
   `portless-agent.service` (the Hub-mode binary it ran before the cutover), and points `*.<zone>`
   back at the Hub's tunnel. Work done in Convex since the cutover is not in the Hub's database.
3. Roll the control plane back only after that, with the tag's
   `docs/runbooks/deploy-control-plane.md`.

The rollback works only while the hosts hold everything listed above.
