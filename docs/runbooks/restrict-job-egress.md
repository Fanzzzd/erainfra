# Restrict a Profile's egress

A Profile's egress decides what its guests can reach: `public` (today's default), `audit` (public,
plus a per-Attempt record of every DNS name and new flow), or `allowlist` (only listed domains and
CIDRs). This runbook moves a Profile from public to allowlist without breaking its jobs. The design
is in [ADR 0015](../adr/0015-egress-is-a-property-of-the-profile.md).

## 1. Audit first

On the Profile's controller, set and restart:

```bash
RC_EGRESS_MODE=audit
RC_EGRESS_PRESETS=github            # optional in audit: names outside it are marked "unlisted"
RC_EGRESS_ALLOW=registry.npmjs.org  # optional in audit, same effect
```

The controller re-registers the Profile. Every Worker for it stops being admitted until it re-runs
readiness for the new policy, which happens within one Profile subscription update. On the dashboard
the Profile's isolation column shows `audit egress`, and each Worker's readiness lists an `Egress`
fact and a passing `egress-policy` check.

Let real jobs run for a while. Each finished Firecracker run on the Runs page has an **Egress**
toggle that shows the names it resolved and the flows it opened. With a list configured, anything
the list would refuse is marked `unlisted`.

## 2. Build the list

Collect the `unlisted` names across a representative set of runs. Prefer domains to CIDRs: the
resolver admits whatever addresses an allowed name resolves to, so a CDN that moves does not break
the job. Use `*.example.com` for a family of hosts; it does not match `example.com` itself. Use a
CIDR only for something addressed by IP.

## 3. Switch to allowlist

```bash
RC_EGRESS_MODE=allowlist
RC_EGRESS_PRESETS=github
RC_EGRESS_ALLOW=registry.npmjs.org,*.npmjs.org,objects.example-cdn.net,203.0.113.0/24
```

The controller refuses to start with an allowlist that names nothing, an unknown preset, an IPv6
CIDR, a one-label name, or any egress on a non-Firecracker executor. Restart it and watch the first
runs: a refused name shows as `blocked` in the run's egress record, and the job sees NXDOMAIN for it.
A direct connection to an unlisted address is dropped and shows as a `blocked` flow.

## Host override and precedence

`RC_EGRESS_MODE` and `RC_EGRESS_ALLOW` in a Worker's `/etc/runner-center/runtime.env` are the host
operator's override and apply to every guest on that Worker. The stricter layer wins:

- the effective mode is the stricter of the host's and the Profile's (`public` < `audit` <
  `allowlist`);
- a host allowlist keeps denying everything not in `RC_EGRESS_ALLOW`, whatever a Profile allows, so
  a guest under both reaches only what both allow;
- a Profile cannot open a private, host or special-purpose range; the operator must list it in
  `RC_EGRESS_ALLOW` and the Profile must list it too.

Changing `runtime.env` needs the provisioner re-run (it re-renders the nftables table) and a runtime
restart.

Drain the Worker before either. Never load the table by hand with `nft -f` on a host with running
guests. The table file starts with `delete table`, so loading it empties every per-guest set while
the guests keep running: their links accept IPv6 and borrowed source addresses again, and an
allowlist guest is no longer restricted. The runtime notices within 10 seconds, and at every
readiness check, and writes the elements back, logging `restored a running guest's link binding`.
Readiness fails if it cannot. Until then the guest is unprotected. The provisioner refuses to run
while any Firecracker VM is running and prints the drain steps:

1. Wait until the dashboard's Attempts page shows nothing running on the Worker. For a Profile's
   only Worker, follow [take the only Worker out of service](take-the-only-worker-away.md).
2. `sudo systemctl stop runner-center-runtime`, which ends the idle warm VMs.
3. `pgrep -x firecracker` must print nothing. Then re-run the provisioner.

`--force-network-reload` makes the provisioner go ahead anyway. Every running job then ends when it
restarts the runtime.

## What a broken Worker looks like

| Symptom on the dashboard                                                     | Cause and fix                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `egress-policy` failed: "needs the host resolver"                            | The runtime could not bind the resolver on the guest gateway, port 10053. `journalctl -u runner-center-runtime` names the error; free the port and restart the runtime. Public Profiles keep running meanwhile.                                                |
| `egress-policy` failed: "still hold egress state whose removal failed"       | A guest's set elements could not be removed at teardown. Wait for the Worker to be idle, then restart `runner-center-runtime`. Its unit reloads the table, which empties every per-guest set.                                                                  |
| `job-network-policy` failed: "missing its link binding or egress membership" | Someone reloaded or edited the table under a running guest, and the runtime could not write the guest's elements back. `journalctl -u runner-center-runtime` names the nft error. Cancel that job's workflow run, or drain the Worker and restart the runtime. |
| `egress-policy` failed: "cannot be enforced on this Worker"                  | The Profile lists a CIDR inside this Worker's guest subnet. Change the list or the Worker's `--network-subnet`.                                                                                                                                                |
| `job-network-policy` failed after an upgrade                                 | The table is from an older runtime. Re-run the host provisioner.                                                                                                                                                                                               |
| Worker shows degraded with "network.egress does not match"                   | The Profile's egress changed after the Worker last reported. It clears on the next readiness refresh.                                                                                                                                                          |

Readiness checks the live rule matches, operators, set references, verdicts and DNS redirect
port, plus chain priorities and policies and set definitions. Keeping a rule's comment while
changing its effect fails `job-network-policy`. Counters, handles and live element expiry do not
change the policy.

If CNI reuses an address while teardown is still running, registration waits for that address's
kernel cleanup. A failed cleanup refuses boot at that address for every Profile, including public
Profiles, until a retry purges the old permissions. Other addresses do not wait behind it.

To check by hand on a Worker (root), while an allowlist job runs:

```bash
nft list set inet runner-center rc_restricted    # the guest's address
nft list set inet runner-center rc_allow_dns     # guest . address, each with its TTL timeout
nft list set inet runner-center rc_blocked       # what the allowlist dropped
nft list set inet runner-center rc_guest_sources # every live guest's veth . address
```

Every rule here identifies a guest by its source address, so the address has to be the guest's
own. Each guest, public or not, is bound to the host side of its link in `rc_guest_links` and
`rc_guest_sources` before it boots. A packet arriving on that link with any other IPv4 source, or
any IPv6 at all, is dropped before the DNS redirect or the allowlist sees it, so a job cannot take a
neighbour's address to get that neighbour's egress.

## Limits worth knowing

- DNS over HTTPS to an allowed host is still DNS the resolver never sees. In audit mode such a
  lookup is missing from the name record, though the flow to the DoH server is recorded. In
  allowlist mode the DoH server is reachable only if it is on the list.
- Two names on one shared address (a CDN front) admit each other's traffic to that address. This is
  the limit of filtering by IP; SNI inspection would close it and is not implemented.
- Records are bounded to 256 names and 512 flows per Attempt; the rest is counted, not kept.
- If host-local hands a torn-down guest's address to a new guest before the old one's teardown
  collected its record, the old record is incomplete; the new guest never inherits the old one's
  permissions, because the address is purged before it is registered again.
