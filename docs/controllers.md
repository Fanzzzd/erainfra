# Profile controllers

A controller registers one Profile as a GitHub runner scale set, listens for its jobs and creates
one Attempt per job. This page covers installing and running controllers, pinning a Profile to some
Workers, retiring a Profile, and the GitHub permissions a controller needs. Day-to-day operation is
in [Runbook: operate Profile controllers](runbooks/operate-the-controller-host.md).

## Install a controller

Controllers run on Workers or a dedicated host and need no KVM. For each Profile, Convex leases
job intake to one process; the others stand by. The holder renews every 10 seconds, with a
30-second expiry. Every controller write carries its epoch, and HTTP 412 stops a stale holder's
listener immediately. Dedicated hosts using `CONTROLLER_TOKEN` or `CONTROLLER_TOKEN_NEXT` must
hold the lease too. A fresh network score below 40 delays a Worker candidate by 15 seconds after
the lease frees, giving better-connected Workers the first chance
([ADR 0014](adr/0014-controllers-run-on-the-workers-under-a-lease.md)).

A Worker standby uses its existing machine credential. It reads the Profile's contract from Convex
and gets a short-lived GitHub App installation token from Convex only while holding the lease.
It receives no App key or shared controller token. The job cache is the one setting it cannot read
from Convex, because the signing key stays off the control plane: if the Profile publishes cache
facts, give the standby `--cache-facts-url` and `--cache-signing-key-file` too. Convex refuses the
lease to a standby without them, and its heartbeat shows `incapable`. Install it beside an already
enrolled Worker:

```bash
curl -fsSL https://<deployment>.convex.site/install | sudo bash -s -- --role controller \
  --profile erainfra-4vcpu-ubuntu-2404 --no-prompt
```

The installer reads `<SUDO_USER home>/.runner-center/agent/.env`, or an explicit
`--worker-env-file /absolute/path/.env`, and copies only the machine token into a protected file.
Image, resource and GitHub settings do not belong in a standby's env file. Register the Profile
once from the upgraded dedicated controller before adding standbys. Configure
`CONTROLLER_GITHUB_APP_CLIENT_ID` and `CONTROLLER_GITHUB_APP_PRIVATE_KEY` in Convex, using the
controller App described below. A Profile without its GitHub URL registered remains in standby.
The [controller runbook](runbooks/operate-the-controller-host.md) covers moving controllers
from a dedicated host onto Workers, token setup, takeover checks and rollback. A backend with lease enforcement refuses
old controller binaries; stage the binary upgrade and backend deployment together.

A dedicated host keeps the existing local App or PAT path. `--controller-token-file` selects that
mode, even on a Worker host:

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

The installer downloads the controller binary that `AGENT_RELEASE` pins and refuses bytes whose
SHA-256 differs, the same trust root as the other roles
([ADR 0006](adr/0006-one-onboarding-path-with-a-pinned-trust-root.md)). It installs the binary
and `runner-center-controller@.service`, creates the unprivileged `runner-center-controller`
account, copies the secret files to `/etc/runner-center/secrets/<profile>/`, writes
`/etc/runner-center/profiles/<profile>.env` (mode 0600, secrets only as `*_FILE` paths), and starts
`runner-center-controller@<profile>`. It leaves a Worker install on the same host alone.
`--role controller --update` moves every running controller on the host to the pinned release and
keeps the previous binary as `runner-center-controller.bak-<version>`; with `--dry-run` it changes
nothing and lists the instances it would restart and anything that would stop it. The controller pin is first
filled at the release after v0.2.0-rc.10; until a deployment pins it, the installer refuses and the
manual steps below apply. Updating, adding and retiring Profiles, rotating secrets, monitoring, back
up and rebuild are in
[Runbook: operate the controller host](runbooks/operate-the-controller-host.md).

The installer's flags map one to one to the environment the controller reads. To run it by hand:

```bash
export ERAINFRA_CONVEX_URL=https://<deployment>.convex.site
export ERAINFRA_CONTROLLER_TOKEN_FILE=/etc/runner-center/controller-token
export ERAINFRA_GITHUB_CONFIG_URL=https://github.com/OWNER/REPOSITORY
export ERAINFRA_PROFILE=erainfra-4vcpu-ubuntu-2404
export ERAINFRA_EXECUTOR=docker # bootstrap trusted CI; promote to firecracker after host provisioning
export ERAINFRA_IMAGE_RELEASE=ghcr.io/OWNER/runner-center-ubuntu-24.04-js@sha256:<digest>
export ERAINFRA_VCPUS=4
export ERAINFRA_MEMORY_MIB=16384 # 4 vCPU and 16 GiB is GitHub's standard Linux runner; a Profile sized to it inherits the same RAM-derived kernel limits
export ERAINFRA_WARM_POOL=2 # Firecracker only; 0 disables resident warm capacity
export ERAINFRA_FIT_POLICY=balanced # balanced, cpu, network, or io
export ERAINFRA_MIN_RUNNERS=0
export ERAINFRA_MAX_RUNNERS=16

# Prefer a GitHub App. An enterprise URL needs ERAINFRA_GITHUB_TOKEN instead (see the permissions below).
export ERAINFRA_GITHUB_APP_CLIENT_ID=<client-id>
export ERAINFRA_GITHUB_APP_INSTALLATION_ID=<installation-id>
export ERAINFRA_GITHUB_APP_PRIVATE_KEY_FILE=/etc/runner-center/github-app.pem

runner-center-controller
```

Each of these is also read under its `RC_` name, which is what the installer writes into
`/etc/runner-center/profiles/<profile>.env` and what every running controller holds; see
[Environment variable names](architecture.md#setting-names).

Name a new Profile `erainfra-<N>vcpu-<os><version>[-arm]`, for example `erainfra-4vcpu-ubuntu-2404`
([ADR 0010](adr/0010-name-profiles-the-way-runner-vendors-name-labels.md)). The controller
refuses a name GitHub would misread (uppercase, longer than 45 characters, or a GitHub-hosted label
such as `ubuntu-latest`) and warns about a legal name outside the scheme. A Profile is renamed by
registering the new name beside the old one, never in place, because GitHub holds the scale-set
name.

## Pin a Profile to some Workers

To send jobs only to the Workers with a GPU, an NVMe pool or a particular site, put a host label on
those Workers and register a Profile pinned to it
([ADR 0017](adr/0017-pin-a-profile-to-workers-by-host-label.md)):

```bash
# On each such Worker: at install, or later with an admin token.
curl -fsSL https://<deployment>.convex.site/install | bash -s -- --token <registration-token> --labels gpu
erainfra workers set-labels worker-01 gpu nvme

# A controller for the pinned Profile: the same flags as any dedicated controller, plus the pin.
curl -fsSL https://<deployment>.convex.site/install | sudo bash -s -- --role controller \
  --profile erainfra-4vcpu-ubuntu-2404-gpu --worker-labels gpu ...
```

```yaml
runs-on: erainfra-4vcpu-ubuntu-2404-gpu
```

Only a Worker carrying every label in `ERAINFRA_WORKER_LABELS` (or `RC_WORKER_LABELS`; the
installer's `--worker-labels`) sees the Profile, prepares its image, reports readiness for it and
is scheduled onto for it. The `/runs-on` router, the Profile list, `/metrics` and the alerts count
the same Workers. Removing a label stops new jobs of the pinned Profile from going to that Worker.
Its idle Runners of that Profile (starting, or online and waiting for a job) are retired, and the
controller creates replacements on Workers that carry the label. The controller deletes a retired
Runner's GitHub registration first, so GitHub cannot hand it a job. Its Attempt is cancelled and its
executor stopped only after GitHub confirms the delete, usually within a minute. GitHub may already
have handed the Runner a job before the controller heard about it. Then it refuses the delete, and
the job runs to the end where it is. `erainfra jobs view` shows a retiring Attempt under
`Retiring`. Attempts placed on the Worker but not yet started go back to the queue. Running jobs
finish. Adding a pin to a Profile that already has
Runners does the same on every Worker without the labels. `erainfra workers set-labels` prints how
many Runners and Attempts it moved. `erainfra profiles list` shows the pin under `PINNED TO` and
`erainfra workers list` shows each Worker's `LABELS`. A Worker names its labels once, at
registration, under the same rules an admin's labels follow: lowercased, and a registration with a
label outside them is refused before its token is spent. After that only an admin token changes
them, because a label decides which jobs a machine may run. Labels are lowercase letters, digits,
`.`, `_` and `-`, up to 16 of them.

actuated's form, `runs-on: [actuated-2cpu-8gb, r2]`, has no equivalent here. GitHub hands a job to
any idle Runner of the scale set it matched, and a Runner is created before the job it will run is
known, so a label cannot choose a Worker inside one Profile. A second scale set that also answers
to `erainfra-4vcpu-ubuntu-2404` would take plain jobs as well, so the control plane refuses (HTTP 409) a registration that makes a Profile's `ERAINFRA_LABELS` include another active Profile's
name, or another Profile's include this one's. A pair that already overlapped before the control
plane refused them keeps registering, so a controller restart does not take both Profiles down.
Such a pair shows as a warning in `erainfra profiles list` and on the dashboard's Profiles table,
in `erainfra_profile_label_conflicts`, and in the _Profiles' scale-set labels overlap_ alert, until
an operator removes the other Profile's name from one side's labels. To list the pairs on a
deployment, including one running an older backend:

```bash
cd packages/backend
npx convex data profiles --prod --limit 10000 --format jsonl > profiles.jsonl &&
  pnpm --silent profile-label-conflicts "$PWD/profiles.jsonl"
```

It exits 1 when there is a conflicting pair, 2 when the export is empty or unreadable, and 3 when
some active Profiles carry no labels in the export (a backend before v0.2.0-rc.11 stores none),
which it names so you can read their `RC_LABELS` on the controller hosts. The pinned Profile also does not keep an unpinned one
off the labelled Workers: they share their slots. To reserve the Workers, pin the other Profile to
a label only the other Workers carry.

A dedicated controller publishes its env contract when it first acquires the lease after startup.
Worker standbys never overwrite it. Existing deployments can keep the dedicated host while adding
standbys, then stop its units once Worker takeover is verified. Enterprise runner registrations
still require a dedicated host with `ERAINFRA_GITHUB_TOKEN` (or `RC_GITHUB_TOKEN`), because GitHub Apps cannot register
enterprise runners.

Stopping a controller does not remove its scale set. GitHub keeps routing `runs-on: <profile>` jobs
to it, and with no listener they wait until GitHub cancels them after 24 hours. Stop its units on
all controller hosts, including Worker standbys, then retire from the dedicated host's saved env:

```bash
profile=<profile>   # the Profile to retire
sudo systemctl disable --now "runner-center-controller@$profile"
sudo sh -c "set -a; . /etc/runner-center/profiles/$profile.env; \
  exec /usr/local/lib/runner-center/runner-center-controller retire"        # report only
sudo sh -c "set -a; . /etc/runner-center/profiles/$profile.env; \
  exec /usr/local/lib/runner-center/runner-center-controller retire --yes"  # delete and pause
```

`retire --yes` acquires the lease, checks GitHub's activity statistics, pauses the Profile and
deletes the scale set while renewing its lease. Pausing first prevents a standby from recreating
the scale set. It refuses while another controller holds the lease, when GitHub supplies no
activity statistics, or while GitHub counts busy runners or assigned/running jobs. A dry run reports
missing statistics as unknown. `--force` overrides the statistics and busy checks, never the lease.
Starting a dedicated unit intentionally reactivates the Profile; starting a Worker standby does not.

Only the lease holder opens a GitHub message session. GitHub independently refuses a second session
with `409 Conflict`. A new holder whose predecessor died without closing its session retries with
10-to-60-second backoff. GitHub can retain an abandoned session for minutes, so lease expiry does
not promise listening resumes within 30 seconds.

Every controller reports a heartbeat to the control plane every 30 seconds and whenever its
session changes. The Profiles table shows it, and `/metrics` and the alerts read it; see
[Monitor the fleet](monitoring.md).

`ERAINFRA_WARM_POOL` (or `RC_WARM_POOL`) is an explicit Firecracker-only performance opt-in. Its target
counts both parked and currently claimed single-use microVMs, and each one
reserves a Worker slot, vCPUs, memory, a CNI address, and devmapper headroom.
Start small and validate it on one KVM Worker using
[ADR 0003](adr/0003-warm-microvm-capacity.md); Docker, Tart, and Hyper-V
Profiles must leave it at zero.

## GitHub permissions the controller needs

Registering the scale set takes one GitHub REST call that needs a permission: the controller
creates a runner registration token at the scope `ERAINFRA_GITHUB_CONFIG_URL` names. The scale-set client
exchanges that token for an Actions service session, and every later scale-set operation goes
through that session, not the REST API: creating or updating the scale set, issuing JIT
configurations, removing runners, and polling for jobs. Minting a GitHub App installation token is
signed with the App's own key and needs no permission.

| `ERAINFRA_GITHUB_CONFIG_URL`                | GitHub App                                        | Personal access token                                                          |
| ------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------ |
| `https://github.com/OWNER/REPOSITORY`       | Repository: Administration, read and write        | fine-grained: the same; classic: `repo`                                        |
| `https://github.com/ORGANIZATION`           | Organization: Self-hosted runners, read and write | fine-grained: the same; classic: `admin:org`                                   |
| `https://github.com/enterprises/ENTERPRISE` | not possible; the controller refuses it at start  | classic only, with `manage_runners:enterprise`, set as `ERAINFRA_GITHUB_TOKEN` |

An organization scale set needs no Administration permission. GitHub gives every App with a
repository permission read-only Metadata. A GitHub Enterprise Server host follows the same path
rules, so `https://ghes.example/ORGANIZATION` is an organization scope.

A controller that pushes cache facts (`ERAINFRA_CACHE_FACTS_URL` set) also reads three repository
endpoints at `JobStarted` for [the job cache](job-cache.md), with the same credentials. An
organization or enterprise scale set needs these on every repository whose jobs it serves.

| endpoint                                          | why                                                    | GitHub App permission      |
| ------------------------------------------------- | ------------------------------------------------------ | -------------------------- |
| `GET /repos/{owner}/{repo}/actions/runs/{run_id}` | the job's head branch, event, pull requests and fork   | Repository: Actions, read  |
| `GET /repos/{owner}/{repo}`                       | the default branch                                     | Repository: Metadata, read |
| `GET /repos/{owner}/{repo}/git/ref/{ref}`         | whether a reusable workflow's ref is a tag or a branch | Repository: Contents, read |

A fine-grained token needs the same three; a classic token needs `repo` for private repositories.
Without Actions read, every job's lookup fails and reads a cold cache. Without Contents read, jobs
inside reusable workflows on branch and tag events do. The controller logs
`could not establish the job's cache scope; publishing read-only facts` with GitHub's status code in
either case.

Stranded job recovery ([docs/workflows.md](workflows.md#when-a-worker-drops-after-routing)) runs
in the control plane, not the controller, with the same App. When the deployment sets
`ERAINFRA_STRANDED_JOB_ACTION` to `cancel` or `rerun`, it calls
`POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel`, `GET` on the run, and
`POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun`. Those need Repository: Actions, Read and
write. Grant it on the App's settings page. The dashboard's App manifest describes a different App
and still asks for Actions read only.

Sources, per endpoint: GitHub's
[permissions required for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)
and
[for fine-grained personal access tokens](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)
(`POST /repos/{owner}/{repo}/actions/runners/registration-token` under Administration,
`POST /orgs/{org}/actions/runners/registration-token` under Self-hosted runners,
`GET /repos/{owner}/{repo}/actions/runs/{run_id}` under Actions,
`GET /repos/{owner}/{repo}` under Metadata, `GET /repos/{owner}/{repo}/git/ref/{ref}` under
Contents);
[the enterprise registration-token endpoint](https://docs.github.com/en/enterprise-cloud@latest/rest/actions/self-hosted-runners#create-a-registration-token-for-an-enterprise)
for `manage_runners:enterprise`; and
[ARC's authentication guide](https://docs.github.com/en/actions/tutorials/use-actions-runner-controller/authenticate-to-the-api),
which uses the same scale-set protocol, for Metadata and for "You cannot authenticate using a
GitHub App for runners at the enterprise level."

The controller App stays separate from the App the dashboard's GitHub App setup creates. Set its
client ID and private key in Convex as `CONTROLLER_GITHUB_APP_CLIENT_ID` and
`CONTROLLER_GITHUB_APP_PRIVATE_KEY` for Worker holders. Dedicated hosts can keep their existing
`RC_GITHUB_APP_*` or `RC_GITHUB_TOKEN` credentials (`ERAINFRA_GITHUB_APP_*` and `ERAINFRA_GITHUB_TOKEN`
are the same settings). Reusing the webhook App would widen its manifest
to organization runner management and Contents read, which its own work does not need.

Convex looks up the controller App's installation for the registered URL and requests only the
permissions above. Repository tokens name only that repository; organization tokens stay within
that installation. Cache-facts read permissions require both the registered Profile setting and
the holder's request. A Worker cannot ask for a different URL or a broader repository set. Tokens
refresh five minutes before expiry. The adapter in `githubscale/token.go` changes the registration
request's bearer without rebuilding the Actions client or dropping its message session; refresh
failure never extends an expired credential. The App key never leaves Convex.

The dashboard App serves the legacy `workflow_job` webhook path. Its manifest
(`packages/backend/convex/githubAppConfig.ts`) asks for Repository: Administration, read and write,
for `POST /repos/{owner}/{repo}/actions/runners/generate-jitconfig`
and `DELETE /repos/{owner}/{repo}/actions/runners/{runner_id}`, and Repository: Actions, read-only,
which GitHub requires before it delivers `workflow_job` events. Its delivery recovery calls
`/app/hook/deliveries`, which takes the App's JWT and no installation permission.

Without the installer, use a process supervisor such as systemd with `Restart=always`, a private
`EnvironmentFile`, and a dedicated unprivileged service account. Controller releases are static Linux/macOS x64/ARM64
binaries with SHA-256 sidecars and provenance attestations. They can safely run on a small cloud
VM; execution Workers cannot if the VM has no `/dev/kvm`.

The release includes `runner-center-controller@.service`. Install the binary and unit in root-owned
paths, create the unprivileged `runner-center-controller` account, and put one mode-`0600` file per
Profile at `/etc/runner-center/profiles/<profile>.env`; enabling
`runner-center-controller@erainfra-4vcpu-ubuntu-2404` then keeps that Profile's listener online
independently of any Worker.
