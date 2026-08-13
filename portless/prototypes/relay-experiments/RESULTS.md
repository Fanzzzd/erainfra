# Connection prototypes — what was tried & measured (2026-06-25)

Goal: with **no public IP, no IPv6, only a Cloudflare tunnel reachable**, get
backend↔DB (both NAT'd) talking, and find the best link method. Tested on this Mac
using **disposable loopback processes as the "machines"** (Docker hangs here; touching the
host TUN would risk the user's VPN — so everything ran as plain processes, killed after each
run, host networking untouched).

`main.go` = Direction A (own TCP relay) + echo "DB" + probe. `ws.go` = Direction C
(WebSocket relay that can ride a Cloudflare tunnel). Build: `go build -o plp .`

## Direction A — our own relay, peers outbound-only (the core thesis)
Topology: `backend-agent → relay ← db-agent → DB`. Backend and DB **never connect directly**;
both dial OUT to the relay, which bridges them by key/session.

| path | correctness | latency (p50) | throughput |
|---|---|---|---|
| direct baseline | 200/200 ✅ | 36–40 µs | ~8–14 Gbit/s |
| **through relay** | **200/200 ✅** | **93–123 µs** | **5.7–6.7 Gbit/s** |

✅ Proves the model: two outbound-only peers, bridged by a reachable relay, **byte-for-byte
transparent TCP** (any protocol). Software overhead ≈ +60–115 µs, keeps ~60–70% throughput.
NOTE: this latency is **loopback only** — the relay was local. In production the relay sits
behind the CF tunnel, so the real cost is the CF-edge round-trip, not this.

## Direction B — iroh (`dumbpipe` v0.39), dial-by-key
Topology: `dumbpipe connect-tcp ← (iroh, by endpoint-id) → dumbpipe listen-tcp → DB`.

| | correctness | latency (p50) | throughput |
|---|---|---|---|
| through iroh | 200/200 ✅ | **~90 ms** | 218 Mbit/s |

✅ Dial-by-key works with **no IP** (the model the user wants). BUT:
- ~90 ms on a *loopback* test ⇒ it **fell back to a remote relay** (a direct same-machine path
  would be <1 ms). This Mac's VPN breaks UDP P2P, so iroh couldn't hole-punch — the same thing
  that will happen on fully-NAT'd boxes.
- iroh's **default relay is n0's public servers = third-party** (violates "self-hosted only").
  Would require self-hosting an iroh relay.
- Rust, no official Go (our agent is Go) → embed via FFI or run as a sidecar.

## Direction C — relay behind a REAL Cloudflare tunnel (the user's exact constraint)
WS relay (`ws.go`) exposed via `cloudflared tunnel --url`; both agents connect outbound over
`wss://…trycloudflare.com`. **Code built + correct, but end-to-end blocked on this Mac**: curl
to the trycloudflare URL returned `000` for 80 s — the same VPN/fake-IP interference that broke
every Cloudflare path this session (`api.cloudflare.com` → `198.18.x`). Not an architecture
failure; needs the user's real boxes (or VPN off) to validate. The earlier `local.publish` test
*did* get a working public trycloudflare fetch once, so the CF path itself is sound.

## Verdict
- The A vs B latency gap is **not** a fair production comparison (A's relay was local, B's was
  remote). Apples-to-apples, both are relay architectures under the hard constraint; the decision
  is **model/fit + can-the-relay-ride-a-CF-tunnel + is-the-relay-self-hostable**.
- For **transparent DB↔backend** (Postgres unmodified): want a **virtual-IP/TUN overlay with a
  WSS relay that rides the CF tunnel** → **EasyTier** (productizes Direction C with a TUN), or our
  own WS relay (`ws.go`) as the minimal self-built version.
- **iroh** only if traffic is app-integrated (our agent moving data by key), and only with a
  self-hosted relay.

Reproduce (all self-contained, processes killed after): see the orchestration in the session log.
