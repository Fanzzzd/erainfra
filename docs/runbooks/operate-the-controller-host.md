# Runbook: operate Profile controllers

A Profile's controller is `runner-center-controller@<profile>`, one systemd unit per Profile. It
turns GitHub scale-set demand into Attempts and runs no jobs. Controllers can run on Workers or on
a dedicated Linux host. Convex gives one process the Profile's lease; every other process stands
by. [Install a controller](../controllers.md#install-a-controller) states the lease timings, what
HTTP 412 and 409 mean, and the network-score delay.

## Profile settings and credentials

Register a Profile once from a dedicated controller's existing env file. That holder publishes
the executor, image, resources, pool and runner bounds, egress policy, GitHub registration URL,
runner group, labels and whether it publishes cache facts. Standbys read that contract from
Convex; they never register it or overwrite it. A Worker cannot take a Profile's lease until it
has advertised readiness for the same executor, image and resources. A Profile without a
registered GitHub URL reports `profileIncomplete` until a dedicated controller registers it.

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
or organization with the [permissions in Profile controllers](../controllers.md#github-permissions-the-controller-needs).
No key or App JWT is returned to a Worker.

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

[Install a Worker standby](../controllers.md#install-a-worker-standby) has the command, the env
file it reads, the cache flags a standby needs, and the files it installs. In short, from the
Worker's account:

```bash
curl -fsSL https://<deployment>.convex.site/install | sudo bash -s -- --role controller \
  --profile erainfra-4vcpu-ubuntu-2404 --no-prompt
```

Check the service and the dashboard's Profiles table:

```bash
systemctl status runner-center-controller@erainfra-4vcpu-ubuntu-2404
journalctl -u runner-center-controller@erainfra-4vcpu-ubuntu-2404 -n 50
```

While another controller holds the lease, the log says `controller standing by`, with the holder,
retry delay and network penalty. After a grant it says `acquired controller lease`, then
`runner scale-set controller started`. The tooltip shows the host, Worker credential, lease epoch
and session state. A 409 means it has the lease but is waiting for GitHub's previous session.

## Move a live Profile from a dedicated host to Workers

Do this per Profile. No command here retires the scale set. "The dedicated host" below is the host
whose controller holds the Profile's lease now.

1. Configure the controller App's client ID and key in Convex. Leave the dedicated host's credentials in place
   for rollback. Confirm the dedicated host holds the lease, has registered the GitHub URL and is
   listening. Check each Profile separately.
2. Install the standby on `<worker-host>` with its Worker env file, as above. Wait for its
   heartbeat to appear beside the dedicated host's. It must log `controller standing by` and
   identify the dedicated host as holder. If it says `notReady` or `profileIncomplete`, fix that
   before proceeding.
3. Stop the dedicated host's unit, without running `retire`:

   ```bash
   sudo systemctl disable --now runner-center-controller@<profile>
   ```

4. Watch `<worker-host>` acquire a higher epoch and start listening. A graceful stop closes the old
   GitHub session before releasing the lease. A crash can add GitHub's lingering-session delay.
   Confirm the dashboard shows `<worker-host>` listening with the Worker credential and submit a small
   workflow targeted at that Profile. Check its Attempt is created and reaches the Worker.
5. Install another ready Worker's standby when available. Keep the dedicated host's env and
   credentials in an encrypted backup until every Profile has taken over and survived a Worker
   restart.

Rollback before retiring the dedicated host: stop the Worker standby units for that Profile on
**every** Worker, then start the dedicated host's unit. Watch it acquire the lease and session. A
dedicated host has no priority over a Worker, so leaving a Worker holder running will leave the
dedicated host standing by.

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

`--update` finds the instances to move with
`systemctl list-units --state=active 'runner-center-controller@*'`, so it moves only controllers
running under that unit name. `--update` downloads and verifies the pinned binary. If the installed binary already matches, it
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

Before a maintenance window, prove that `--update` will find every controller on the host:

```bash
curl -fsSL https://<deployment>.convex.site/install | sudo bash -s -- --role controller --update --dry-run
```

It downloads and verifies the pinned binary as `--update` does, then changes nothing. It lists each
running `runner-center-controller@<profile>` instance it would restart, and fails, naming the
problem, when the binary is not at `/usr/local/lib/runner-center/runner-center-controller`, the
`runner-center-controller` account is missing, no instance is running, an instance runs from a unit
file other than `/etc/systemd/system/runner-center-controller@.service`, or an instance has no
`/etc/runner-center/profiles/<profile>.env`. It warns about drop-ins, which can override what the
release unit sets. A controller installed by hand may fail any of these.
[deploy-control-plane.md](deploy-control-plane.md#prove---update-will-find-the-controllers) has
the same checks as plain `systemctl` commands.

To roll back by hand:

```bash
sudo install -m 0755 /usr/local/lib/runner-center/runner-center-controller.bak-<version> \
  /usr/local/lib/runner-center/runner-center-controller
sudo cp -p /etc/systemd/system/runner-center-controller@.service.bak-<version> \
  /etc/systemd/system/runner-center-controller@.service
sudo systemctl daemon-reload
sudo systemctl restart 'runner-center-controller@<profile>'   # each instance that should run
```

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

**Leftover Runner registrations.** The controller deletes the Runner of every Attempt that ended
without running a job. Control planes deployed before that change did not: when a runner exited
without taking a job, as every runner of an image GitHub had deprecated did, its Attempt ended
`completed` and its registration stayed on GitHub, one per Attempt. GitHub removes an ephemeral
Runner that has been offline for more than a day, so those registrations clear on their own a day
after the cause is fixed. To remove them sooner, run this from a machine where `gh` is signed in
with admin rights on the registration scope. Runner names are `rc-<profile>-` followed by 12 hex
digits, with the Profile name lowercased and any character outside `a-z`, `0-9` and `-` turned
into `-`. List first, and delete only when the count is what you expect:

```bash
scope=repos/<owner>/<repo>   # the scope ERAINFRA_GITHUB_CONFIG_URL names; orgs/<org> for an organization
prefix=rc-<profile>-
gh api --paginate "$scope/actions/runners?per_page=100" --jq \
  ".runners[] | select(.status == \"offline\" and .busy == false and (.name | startswith(\"$prefix\"))) | .id" \
  > leftover-runners.txt
wc -l < leftover-runners.txt
while read -r id; do gh api -X DELETE "$scope/actions/runners/$id"; sleep 1; done < leftover-runners.txt
```

The one-second pause keeps 1,700 deletes at about 30 minutes, well inside the API's hourly limit.
An Attempt that is still booting also has an offline Runner. Deleting it ends that Attempt, and the
controller creates a replacement, so run this while the Profile is quiet if you can.

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
