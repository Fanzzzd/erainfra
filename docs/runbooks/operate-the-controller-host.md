# Runbook: operate the controller host

A Profile's controller is `runner-center-controller@<profile>`: one systemd unit per Profile,
holding GitHub's scale-set message session and turning demand into Attempts. It runs no jobs and
needs no KVM. Today it runs on a host that is not a Worker
([ADR 0013](../adr/0013-run-controllers-off-the-workers.md)); the installer also puts it on a
Worker host, which is where [ADR 0014](../adr/0014-controllers-run-on-the-workers-under-a-lease.md)
is taking it.

This runbook covers provisioning a host, updating it, adding and retiring Profiles, rotating
secrets, monitoring, backing up, and rebuilding the host from scratch.

What the installer puts on a host, and nothing else:

| Path                                                                  | Owner and mode                      | Holds                                                                           |
| --------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------- |
| `/usr/local/lib/runner-center/runner-center-controller`               | root, 0755                          | the binary `AGENT_RELEASE` pins                                                 |
| `/usr/local/lib/runner-center/runner-center-controller.bak-<version>` | root, 0755                          | the binary an `--update` replaced                                               |
| `/etc/systemd/system/runner-center-controller@.service`               | root, 0644                          | the unit from the release                                                       |
| `/etc/runner-center/profiles/<profile>.env`                           | root, 0600                          | the Profile's settings; secrets only as `*_FILE` paths                          |
| `/etc/runner-center/secrets/<profile>/`                               | root:runner-center-controller, 0750 | `controller-token`, `github-app.pem` or `github-token`, and `cache-signing-key` |
| the `runner-center-controller` account                                | system, no home, no login shell     | the identity the unit runs as                                                   |

systemd reads the env file as root; the controller reads each `*_FILE` itself as
`runner-center-controller`, which is why the secrets are group-readable by that account and by no
one else (0640).

## 1. Provision a host

Any always-on Linux host with systemd works: a small VM, or a Worker host. It needs outbound HTTPS
to `github.com`, `api.github.com`, GitHub's Actions service (`*.actions.githubusercontent.com`) and
the deployment's `https://<deployment>.convex.site`. It needs no inbound port.

The installer refuses until the deployment pins a controller release: `AGENT_RELEASE.controller` is
first filled at the release after v0.2.0-rc.10. On an older deployment, install by hand as the
README's "Run a Profile controller" describes.

Put each secret in a file first, readable by root only. Never paste a secret on a command line,
where it lands in shell history and in `ps`:

```bash
umask 077
mkdir -p ~/controller-secrets && cd ~/controller-secrets
read -rs CONTROLLER_TOKEN && printf '%s' "$CONTROLLER_TOKEN" > controller-token && unset CONTROLLER_TOKEN
cp /path/to/downloaded/app.private-key.pem github-app.pem
```

Then install the first Profile. Paths must be absolute:

```bash
curl -fsSL https://<deployment>.convex.site/install | sudo bash -s -- --role controller \
  --profile erainfra-4vcpu-ubuntu-2404 \
  --github-config-url https://github.com/OWNER/REPOSITORY \
  --executor firecracker \
  --image-release ghcr.io/OWNER/runner-center-ubuntu-24.04-js@sha256:<digest> \
  --vcpus 4 --memory-mib 16384 --max-runners 16 \
  --controller-token-file "$PWD/controller-token" \
  --github-app-client-id <client-id> --github-app-installation-id <installation-id> \
  --github-app-private-key-file "$PWD/github-app.pem"
```

An enterprise scale set takes `--github-token-file` instead of the three App flags. A Profile that
uses the job cache adds `--cache-facts-url` and `--cache-signing-key-file`
([operate the job cache](operate-the-job-cache.md)). The other settings flags are `--warm-pool`,
`--fit-policy`, `--min-runners`, `--scale-set-name`, `--labels` and `--runner-group`; `--help`
lists them all. Run from a terminal, the installer asks for anything required that is missing;
under automation, add `--no-prompt` so it fails with the list instead. It checks every value
before it writes anything.

The installer verifies the binary against the pinned SHA-256 and changes nothing on a mismatch. On
an air-gapped host, `--source file:///path/to/runner-center-controller-linux-x86_64` (or a mirror
URL) moves where the bytes come from; the pinned digest still decides.

On a Worker host, the installer creates `/usr/local/lib/runner-center` and `/etc/runner-center`
only if they are missing, never changes their modes, and does not touch `runner-center-runtime`,
the `runner-center` group, the Worker's account or `~/.runner-center`. The Firecracker host's
`--uninstall` removes only its own files from `/usr/local/lib/runner-center`, so it leaves the
controller in place.

Check the result:

```bash
systemctl status runner-center-controller@erainfra-4vcpu-ubuntu-2404
journalctl -u runner-center-controller@erainfra-4vcpu-ubuntu-2404 -n 50
```

The log says `runner scale-set controller started`, and within 30 seconds the dashboard's Profiles
table shows the Profile's Controller as **Online**, with this host and version. Delete
`~/controller-secrets` once the Profile is online; the installer keeps its own copies.

## 2. Update

The deployment's `AGENT_RELEASE` decides the version. After a control-plane deploy that moves it:

```bash
curl -fsSL https://<deployment>.convex.site/install | sudo bash -s -- --role controller --update
```

`--update` downloads and verifies the pinned binary. If the installed binary already matches, it
changes nothing. Otherwise it keeps the old binary as
`runner-center-controller.bak-<old version>`, installs the new binary and unit, and restarts exactly
the instances that were running. It never starts a stopped instance, so a retired Profile stays
retired. If any restarted instance is not running three seconds later, it puts the old binary and
unit back, restarts the same instances, and exits with an error.

Each restart closes the GitHub session and opens a new one. GitHub keeps queued jobs and offers
them to the next session, so a restart delays intake by seconds and loses nothing.

To roll back by hand:

```bash
sudo install -m 0755 /usr/local/lib/runner-center/runner-center-controller.bak-<version> \
  /usr/local/lib/runner-center/runner-center-controller
sudo systemctl restart 'runner-center-controller@<profile>'   # each instance that should run
```

The next `--update` moves it forward again.

## 3. Add, change or retire a Profile

**Add.** Rerun the install command with the new `--profile` and its settings. The binary and unit
are shared, so this only adds an env file, a secrets directory and an instance.

**Change a setting.** Rerun with `--profile <name> --reconfigure` and the complete set of flags.
Without `--reconfigure` the existing env file is kept, any settings given are ignored with a
warning, and the instance is restarted on the binary and unit. Rerunning with only `--profile` is
the repair command for one Profile.

**Retire.** Stopping the unit is not enough: GitHub keeps the scale set and routes
`runs-on: <profile>` jobs to it until it cancels them after 24 hours. Stop, then retire:

```bash
sudo systemctl disable --now runner-center-controller@<profile>
sudo sh -c 'set -a; . /etc/runner-center/profiles/<profile>.env; \
  exec /usr/local/lib/runner-center/runner-center-controller retire'        # report only
sudo sh -c 'set -a; . /etc/runner-center/profiles/<profile>.env; \
  exec /usr/local/lib/runner-center/runner-center-controller retire --yes'  # delete and pause
```

`retire --yes` deletes the scale set and pauses the Profile, so Workers stop prewarming it and the
controller-silent alert stops watching it. Keep the env file and secrets in the backup until you
are sure; then remove them:

```bash
sudo rm /etc/runner-center/profiles/<profile>.env
sudo rm -r /etc/runner-center/secrets/<profile>
```

## 4. Rotate secrets

### The controller token, without an outage

The control plane accepts two controller tokens at once, `CONTROLLER_TOKEN` and the optional
`CONTROLLER_TOKEN_NEXT`, and records which one each controller used. Set the variables in the
Convex dashboard (Settings, Environment Variables) or with `npx convex env set … --prod` from
`packages/backend`.

1. Generate the new token on a trusted machine: `openssl rand -hex 32`.
2. Set it as `CONTROLLER_TOKEN_NEXT`. Both tokens now work.
3. On every controller host, for every Profile, replace the token file and restart the instance:

   ```bash
   sudo install -m 0600 /dev/null /etc/runner-center/secrets/<profile>/controller-token.new
   sudo sh -c 'cat > /etc/runner-center/secrets/<profile>/controller-token.new'   # paste, then Ctrl-D
   sudo chgrp runner-center-controller /etc/runner-center/secrets/<profile>/controller-token.new
   sudo chmod 0640 /etc/runner-center/secrets/<profile>/controller-token.new
   sudo mv /etc/runner-center/secrets/<profile>/controller-token.new \
     /etc/runner-center/secrets/<profile>/controller-token
   sudo systemctl restart runner-center-controller@<profile>
   ```

4. Wait until every controller reports with the new token. Hover each Profile's Controller cell:
   every host must read `CONTROLLER_TOKEN_NEXT`. A controller you missed still reads
   `CONTROLLER_TOKEN`.
5. Set `CONTROLLER_TOKEN` to the new value, then remove `CONTROLLER_TOKEN_NEXT`. The hosts keep
   working, because the token they present is now the current one. A controller still on the old
   token starts getting 401 here, which is why step 4 comes first.

Then take a new backup (section 6): the old one holds the withdrawn token.

### The GitHub App private key

A GitHub App can have several private keys at once. Generate a new key on the App's settings page,
replace `/etc/runner-center/secrets/<profile>/github-app.pem` the way step 3 above replaces the
token, restart the instance, confirm the Profile is Online, then delete the old key on GitHub.
Every Profile that uses the same App needs the new file before the old key is deleted.

A personal access token (`github-token`) rotates the same way: create the new token, replace the
file, restart, confirm, then revoke the old token.

### The cache signing key

The controller signs cache facts with it and the cache service verifies them, so both sides change
together. Follow [operate the job cache](operate-the-job-cache.md) for the service side; on the
controller host replace `cache-signing-key` and restart. Jobs that start while the two disagree read
a cold cache; nothing fails.

## 5. Monitor

Every controller reports a heartbeat every 30 seconds and whenever its session changes. The
Profiles table's Controller column reads it:

| Shows                   | Means                                                                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Online**              | A controller reported within 90 seconds and holds the GitHub session. The line below says when GitHub last answered its long poll.           |
| **Waiting for session** | Controllers are reporting, but none holds the session: one is starting, or GitHub refused it because another session exists (see section 7). |
| **Offline**             | No report for 90 seconds, or the last report was a stop. The tooltip carries the stop reason when there was one.                             |
| **Not reporting**       | No controller has ever reported for this Profile, which is what a controller built before the heartbeat looks like. It is not alerted on.    |

Set up one alert rule under Settings, Alerts: **No controller listening**, 3 minutes, every
Profile. It fires when no controller has held an active Profile's session for that long, and
resolves when one does again. `/metrics` carries the same signal as
`erainfra_controller_up{profile}` and `erainfra_controller_last_heartbeat_age_seconds{profile}`,
both absent until the Profile's first heartbeat.

On the host:

```bash
systemctl list-units 'runner-center-controller@*'
journalctl -u 'runner-center-controller@*' --since '1 hour ago' | grep -E '"level":"(WARN|ERROR)"'
```

`could not report controller heartbeat` means the controller cannot reach the control plane; it
keeps serving jobs, but the dashboard will show it offline.

## 6. Back up

Back up what cannot be downloaded again: the env files and the secrets. The binary and unit come
back from the installer.

```bash
sudo tar -C /etc/runner-center -czf - profiles secrets |
  age -r <your age recipient> > controller-host-$(date +%F).tar.gz.age
```

Store the encrypted archive off the host, in your password manager or secrets vault. Never put it,
or any file under `/etc/runner-center/secrets`, in git, an issue, a chat or an unencrypted bucket:
it holds the GitHub App key that registers runners for every Profile it serves. Take a new backup
after adding a Profile, changing one with `--reconfigure`, or rotating a secret.

## 7. Two controllers for one Profile

GitHub gives a scale set one message session, so two controllers for one Profile never both take
jobs. The second one's session request gets `409 Conflict`. It logs
`another controller holds this scale set's message session; not listening, will retry`, reports
`conflict`, and retries after 10 seconds, doubling to at most 60. It takes over within about a
minute of the first controller closing its session.

You see this in three situations, and only the last needs action:

- **A restart after a crash.** A controller killed without closing its session (`kill -9`, power
  loss) leaves it on GitHub for a few minutes. The restarted controller waits it out.
- **A rebuild or a move to another host** (section 8), while the old host still runs. The new
  controller waits until the old one stops.
- **A forgotten controller.** If a Profile shows Waiting for session for longer than a few minutes,
  something else holds its session: a controller on another host, or one started by hand. The
  conflict message carries the session owner's name, `<hostname>:<profile>`. Stop that one.

## 8. Rebuild from scratch

When the host is lost or is being replaced:

1. Provision a new host (section 1's prerequisites).
2. Restore the backup into `/etc/runner-center`, owned by root rather than by whatever group ids
   the old host used, then create the controller account and give it the secrets:

   ```bash
   age -d -i <your age identity> controller-host-<date>.tar.gz.age |
     sudo tar --no-same-owner -C /etc/runner-center -xzf -
   sudo useradd --system --user-group --no-create-home --home-dir /nonexistent \
     --shell /usr/sbin/nologin runner-center-controller
   sudo chmod 0600 /etc/runner-center/profiles/*.env
   sudo chgrp -R runner-center-controller /etc/runner-center/secrets
   sudo chmod 0750 /etc/runner-center/secrets /etc/runner-center/secrets/*
   sudo chmod 0640 /etc/runner-center/secrets/*/*
   ```

3. For each Profile in the backup, run the installer with only `--profile <name> --no-prompt`. It
   finds the restored env file and keeps it, installs the pinned binary and the unit, and starts
   the instance.

4. Confirm each Profile is Online on the dashboard with the new host's name.

If the old host might still be running, stop its units first if you can reach it. If you cannot,
the new controllers wait in `conflict` until the old ones stop or their sessions expire, so there
is never a moment with two listeners. Without a backup, provision the host from scratch with a new
controller token (section 4) and the App's key, using the settings the dashboard shows for each
Profile.
