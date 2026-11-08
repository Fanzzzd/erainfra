# Run a fleet relay

A fleet relay is n0's iroh-relay on a Node with a public address. It relays only for enrolled
Nodes, which it checks with Convex for every connection. Every Node lists it in
`ERAINFRA_MESH_RELAYS`, and n0's public relays can stay listed as a fallback. How the relay decides
who may use it is in [Fleet relay](../infra-management.md#fleet-relay).

The examples use the relay host `relay.on99.ai` at `134.185.92.116`. Replace both.

## Before you start

- **The host.** Linux with systemd, aarch64 or x86_64, a public IPv4 address, and nothing else
  listening on tcp/443, tcp/80 or udp/7842 (`relay.sh` checks and names the holder). It is usually
  already a `connect-convex` Node, but it need not be.
- **The backend.** The Convex deployment runs a release with `POST /api/v1/relay/access`. On an
  older one, `relay.sh` reports `does not exist` and the relay admits nobody.
- **Which relay each Node will use.** iroh does not read `ERAINFRA_MESH_RELAYS` in order. Each Node
  measures every relay it lists and makes the fastest its home relay; it moves only when another
  answers in less than two thirds of the time. A Node publishes only its home relay, and peers
  reach it through that one. With `ERAINFRA_MESH_N0_FALLBACK=true` a Node near one of n0's relays
  (n0 runs one in Singapore, `aps1-1.relay.n0.iroh.link`) may home there instead of on the fleet
  relay. Keep the fallback during the rollout. Step 6 says when to turn it off.

## 1. DNS: an A record, not proxied

Create `relay.on99.ai` as an A record to `134.185.92.116` with the proxy off ("DNS only", the grey
cloud). In the Cloudflare dashboard: zone `on99.ai`, DNS, Add record, type A. Or with an API token
that can edit the zone's DNS:

```sh
curl -fsS -X POST "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/dns_records" \
  -H "Authorization: Bearer $CF_API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"type":"A","name":"relay","content":"134.185.92.116","proxied":false,"ttl":300}'
```

The proxy must stay off for two reasons. Let's Encrypt validates the certificate by connecting to
tcp/443 at this address (the TLS-ALPN-01 challenge), and a proxied record would end TLS at
Cloudflare instead. Cloudflare's proxy also does not carry udp/7842. `cloudflared tunnel route
dns` makes a tunnel CNAME, so it cannot create this record.

Check: `dig +short relay.on99.ai` prints `134.185.92.116`.

## 2. Firewall: the host and the cloud

| Port     | What uses it                                                                       | Needed                    |
| -------- | ---------------------------------------------------------------------------------- | ------------------------- |
| tcp/443  | the relay itself (HTTPS and WebSocket) and Let's Encrypt's challenge               | yes                       |
| udp/7842 | QUIC address discovery: a Node learns its public address, which helps direct paths | yes, to keep direct paths |
| tcp/80   | the captive-portal probe iroh sends to `/generate_204`                             | no                        |

Without udp/7842 Nodes still relay through it, but they learn less about their own addresses, so
fewer pairs connect directly. Without tcp/80 the probe fails, which iroh does not treat as a
captive portal.

Open them in the host firewall. Oracle's Ubuntu images end the INPUT chain with a REJECT rule, so
insert before it and save:

```sh
sudo iptables -I INPUT -p tcp --dport 443 -m state --state NEW -j ACCEPT
sudo iptables -I INPUT -p udp --dport 7842 -j ACCEPT
sudo iptables -I INPUT -p tcp --dport 80 -m state --state NEW -j ACCEPT
sudo netfilter-persistent save
```

Skip a rule that `sudo iptables -S INPUT` already shows. Then open the same ports in the cloud's
own firewall. On OCI that is an ingress rule on the subnet's security list or on the instance's
network security group: source `0.0.0.0/0`, TCP destination port 443, UDP destination port 7842,
and TCP destination port 80 if you opened it on the host. Other clouds call it a security group
or firewall rule.

## 3. The shared secret

On the machine with the Convex CLI, from `packages/backend`, create the secret in a file only you
can read and give it to Convex:

```sh
(umask 077 && openssl rand -hex 32 | tr -d '\n' > ~/erainfra-relay-access-token)
npx convex env set --prod RELAY_ACCESS_TOKEN --from-file ~/erainfra-relay-access-token
scp ~/erainfra-relay-access-token <relay host>:erainfra-relay-access-token
```

The relay sends this secret with every access check. Convex answers `401` to any check without it,
so the route reveals nothing about the fleet to anyone else.

## 4. Install the relay

On the relay host, as a user with sudo, take `relay.sh` from the release the fleet runs and run it:

```sh
curl -fsSLO https://raw.githubusercontent.com/Fanzzzd/erainfra/<tag>/deploy/infra/relay.sh
ERAINFRA_RELAY_HOSTNAME=relay.on99.ai ERAINFRA_RELAY_CONTACT=<your email> \
ERAINFRA_CONVEX_SITE=https://<deployment>.convex.site \
ERAINFRA_RELAY_ACCESS_TOKEN_FILE=~/erainfra-relay-access-token sh relay.sh
rm ~/erainfra-relay-access-token
```

On a `connect-convex` Node `ERAINFRA_CONVEX_SITE` may be left out: the script reads it from
`erainfra-node.service`. The script:

- downloads `iroh-relay-v1.4.1-<arch>-unknown-linux-musl.tar.gz` from n0's GitHub release, checks
  its SHA-256 against the digest pinned in the script, and installs `/usr/local/libexec/iroh-relay`;
- writes `/etc/erainfra-relay/config.toml` with `[access.http]` pointing at
  `https://<deployment>.convex.site/api/v1/relay/access`, and the secret into
  `/etc/erainfra-relay/relay.env` (0600 root);
- starts `erainfra-relay.service` as the system user `erainfra-relay`, whose only capability is
  binding ports below 1024;
- asks Convex about an EndpointId no Node has. It should log `Convex holds this relay's secret`.
  `Convex holds a different RELAY_ACCESS_TOKEN` or `Convex has no RELAY_ACCESS_TOKEN` means step
  3 did not reach this deployment.

The first start asks Let's Encrypt for a certificate, which takes a few seconds. The certificate is
cached under `/var/lib/erainfra-relay/certs` and renewed by the relay. Re-run the script to change a
setting or to install a new pinned release. Without `ERAINFRA_RELAY_ACCESS_TOKEN_FILE`, a re-run
keeps the installed secret.

Other settings: `ERAINFRA_RELAY_CERT_FILE` and `ERAINFRA_RELAY_KEY_FILE` serve a certificate you
manage instead of Let's Encrypt (publicly trusted; a Cloudflare origin certificate will not do).
`ERAINFRA_RELAY_BIND=0.0.0.0` is for a kernel with IPv6 disabled. `ERAINFRA_RELAY_HTTP_PORT` moves
the probe port off 80. `ERAINFRA_RELAY_METRICS=127.0.0.1:9090` serves Prometheus metrics on
loopback.

## 5. Check the relay alone

```sh
curl -fsS https://relay.on99.ai/healthz          # from anywhere: a trusted certificate and an answer
sudo ss -ltnup '( sport = :443 or sport = :80 or sport = :7842 )'   # all three held by iroh-relay
journalctl -u erainfra-relay -n 20                # "relay: serving on [::]:443"
```

Convex must say `true` for a real Node. Take an EndpointId from
`erainfra nodes list --json | jq -r '.nodes[] | [.name, .endpoint.id] | @tsv'`, then on the relay
host:

```sh
sudo sed -n 's/^IROH_RELAY_HTTP_BEARER_TOKEN=/Authorization: Bearer /p' /etc/erainfra-relay/relay.env |
  curl -sS -X POST -H @- -H 'X-Iroh-Endpoint-Id: <EndpointId>' \
    https://<deployment>.convex.site/api/v1/relay/access; echo
```

It prints `true` for a Node with a proven endpoint and a live credential, and `false` otherwise. To
see the relay's own decisions, raise its log level for a while with `sudo systemctl edit
erainfra-relay`, adding `Environment=RUST_LOG=warn,iroh_relay=debug`, then restart it. A denied
client logs `HTTP access check failed: Deny access`.

## 6. List the relay on every Node

Start with the relay host, then one Node at a time. On each `connect-convex` Node run
`sudo systemctl edit erainfra-node` and put these lines in the drop-in:

```ini
[Service]
Environment='ERAINFRA_MESH_RELAYS=["https://relay.on99.ai"]'
Environment=ERAINFRA_MESH_N0_FALLBACK=true
```

Then `sudo systemctl restart erainfra-node`. The single quotes keep the JSON's double quotes
intact. A change to the relay policy rebinds the sidecar, so the Node's links drop for a few
seconds and its peers reconnect once it has published its new address. A Node still in Hub mode
takes its relay policy from the Hub's environment instead
([secure-node-mesh.md](secure-node-mesh.md#relays)).

A new Node, or one that just reset its endpoint, is refused by the relay until its key is proven.
It publishes the key to Convex directly, not through the relay, so the relay admits it on its next
reconnect. iroh retries a refused relay at least every 16 seconds, and the agent then publishes the
changed address after it has held for 3 seconds, at most once every 30 seconds.

Mark the relay host so the fleet's records show it: `erainfra nodes set-roles <name> relay`, listing
every role it already has as well, because the command replaces them. The `relay` role grants
nothing.

**Turning the fallback off.** Keep `ERAINFRA_MESH_N0_FALLBACK=true` while the fleet has one relay:
if that relay or Convex is down, a Node that loses its relay connection can still home on n0's.
The cost is that a Node which measures n0 as faster homes there, and traffic to it passes through
n0. Once every Node shows the fleet relay in step 7, set `ERAINFRA_MESH_N0_FALLBACK=false` on a
Node to keep it off n0 entirely. Do that fleet-wide only when a second fleet relay exists, or when
an outage of the one relay (Nodes behind NAT cannot reach each other) is acceptable.

## 7. Verify

On each Node, the agent logs its home relay each time it publishes:

```sh
journalctl -u erainfra-node | grep 'published mesh endpoint' | tail -n 1
# connect-convex: published mesh endpoint 3f9a… (1 relay https://relay.on99.ai/, 4 direct addresses)
```

Infra Agent releases before this change log only the count (`1 relay`). Convex records the same
address for every Node, whatever its release:

```sh
erainfra nodes list --json | jq -r '.nodes[] | [.name, (.endpoint.relayUrls | join(" "))] | @tsv'
```

A Node showing `https://relay.on99.ai/` homes on the fleet relay. One showing an n0 URL measured
n0 as faster, as described above. `0 relay` means it reaches no relay at all: check its
`ERAINFRA_MESH_RELAYS`, and on the relay host the access check in step 5. Last, `erainfra links
list` shows every link as `transport mesh`, and an App served through a gateway answers.

## Rotate the secret

1. Create a new secret file as in step 3 and set it as `RELAY_ACCESS_TOKEN_NEXT`. Convex now
   accepts both.
2. On each relay host, re-run `relay.sh` with `ERAINFRA_RELAY_ACCESS_TOKEN_FILE` naming the new
   file. It restarts the relay, and Nodes reconnect.
3. Set `RELAY_ACCESS_TOKEN` to the new secret and unset `RELAY_ACCESS_TOKEN_NEXT`
   (`npx convex env remove --prod RELAY_ACCESS_TOKEN_NEXT`).

## More than one relay

Run `relay.sh` on each public Node with the same secret file and list every URL in
`ERAINFRA_MESH_RELAYS`. Each Node homes on the one it measures fastest. The relays share nothing,
and a Node can reach a peer through the peer's home relay whether or not it lists that relay.

## Remove the relay

Take it off the Nodes first: remove the `ERAINFRA_MESH_RELAYS` line (and keep
`ERAINFRA_MESH_N0_FALLBACK=true` if the fleet still needs a relay) and restart each
`erainfra-node`. Then, on the relay host:

```sh
sudo systemctl disable --now erainfra-relay
sudo rm /etc/systemd/system/erainfra-relay.service && sudo systemctl daemon-reload
sudo rm -r /etc/erainfra-relay /var/lib/erainfra-relay /usr/local/libexec/iroh-relay
```

Delete the DNS record and close the ports last.

## Limits

- Revoking a Node stops its next relay connection, not one already open. That connection carries
  nothing: every sidecar refuses a peer outside its fleet after the QUIC handshake.
- Every client connection costs one Convex HTTP action, including a stranger's after it proves
  some key. iroh-relay 1.4.1 has no connection rate limit (`accept_conn_limit` is accepted in the
  config but not implemented), so a flood shows up as calls to `/api/v1/relay/access` in the Convex
  dashboard's logs.
- While Convex is unreachable the relay admits no new connection. Connections already open keep
  relaying.
- The pinned iroh-relay release follows the iroh version `apps/mesh` pins. Raise both together:
  the version and the two SHA-256 digests at the top of `relay.sh`.
