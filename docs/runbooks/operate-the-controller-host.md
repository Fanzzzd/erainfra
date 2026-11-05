# Runbook: operate Profile controllers

A Profile's controller is `runner-center-controller@<profile>`, one systemd unit per Profile. It
turns GitHub scale-set demand into Attempts and runs no jobs. Controllers can run on Workers or on
a dedicated Linux host. Convex gives one process the Profile's lease; every other process stands
by ([ADR 0014](../adr/0014-controllers-run-on-the-workers-under-a-lease.md)).

The holder renews every 10 seconds, with a 30-second expiry. Every controller write carries its
lease epoch. A stale write gets HTTP 412, which cancels the listener and closes the GitHub session.
A controller that cannot renew stops when its last grant expires, even if GitHub remains reachable.
A successor may then wait for GitHub to release its predecessor's abandoned session. The existing
409 backoff starts at 10 seconds and doubles to 60 seconds, with jitter; GitHub can retain an
abandoned session for minutes, so lease expiry alone is not a bound on resumed listening.

A Worker with a fresh network benchmark score below 40 waits an extra 15 seconds after a lease
becomes free. A better-connected standby gets the first chance; a lone poor Worker still serves.
Missing or seven-day-old benchmark data gets no penalty. Convex owns all lease timings in
`packages/backend/convex/controllerLease.ts`; controllers read them from the lease response.

## Profile settings and credentials

Register a Profile once from a dedicated controller's existing env file. That holder publishes
the executor, image, resources, pool and runner bounds, egress policy, GitHub registration URL,
runner group, labels and whether it publishes cache facts. Standbys read that contract from
Convex; they never register it or overwrite it. A Worker cannot take a Profile's lease until it
has advertised readiness for the same executor, image and resources. A pre-lease Profile without
a registered GitHub URL reports `profileIncomplete` until the upgraded dedicated controller
registers it.

The dedicated host's env remains the bootstrap source. Restart it to publish a changed contract;
do not keep a different contract in each standby's env file. There is no new dashboard editor or
CLI Profile writer in this change.

A Worker standby uses its existing machine token. Convex resolves the machine ID from that token
and accepts it on controller routes only while that machine holds the Profile's current lease.
Standbys can report only their own liveness for Profiles their Worker serves. Workers cannot
register, change or pause Profiles, even while holding the lease.

The holder obtains a short-lived GitHub App installation token from Convex. Configure these
server-side environment variables in the Convex dashboard:

- `CONTROLLER_GITHUB_APP_CLIENT_ID`: the controller App's client ID.
- `CONTROLLER_GITHUB_APP_PRIVATE_KEY`: that App's PEM RSA private key, PKCS#1 or PKCS#8. Real
  newlines and escaped `\n` both work.

Use the same controller App the dedicated host already uses, installed on the Profile's repository
or organization with the [README permissions](../../README.md#github-permissions-the-controller-needs).
The webhook App created by the dashboard's Manifest flow stays separate: its manifest lacks
organization Self-hosted runners and Contents read. Reusing it would widen the webhook path's
privileges. No key or App JWT is returned to a Worker.

Each of the two GitHub calls behind a token request has a 10-second bound, so a GitHub stall
answers the holder with 504 and it retries. Convex checks the lease again after GitHub answers and
withholds the token if the lease changed meanwhile.

Convex discovers the installation from the Profile's URL. A repository token names only that
repository and requests Administration write. An organization token requests Self-hosted runners
write. Actions, Metadata and Contents read are added only when the dedicated host registered
cache-facts publishing and the holder requests it. The holder refreshes five minutes before
expiry; a failed refresh keeps an unexpired token, never an expired one. Lease loss cancels the
honest holder's listener and fences its Convex writes. It does not revoke an installation token
already issued: a compromised host could reuse that scoped credential at GitHub until its
one-hour expiry. The scale-set client keeps the same Actions session during refresh, through the adapter in
`apps/controller/internal/githubscale/token.go`.

Enterprise runner registrations cannot use a GitHub App. Keep those Profiles on a dedicated
controller with `RC_GITHUB_TOKEN`; a Worker receives an explicit refusal for them. Dedicated
hosts keep their existing `RC_GITHUB_APP_*` or `RC_GITHUB_TOKEN` credentials and use the same lease
as Workers. `CONTROLLER_TOKEN_NEXT` still overlaps the current token for rotation.

## Install a Worker standby

The Worker must already be enrolled and ready for the Profile. The installer needs Linux with
systemd, outbound HTTPS to the Convex site and GitHub, and a release with
`AGENT_RELEASE.controller` populated. Until a release pins the controller binary, the installer
refuses rather than install unverifiable bytes.

Run from the Worker's account, through sudo:

```bash
curl -fsSL https://<deployment>.convex.site/install | sudo bash -s -- --role controller \
  --profile erainfra-4vcpu-ubuntu-2404 --no-prompt
```

Without `--controller-token-file`, the installer finds the Worker's env file at
`<SUDO_USER home>/.runner-center/agent/.env`. If the account or path differs, name it explicitly:

```bash
curl -fsSL https://<deployment>.convex.site/install | sudo bash -s -- --role controller \
  --profile erainfra-4vcpu-ubuntu-2404 \
  --worker-env-file /home/klaus/.runner-center/agent/.env --no-prompt
```

It extracts only `MACHINE_TOKEN`, validates its 32 hex characters, and copies it to
`/etc/runner-center/secrets/<profile>/machine-token`. The root-owned standby env file contains
only the Convex site, Profile name and that token's file path. Do not pass image, size, GitHub,
App or controller-token settings. If the Profile publishes cache facts (its dedicated controller
had `RC_CACHE_FACTS_URL` set), the standby must also take `--cache-facts-url` and
`--cache-signing-key-file`. Convex never leases such a Profile to a standby that lacks them: the
runners it served would get no facts and every cache request would be refused. A standby refused
for this reason stands by with reason `incapable`.

The installer downloads the pinned binary, checks its SHA-256, installs the embedded unit and
creates the unprivileged `runner-center-controller` account. It does not change the Worker,
its runtime, account or service. Shared `runner-center` directories keep their existing modes.

| Path                                                    | Owner and mode                      | Holds                          |
| ------------------------------------------------------- | ----------------------------------- | ------------------------------ |
| `/usr/local/lib/runner-center/runner-center-controller` | root, 0755                          | pinned binary                  |
| `/etc/systemd/system/runner-center-controller@.service` | root, 0644                          | release unit                   |
| `/etc/runner-center/profiles/<profile>.env`             | root, 0600                          | settings and secret file paths |
| `/etc/runner-center/secrets/<profile>/`                 | root:runner-center-controller, 0750 | secret files, 0640             |

systemd reads the env as root. The controller account reads the secret files. After a Worker
re-registers and changes its machine token, rerun with the same `--profile` and
`--worker-env-file`: the repair path refreshes the token copy and keeps the env file.

Check the service and the dashboard's Profiles table:

```bash
systemctl status runner-center-controller@erainfra-4vcpu-ubuntu-2404
journalctl -u runner-center-controller@erainfra-4vcpu-ubuntu-2404 -n 50
```

While another controller holds the lease, the log says `controller standing by`, with the holder,
retry delay and network penalty. After a grant it says `acquired controller lease`, then
`runner scale-set controller started`. The tooltip shows the host, Worker credential, lease epoch
and session state. A 409 means it has the lease but is waiting for GitHub's previous session.

## Migrate a live Profile from the VM to Workers

Do this per Profile. No command here retires the scale set.

1. Prepare a controller release containing the lease code and pin it in the deployment. Stage the
   binary on the VM, deploy the backend and restart the VM unit on that binary in one maintenance
   window. The new backend refuses every unfenced write, including from old dedicated binaries;
   there is no legacy bypass. GitHub queues demand during the short restart gap.
2. Configure the controller App's client ID and key in Convex. Leave the VM's credentials in place
   for rollback. Confirm the VM has acquired a lease, registered the GitHub URL and returned to
   listening. Check each Profile separately.
3. Install the standby on ubuntu0 with its Worker env file, as above. Wait for its heartbeat to
   appear beside the VM's. It must log `controller standing by` and identify the VM as holder.
   If it says `notReady` or `profileIncomplete`, fix that before proceeding.
4. Stop the VM's unit, without running `retire`:

   ```bash
   sudo systemctl disable --now runner-center-controller@<profile>
   ```

5. Watch ubuntu0 acquire a higher epoch and start listening. A graceful stop closes the old
   GitHub session before releasing the lease. A crash can add GitHub's lingering-session delay.
   Confirm the dashboard shows ubuntu0 listening with the Worker credential and submit a small
   workflow targeted at that Profile. Check its Attempt is created and reaches the Worker.
6. Install another ready Worker's standby when available. Keep the VM env and credentials in an
   encrypted backup until every Profile has taken over and survived a Worker restart.

Rollback before retiring the VM: stop the Worker standby units for that Profile on **every**
Worker, then start the VM unit on the lease-aware binary. Watch it acquire the lease and session.
A dedicated host has no priority over a Worker, so leaving a Worker holder running will leave the
VM standing by. Do not roll the controller binary back to a pre-lease release against this
backend. To return to that release, stop every controller and roll the backend back as well in a
maintenance window.

## Dedicated host install and update

A dedicated Linux/systemd host needs no KVM and no inbound ports. It needs outbound HTTPS to the
Convex site, GitHub's API and Actions service. Put secrets in files first; never put their values
on command lines or in shell history:

```bash
umask 077
mkdir -p ~/controller-secrets && cd ~/controller-secrets
read -rs CONTROLLER_TOKEN && printf '%s' "$CONTROLLER_TOKEN" > controller-token && unset CONTROLLER_TOKEN
cp /path/to/downloaded/app.private-key.pem github-app.pem
curl -fsSL https://<deployment>.convex.site/install | sudo bash -s -- --role controller \
  --profile erainfra-4vcpu-ubuntu-2404 \
  --github-config-url https://github.com/OWNER/REPOSITORY \
  --executor firecracker \
  --image-release ghcr.io/OWNER/runner-center-ubuntu-24.04-js@sha256:<digest> \
  --vcpus 4 --memory-mib 16384 --max-runners 16 \
  --controller-token-file "$PWD/controller-token" \
  --github-app-client-id <client-id> --github-app-installation-id <installation-id> \
  --github-app-private-key-file "$PWD/github-app.pem" --no-prompt
```

`--controller-token-file` explicitly selects dedicated mode even on an enrolled Worker host.
Enterprise scope takes `--github-token-file` instead of the App flags. For other Profile and cache
flags, use `--help`. Delete the source secret directory after confirming the service is online.

Rerun with another `--profile` to add one. Rerun with only `--profile` to repair without changing
its env. Use `--reconfigure` and the complete settings to replace that env. On a dedicated host,
starting the unit deliberately registers the env contract and activates a paused Profile once.
If it later loses its lease to retirement, the same process does not reactivate the Profile.

Update running instances on either kind of host:

```bash
curl -fsSL https://<deployment>.convex.site/install | sudo bash -s -- --role controller --update
```

`--update` downloads and verifies the pinned binary. If the installed binary already matches, it
changes nothing. Otherwise it keeps the old binary as
`runner-center-controller.bak-<old version>`, installs the new binary and unit, and restarts exactly
the instances that were running. It never starts a stopped instance, so a retired Profile stays
retired. A failed file replacement, `daemon-reload`, restart or health check triggers rollback:
it restores the binary and unit, reloads systemd, restarts the same instances and checks them again.
The installer exits with an error even if recovery succeeds. If recovery also fails, it reports
both failures and the backup paths for manual recovery. The previous unit is kept at
`/etc/systemd/system/runner-center-controller@.service.bak-<old version>` alongside the binary
backup, even after the installer exits. If either file cannot be restored, it skips restarts rather
than starting the rejected build. `--source file:///path/to/binary` changes where the bytes come
from, never which digest is accepted.

To roll back by hand:

```bash
sudo install -m 0755 /usr/local/lib/runner-center/runner-center-controller.bak-<version> \
  /usr/local/lib/runner-center/runner-center-controller
sudo cp -p /etc/systemd/system/runner-center-controller@.service.bak-<version> \
  /etc/systemd/system/runner-center-controller@.service
sudo systemctl daemon-reload
sudo systemctl restart 'runner-center-controller@<profile>'   # each instance that should run
```

A pre-lease backup is not a compatible rollback against the lease-enforcing backend.

## Retire a Profile

Stop all its units, including Worker standbys. `retire --yes` needs to acquire the lease and
refuses while another process holds it. Without `--yes` it only reads GitHub and reports:

```bash
sudo systemctl disable --now runner-center-controller@<profile>   # on every controller host
sudo sh -c 'set -a; . /etc/runner-center/profiles/<profile>.env; \
  exec /usr/local/lib/runner-center/runner-center-controller retire'
sudo sh -c 'set -a; . /etc/runner-center/profiles/<profile>.env; \
  exec /usr/local/lib/runner-center/runner-center-controller retire --yes'
```

Run retirement from the dedicated host's saved configuration and credentials. A Worker credential
cannot pause a Profile. The command checks GitHub's busy counters, pauses the Profile under its
lease, then deletes the scale set while renewing that lease. `--force` overrides the busy check.
Pausing first prevents another standby from recreating the scale set. If deletion fails, the
Profile stays paused; retry `retire --yes`. Starting the dedicated unit deliberately reactivates
it. Starting only a Worker standby does not.

## Rotation, monitoring and recovery

**Controller token.** Set `CONTROLLER_TOKEN_NEXT` in Convex, replace each dedicated host's token
file and restart it. In every Profile tooltip confirm those hosts report `CONTROLLER_TOKEN_NEXT`
before promoting it to `CONTROLLER_TOKEN` and clearing NEXT. Worker credentials are unaffected.
The two token slots belong to the same dedicated-host lease identity, so rotation does not
create a second holder.

**App key.** Generate a second key on the existing controller App. Replace
`CONTROLLER_GITHUB_APP_PRIVATE_KEY` in Convex, replace the saved keys on any dedicated hosts still
in use, restart those hosts and confirm operation before deleting the old key on GitHub.
Workers use the new key at their next installation-token refresh. Restart one Worker holder to
force a fresh mint and verify it can listen before deleting the old key; an already cached token
alone does not prove the new key works. A PAT rotates only on its dedicated hosts. Cache-signing-key rotation must also update the cache service; follow
[operate the job cache](operate-the-job-cache.md).

**Monitor.** Heartbeats report every 30 seconds while holding the lease and on session changes.
Standbys report on each acquire attempt, normally at most 45 seconds apart. Profiles show Online
when a recent report is listening, Waiting for session when only starting/standby/conflict reports
are live, and Offline after 90 seconds without a live report. The tooltip includes credential
source and holder epoch. `/metrics` exposes `erainfra_controller_up` and
`erainfra_controller_last_heartbeat_age_seconds`. Set a **No controller listening** alert, normally
three minutes. A failed heartbeat no longer means the holder can serve forever: lease renewal
is separate, and it stops at lease expiry if Convex is unreachable.

**Back up.** Encrypt the dedicated host's env files and secrets and keep the archive off-host:

```bash
sudo tar -C /etc/runner-center -czf - profiles secrets |
  age -r <your age recipient> > controller-host-$(date +%F).tar.gz.age
```

Never put the archive or `/etc/runner-center/secrets` in git or chat. Take a new backup after a
Profile change or secret rotation. A lost Worker controller needs no controller-secret backup:
re-enroll the Worker if necessary, wait for readiness, then rerun the standby installer. Restoring
a dedicated host needs the saved envs and secrets with root ownership, env mode 0600, secret
directories 0750 and secret files 0640 under the controller account's group; then rerun
`--role controller --profile <name> --no-prompt` for each Profile. A replacement host competes for
the lease; it cannot listen alongside a surviving old holder.
