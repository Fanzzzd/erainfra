# Deploying Portless on a server

Stable, single-origin deploy behind **your domain** + a **dedicated Cloudflare named tunnel**,
protected by **Cloudflare Access**. No quick tunnels, no open ports, no public IP needed.

```
browser ──Access login──▶ https://portless.yourdomain.com
                                   │  (Cloudflare edge)
                          cloudflared named tunnel  ──▶  127.0.0.1:8787  (Portless API)
                                                              ├─ serves the dashboard (static)
                                                              └─ serves /trpc (control plane)
```

One origin, one hostname. The API serves both the dashboard and `/trpc`, so a single ingress
rule covers everything.

## Why not try.cloudflare?

Quick tunnels (`*.trycloudflare.com`) are account-less and ephemeral: the URL changes on every
restart and there's no uptime guarantee. They're only good for a throwaway demo. A **named
tunnel + your domain** gives a fixed URL that survives restarts — what you want for real use.
(The per-app **Publish** button still uses quick tunnels for now; see "Next" below.)

## 0. Prereqs on the server

- Linux with `systemd`
- `node >= 22` and `pnpm`
- `cloudflared`, logged in once: `cloudflared tunnel login` → writes `~/.cloudflared/cert.pem`
- A Cloudflare **zone** for your domain
- The Portless repo on the server (it's a git repo now — push to a remote and `git clone`, or `rsync` it over)

## 1. Run the installer

```bash
cd portless
PORTLESS_HOSTNAME=portless.yourdomain.com ./deploy/install.sh
# reuse a tunnel you already have instead of the default 'portless':
#   PORTLESS_HOSTNAME=portless.yourdomain.com PORTLESS_TUNNEL=my-tunnel ./deploy/install.sh
```

It installs deps, builds the dashboard with a generated owner token, writes
`deploy/portless.env`, creates a dedicated `portless` tunnel with an ingress rule
(`portless.yourdomain.com → http://localhost:8787`), routes the DNS, and installs two systemd
units (`portless-api`, `cloudflared-portless`). Both auto-restart and survive reboot.

## 2. Lock it down with Cloudflare Access  ← do this immediately

The dashboard ships an **owner token** baked into the bundle. Access is the real front door:
until it's in place, anyone who finds the URL has full control.

1. Cloudflare **Zero Trust** dashboard → **Access** → **Applications** → **Add an application**
2. **Self-hosted**
3. Application domain: `portless.yourdomain.com`
4. **Policy** → Action **Allow** → Include **Emails** → your email(s) (or an email domain / IdP group)
5. Save. Now loading the URL requires an Access login; only then is the dashboard (and its token) served.

That's real auth with zero code — and since you already use Cloudflare, nothing new to run.

## 3. Verify

```bash
curl -I https://portless.yourdomain.com        # 302 to the Access login = protected & up
journalctl -u portless-api -f                  # API logs
journalctl -u cloudflared-portless -f          # tunnel logs
```

Open `https://portless.yourdomain.com`, complete the Access login, and the dashboard loads
"API connected".

## Mesh: link your other machines (one-liner)

Once the hub is up, pull any other NAT'd box into the mesh with a single line — no public IP, no
account, no Rust toolchain. The hub serves the installer at `/mesh-node.sh`; it downloads a
**prebuilt `dumbpipe`** (iroh) and wires a link by cryptographic key.

A DB↔backend link is two halves, one line each:

```bash
# on the DB box — expose Postgres on the mesh; prints a ticket:
curl -fsSL https://portless.yourdomain.com/mesh-node.sh | sh -s -- share 5432

# on the backend box — dial that ticket onto a local port (transparent TCP):
curl -fsSL https://portless.yourdomain.com/mesh-node.sh | sh -s -- connect <ticket> 15432
```

The backend then talks to `127.0.0.1:15432` as if Postgres were local — **Postgres unchanged,
neither box needs a public IP**. `share` even prints the exact `connect` line to paste on the
other box. Identity is stable across restarts (a per-link key is persisted under
`~/.portless/mesh`), so a ticket keeps working after a reboot. Manage links with
`… | sh -s -- status` and `… | sh -s -- stop <name>`.

**Access caveat:** `/mesh-node.sh` must be fetchable *without* a login, so add a **Bypass** Access
policy scoped to that one path (Zero Trust → Access → your app → add policy: Action **Bypass**,
Include **Everyone**, path `/mesh-node.sh`). The script carries no secrets — it only installs
dumbpipe and runs share/connect.

**Relay:** links default to iroh's public relay (no signup). To stay fully self-hosted, run your
own iroh-relay (it speaks HTTPS/WebSocket, so it can ride a Cloudflare tunnel) and set
`IROH_RELAY_URL` in the node's environment — no script change needed.

## Updating

Pull new code, then re-run the installer (it reuses the existing token and tunnel):

```bash
git pull   # or rsync
PORTLESS_HOSTNAME=portless.yourdomain.com ./deploy/install.sh
```

## Uninstall

```bash
sudo systemctl disable --now portless-api cloudflared-portless
sudo rm /etc/systemd/system/portless-api.service /etc/systemd/system/cloudflared-portless.service
sudo systemctl daemon-reload
# optional: cloudflared tunnel delete portless ; remove the DNS record in the CF dashboard
```

## Files this creates

- `deploy/portless.env` — service env incl. the owner token (chmod 600, git-ignored)
- `deploy/state/` — projects registry + audit log (git-ignored)
- `~/.cloudflared/portless-config.yml` — the tunnel's ingress rules
- `/etc/systemd/system/{portless-api,cloudflared-portless}.service`

## Next (proper per-user auth)

Baked-token-behind-Access is the stable, lazy choice. To drop the shared token entirely, have the
API trust the `Cf-Access-Jwt-Assertion` header Access injects (verify it against your team's
`…cloudflareaccess.com/cdn-cgi/access/certs`) and derive the principal from the user's email. That
gives real per-user identity with no token in the bundle. Not wired yet — open when you want it.
