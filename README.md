# Runner Center

Runner Center is an open-source control plane on Convex for ephemeral self-hosted GitHub Actions runners on your own machines. Linux and macOS are supported today; Windows exists only as an [unvalidated, preview-gated path](#windows-preview-not-supported). Machines need no public IP or inbound firewall rule: the agent connects out over WebSocket. Every job gets a clean Docker container or Tart VM, and workflows can use Runner Center as a drop-in `runs-on` target with an optional GitHub-hosted fallback when the fleet is busy.

## Architecture

```text
GitHub Actions
      |
      | signed workflow_job webhook
      v
POST /github/webhook
      |
      v
+--------------------------- Convex ----------------------------+
| jobs table -> scheduler -> GitHub generate-jitconfig API      |
|                                |                              |
|                         one-job JIT config                     |
+--------------------------------+------------------------------+
                                 |
                                 | outbound WebSocket subscription
                                 v
                    Runner Center agent
                                 |
                                 v
                  Linux Docker / macOS Tart
                                 |
                                 v
                     ephemeral GitHub runner
                                 |
                                 +---- one job, then destroyed
```

GitHub credentials and scheduling state stay in Convex. A machine receives only commands assigned to its machine token.

## 5-minute quickstart

### Prerequisites

- Node.js 22 or newer and pnpm 11
- A Convex account and authenticated Convex CLI
- Permission to create and install a private GitHub App owned by the target user or organization
- Docker on Linux runner machines, or Tart and `sshpass` on macOS runner machines

Clone the project, install dependencies, and build the agent:

```bash
git clone https://github.com/Fanzzzd/runner-center.git
cd runner-center
pnpm install
pnpm build
```

Create or select a Convex deployment, then initialize Convex Auth:

```bash
pnpm convex dev --once
(cd packages/backend && npx @convex-dev/auth)
```

Set the bootstrap secret **before** you deploy. It is what stops a stranger who finds your deployment URL from creating the dashboard's only admin account, so generate it with a real random source and treat it like a root password:

```bash
pnpm convex env set BOOTSTRAP_SECRET "$(openssl rand -hex 32)"
```

Print it once when you need it (`pnpm convex env get BOOTSTRAP_SECRET`); it never appears in the dashboard.

Deploy the Convex backend and hosted dashboard:

```bash
pnpm deploy
```

Open `https://<deployment>.convex.site`, choose **Create the first admin**, and paste the bootstrap secret along with the email and password you want to sign in with. Sign-up is closed from that moment: the secret only works while the instance has no accounts, and every later account needs an invitation from someone already signed in.

Until `BOOTSTRAP_SECRET` is set, no account can be created at all — the deployment fails closed rather than falling back to open sign-up.

### Add another operator

Sign in, open **Invite another operator** on the Machines page, and send the generated invitation over a channel you trust. It is single-use, expires in ten minutes, and is shown only once. The recipient enters it on the sign-in page under **Accept an invitation**.

### Allow the repositories

Name the repositories that may put work on your machines **before** connecting the App. Runner Center fails closed: until `ALLOWED_REPOS` is set, every incoming `workflow_job` is rejected and no job is created — so an App installed ahead of this step delivers jobs that are all dropped, with nothing queued to show for it.

```bash
pnpm convex env set ALLOWED_REPOS 'acme/app,acme/tools'
```

| Value      | Meaning                                            |
| ---------- | -------------------------------------------------- |
| `acme/app` | That one repository. Matching is case-insensitive. |
| `acme/*`   | Every repository owned by `acme`.                  |
| `*`        | Every repository the App is installed on.          |

A **public** repository additionally needs an explicit opt-in, because a fork of a public repository can run attacker-controlled code on your runner hosts by opening a pull request — this is why GitHub recommends self-hosted runners only for private repositories. Being listed in `ALLOWED_REPOS` is not enough on its own:

```bash
pnpm convex env set ALLOW_PUBLIC_REPOS true
```

Only set this if you understand and accept that risk, and prefer naming the individual public repositories rather than using a wildcard.

### Connect GitHub

The dashboard shows a **Connect GitHub** card until GitHub credentials exist. Enter an organization login to own the app there, or leave the field empty to create it under your personal account, then choose **Create GitHub App**. Runner Center uses the [GitHub App Manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest): GitHub shows you a preconfigured app to confirm, then hands the App ID, client ID, private key, and webhook secret straight back to your deployment. There is no app form to fill in and no environment variable to copy.

The generated app is private to that account and requests only what Runner Center uses:

| Setting                | Value                                             |
| ---------------------- | ------------------------------------------------- |
| Webhook URL            | `https://<deployment>.convex.site/github/webhook` |
| Repository permissions | `administration: write`, `actions: read`          |
| Events                 | Workflow jobs                                     |

`administration: write` is what creating and deleting a JIT runner requires (`POST`/`DELETE /repos/{owner}/{repo}/actions/runners/…`); `actions: read` is what delivers `workflow_job` webhooks. Nothing else is requested.

Because Convex environment variables are read-only at runtime, the callback cannot write to `convex env`. The credentials are stored in the `githubApp` table instead, reachable only from internal functions.

**Disconnect** on the same card forgets those credentials, and asks you to confirm first because it does less than it sounds like and more damage than it sounds like: the App and its installations stay on GitHub and keep delivering webhooks, but this deployment can no longer verify them, so App-authenticated jobs stop arriving. GitHub will not hand the private key out again either — reconnecting registers a second App. To stop the deliveries themselves, uninstall or delete the App on GitHub.

After the app is created, use **Install on repositories** to install it for all repositories or only the ones Runner Center should serve. The installation ID needs no configuration; GitHub includes it in each App webhook payload. The webhook is at the site root, with no `/api` prefix.

### Credential precedence

| Order | Source                                     | Notes                                                                             |
| ----- | ------------------------------------------ | --------------------------------------------------------------------------------- |
| 1     | `githubApp` table                          | Created by **Create GitHub App**. Outranks everything below.                      |
| 2     | `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` | Hand-registered app, for setups that prefer environment variables.                |
| 3     | `GITHUB_PAT`                               | Legacy fallback, used only for jobs whose payload carries no App installation ID. |

The dashboard keeps offering **Create GitHub App** while a PAT or a hand-registered app is in use, so an existing deployment can migrate without editing environment variables first. Webhook deliveries are verified against the stored app secret _and_ `GITHUB_WEBHOOK_SECRET`, accepting either, so App and repository webhooks both keep verifying while you cut over — which also means the old secret keeps being trusted until you remove it, so finish the cut-over with [Migrating off the legacy path](#migrating-off-the-legacy-path). A job that arrived with an App installation ID always uses App authentication and never silently falls back to the PAT.

### Manual GitHub App registration

Registering the app by hand still works. Choose a random webhook secret, then create a GitHub App from the settings for the target user or organization, keeping it private to that account:

- **Homepage URL:** `https://<deployment>.convex.site` is sufficient
- **Webhook:** active
- **Webhook URL:** `https://<deployment>.convex.site/github/webhook`
- **Webhook secret:** the random value you chose for `GITHUB_WEBHOOK_SECRET`
- **Repository permissions:** **Administration: Read and write** and **Actions: Read-only**
- **Subscribe to events:** **Workflow jobs** only

After creating the app, note its **App ID** and generate and download a private key PEM. Store the webhook secret, App ID, and PEM in the Convex deployment:

```bash
pnpm convex env set GITHUB_WEBHOOK_SECRET '<random-webhook-secret>'
pnpm convex env set GITHUB_APP_ID '<github-app-id>'
pnpm convex env set GITHUB_APP_PRIVATE_KEY "$(cat /path/to/private-key.pem)"
```

The private key can be stored as a multiline PEM or with escaped `\n` newline sequences.

### Legacy PAT and repository webhook fallback

Existing setups can keep a classic PAT and one webhook per repository. This path is used only for repository webhook jobs whose payload has no GitHub App installation ID:

```bash
pnpm convex env set GITHUB_PAT '<classic-github-pat-with-repo-scope>'
```

The PAT needs `repo` scope and administrator access to each target repository. In each repository, add an active `application/json` webhook at `https://<deployment>.convex.site/github/webhook`, use the same `GITHUB_WEBHOOK_SECRET`, and subscribe only to **Workflow jobs**.

This path cannot recover deliveries that never arrive — see [Recovering lost deliveries](#recovering-lost-deliveries). A webhook GitHub fails to deliver on this path is lost, and the job it carried waits out GitHub's 24-hour queue timeout.

#### Migrating off the legacy path

Work through these in order. Disabling the old webhooks before removing anything avoids overlapping deliveries after assignment has begun:

1. Connect the App from the dashboard and install it on the target repositories. Recovery of deliveries GitHub failed to make starts working from this point on.
2. Confirm a workflow job is delivered and assigned through the App.
3. Disable or delete the per-repository webhooks.
4. Wait for jobs already received through them to finish.
5. Remove both legacy secrets:

```bash
pnpm convex env remove GITHUB_PAT
pnpm convex env remove GITHUB_WEBHOOK_SECRET
```

Step 5 is not optional. Until `GITHUB_WEBHOOK_SECRET` is removed it stays an accepted signing key for `/github/webhook`, so anyone still holding the old secret — including whoever configured the retired repository webhooks — can keep submitting deliveries the verifier trusts. Removing it leaves the App's own secret as the only one that verifies. If a hand-registered app is also being retired, drop `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` in the same step.

### Add a machine

In the dashboard, go to **Machines → Add machine** and copy the generated command. Run it on the macOS or Linux host you want to register:

```bash
curl -fsSL https://<deployment>.convex.site/install | bash -s -- --token rcreg_xxx
```

The single-use registration token expires after 15 minutes. The installer detects the OS, architecture, CPU count, and hostname; installs Node.js 22 under `~/.runner-center` when needed; downloads the agent release your deployment pins and verifies its SHA-256 before installing it; registers the machine; installs the `rc` CLI; and starts a launchd or systemd user service. On Linux hosts without a working user systemd session, it uses `nohup` plus an `@reboot` crontab entry.

The agent is never fetched from a branch. Every machine installs the same immutable `runner-center-agent-<version>.tar.gz` release asset, installs its dependencies with `npm ci` from the lockfile inside that asset, and keeps the replaced installation at `~/.runner-center/agent.previous` so a bad release can be undone. See [Releases and versioning](#releases-and-versioning).

The dashboard waits for the registration and shows the new machine name as soon as it appears. Expand **Advanced options** before copying if you need to append any of these flags:

```bash
--name build-linux-01 --labels gpu,docker --slots 2
```

Install the OS provisioner prerequisites described below before assigning jobs to the machine.

### Agent CLI

The installer adds `~/.runner-center/bin` to your shell `PATH`. Open a new shell, or source the shell file named by the installer, then use:

| Command                      | Description                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `rc status`                  | Show the machine name, the installed agent version, whether the process is running, and the latest log line.             |
| `rc logs`                    | Show the latest 100 agent log lines.                                                                                     |
| `rc logs -f`                 | Follow the agent log.                                                                                                    |
| `rc restart`                 | Restart the installed launchd, systemd, or fallback service.                                                             |
| `rc stop`                    | Stop the agent service.                                                                                                  |
| `rc update`                  | Install the agent release this deployment pins and restart, without registering again.                                   |
| `rc update --version v1.2.3` | Install that exact release instead, for pinning one machine or rolling it back.                                          |
| `rc uninstall`               | Stop the service, remove local Runner Center files and the `PATH` entry, and remind you to delete the dashboard machine. |

The machine reports online after its first heartbeat.

## Using it in workflows

Use a catalog label in `runs-on` to select the execution environment. Runner Center uses the first catalog label in the job's label array, matches its OS to a machine, and treats any remaining labels as machine capability requirements. `self-hosted` is matched automatically and should remain in the workflow. Machines do not need to register image catalog labels.

| Label          | OS    | Image                                                    | Notes                                                                                                                                                   |
| -------------- | ----- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ubuntu-22.04` | Linux | `ghcr.io/actions/actions-runner:2.336.0`                 | Compatibility label. The current pinned image reports `ImageOS=ubuntu24`; it is a minimal runner image, not the GitHub-hosted Ubuntu 22.04 toolchain.   |
| `ubuntu-24.04` | Linux | `ghcr.io/actions/actions-runner:2.336.0`                 | Minimal Ubuntu 24.04-based runner image. Install project dependencies in workflow steps.                                                                |
| `rc-linux`     | Linux | `ghcr.io/actions/actions-runner:2.336.0`                 | Alias for the default Linux image.                                                                                                                      |
| `macos-15`     | macOS | `ghcr.io/cirruslabs/macos-sequoia-base@sha256:fdd8b72a…` | Tart base image for macOS Sequoia, pinned to the digest jobs were verified on.                                                                          |
| `macos-26`     | macOS | `ghcr.io/cirruslabs/macos-tahoe-base:latest`             | **Preview.** Requires the `rc-preview` machine label. No Tahoe image has been pulled, booted or run a job on, so the tag is left floating and unpinned. |
| `rc-mac`       | macOS | `ghcr.io/cirruslabs/macos-sequoia-base@sha256:fdd8b72a…` | Alias for the default macOS image.                                                                                                                      |

The macOS entries are pinned by **digest**, not by `:latest`. When that pin was
introduced, `ghcr.io/cirruslabs/macos-sequoia-base:latest` had already advanced
past the digest the end-to-end runs were executed against, so a machine
re-pulling the tag would have swapped the guest OS silently. Refreshing it is a
deliberate act: pull the new digest, run a job against it end to end, then move
`MACOS_SEQUOIA_IMAGE` in `packages/backend/convex/catalog.ts` and
`RC_DEFAULT_IMAGE` in `apps/agent/provisioners/provision-mac.sh` together. Tart
accepts an `@sha256:` reference for both `clone` and `pull`.

The Linux catalog intentionally uses GitHub's minimal runner image because the larger `catthehacker/ubuntu:act-*` images provide an Actions-like toolchain but do not contain the runner binary required by the provisioner. Bring language runtimes and other dependencies through setup actions or workflow steps.

```yaml
jobs:
  build:
    runs-on: [self-hosted, ubuntu-22.04]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm test
```

Additional labels still select machine capabilities. For example, `[self-hosted, ubuntu-24.04, gpu]` requires a Linux machine registered with `gpu`; the machine does not need `ubuntu-24.04` in its labels. If a job has no catalog label, Runner Center uses the default image for the selected machine OS (`rc-linux` or `rc-mac`).

For best-effort fallback, use a small GitHub-hosted routing job. `GET /runs-on` applies the same catalog and capability matching as the scheduler and accounts for jobs already waiting in the queue, then returns either the requested self-hosted label array or a GitHub-hosted fallback runner string. The `fallback` parameter is optional: it defaults to the requested image label when GitHub hosts it (`ubuntu-22.04`, `macos-15`, …), otherwise `ubuntu-latest`/`macos-latest` by OS. The dashboard's Machines page has this snippet ready to copy with your deployment URL filled in:

```yaml
name: linux-ci
on: [push, workflow_dispatch]

jobs:
  route:
    runs-on: ubuntu-latest
    outputs:
      runs-on: ${{ steps.pick.outputs.runs-on }}
    steps:
      - id: pick
        run: |
          echo "runs-on=$(curl -sf --max-time 10 \
            'https://<deployment>.convex.site/runs-on?labels=ubuntu-22.04&fallback=ubuntu-latest' \
            | jq -c '."runs-on"' || echo '"ubuntu-latest"')" >> "$GITHUB_OUTPUT"

  build:
    needs: route
    runs-on: ${{ fromJSON(needs.route.outputs.runs-on) }}
    steps:
      - uses: actions/checkout@v4
      - run: |
          echo "hello from runner: $(uname -a)"
          whoami
          date
```

The capacity probe is intentionally unauthenticated and exposes only whether matching capacity is currently available. It does not reserve a slot, so the result is a point-in-time routing signal.

## Provisioners

### Linux: Docker

Each job runs in a new container that is removed on exit. The host needs Docker access; no Docker socket or host workspace is mounted into the runner container.

Catalog-backed commands pass their selected image to the provisioner as `IMAGE`. The provisioner resolves Linux images in this order: `IMAGE`, then `RUNNER_IMAGE`, then `ghcr.io/actions/actions-runner:2.336.0`. `RUNNER_IMAGE` remains a fallback for commands created by an older backend without an image field:

```bash
export RUNNER_IMAGE='ghcr.io/actions/actions-runner:2.336.0'
```

The runner tag is pinned instead of using `latest` so runner updates are deliberate and deployments are reproducible. GitHub deprecates old runner versions, so update and verify this pin regularly rather than leaving it unchanged indefinitely.

The JIT configuration is read from stdin and forwarded with `docker run --env ACTIONS_RUNNER_INPUT_JITCONFIG`, which passes the value from the provisioner's own environment rather than writing it into the docker client's argv where every local user could read it.

`RC_JOB_TIMEOUT_S` (default `21600`, `JOB_TIMEOUT_S` accepted as a fallback) bounds the run: on expiry the container is stopped and the provisioner exits `124`. The container is also removed explicitly on any signal, because `docker run --rm` only cleans up when the client itself observes the exit.

### macOS: Tart

Each job clones a base image into a temporary Tart VM, boots it without graphics, installs a pinned GitHub Actions runner, runs the JIT runner over SSH, and deletes the VM when the runner exits — on success, failure, timeout or signal.

```bash
brew install cirruslabs/cli/tart
brew install cirruslabs/cli/sshpass
```

Catalog-backed commands pass their selected image as `IMAGE`. The provisioner resolves macOS images in this order: `IMAGE`, then `BASE_IMAGE`, then the pinned Sequoia digest in `RC_DEFAULT_IMAGE`, which tracks the `macos-15`/`rc-mac` catalog entries. `BASE_IMAGE` remains a fallback when a command has no image field, and pinning it by digest is worth the extra characters for the same reason the catalog does:

```bash
export BASE_IMAGE='ghcr.io/cirruslabs/macos-sequoia-xcode:16.4'
```

Only Sequoia is production-eligible. `macos-26` (Tahoe) is preview-gated exactly like the Windows labels: no Tahoe image has ever been pulled, booted, or given a job here, so `selectImageForMachine` refuses it unless the machine carries `rc-preview`. Nothing about the provisioner is Sequoia-specific and Tahoe is expected to work, but "expected to work" is not the same claim as `macos-15`, which was verified end to end. Its tag is left floating and unpinned for the same reason: there is no verified digest to pin it to.

Custom images must support the provisioner's `admin` SSH login. They do **not** need a runner preinstalled: the provisioner downloads a pinned `actions/runner` osx-arm64 release once per host, verifies its SHA-256 against the checksum GitHub publishes in the release, caches it under `~/.runner-center/cache`, and installs it into each VM. The digest is verified again inside the guest before it is unpacked. The `cirruslabs/macos-*-base` images do ship a runner under `~/actions-runner`, but its version is whatever was current when that mutable `:latest` tag was last built, so the provisioner ignores it and installs the pin instead.

Under Apple's macOS Software License Agreement, configure no more than two concurrent macOS VM slots on one Apple-branded host. The provisioner warns when it sees more Tart VMs running than `RC_MAC_MAX_CONCURRENT_VMS` (default 2).

Behaviour is tunable through the environment:

| Variable                    | Default                   | Purpose                                               |
| --------------------------- | ------------------------- | ----------------------------------------------------- |
| `RC_MAC_RUNNER_VERSION`     | pinned in the provisioner | `actions/runner` release to install.                  |
| `RC_MAC_RUNNER_SHA256`      | pinned in the provisioner | Expected SHA-256 of that release's osx-arm64 tarball. |
| `RC_MAC_GUEST_USER`         | `admin`                   | Guest account used for SSH.                           |
| `RC_MAC_GUEST_PASSWORD`     | `admin`                   | Guest password, read from a mode-600 file.            |
| `RC_BOOT_TIMEOUT_S`         | `300`                     | Budget for the guest to boot and accept SSH.          |
| `RC_JOB_TIMEOUT_S`          | `21600`                   | Overall job budget; exceeding it exits `124`.         |
| `RC_MAC_ATTEST_TIMEOUT_S`   | `60`                      | Budget for host key attestation over the guest agent. |
| `RC_MAC_MAX_CONCURRENT_VMS` | `2`                       | Licensing guard rail for the warning above.           |

`RC_BOOT_TIMEOUT_S` and `RC_JOB_TIMEOUT_S` are shared by every provisioner and are always in seconds, so `agentApi:report` can tell a timeout (`124`) from an ordinary runner failure regardless of OS. The older per-OS spellings `RC_MAC_BOOT_TIMEOUT_S`, `RC_MAC_JOB_TIMEOUT_S`, `BOOT_TIMEOUT_S` and `JOB_TIMEOUT_S` are still accepted as compatibility fallbacks.

**Exit code fidelity:** upstream's `run-helper.sh` maps most runner failures to exit `0` (`Runner listener exit with terminated error, stop the service, no retry needed.`), so a provisioner exit of `0` means "the runner process ended", not "the job succeeded". Job outcomes come from the `workflow_job` webhook, not from this exit code. The provisioner sets `ACTIONS_RUNNER_RETURN_VERSION_DEPRECATED_EXIT_CODE=1` so at least a runner GitHub has deprecated surfaces as exit `7` instead of disappearing into `0`.

#### Secret handling

The JIT configuration never appears in a command line or an environment block on the host: the agent pipes it into the provisioner's stdin, and the provisioner stages it in a mode-600 file inside a mode-700 directory that is removed when the run ends. It reaches the guest over the SSH channel's stdin, lands in another mode-600 file, and the guest deletes that file before starting the runner.

The final hand-off is the one place where a choice has to be made. Upstream's `Runner.Listener` accepts the value either as `--jitconfig` on the command line or in `ACTIONS_RUNNER_INPUT_JITCONFIG`, and nothing else. The provisioner uses the environment variable: `ps` exposes argv to every local user, while `ps -E` only exposes an environment to processes with the same uid. **Residual exposure:** a workflow step can therefore read the listener's environment for the life of its own job. That is not an escalation — the runner writes the same credentials to `.credentials_rsaparams` in its own directory, the guest is single-tenant and destroyed after one job, and the configuration is issued for that job alone — but it is worth knowing. The listener clears the variable from its own environment and registers it with the secret masker as soon as it reads it.

#### SSH host authentication

The provisioner does not use `StrictHostKeyChecking=no`. Before the first SSH byte is sent it reads the guest's SSH host key over the Tart guest agent's vsock channel, which does not travel over the bridge the SSH session uses, pins that key under `~/.runner-center/known_hosts.d/<image>.pub`, and connects with strict checking against it. A key that later contradicts the pin aborts the run rather than reconnecting.

**Residual first-use trust:** if the guest agent does not answer — a vanilla image, or a build without `tart-guest-agent` — there is no out-of-band channel to attest the key, so the provisioner falls back to `StrictHostKeyChecking=accept-new`, prints a warning, and pins whatever key it saw for later runs. That one boot is exposed to a local attacker on the Tart bridge. Note also that the `cirruslabs` base images ship a fixed host key and the well-known `admin` password, both of which are public to anyone who pulls the image; pinning detects a guest that is not the image you cloned, it does not authenticate the image itself.

After deploying catalog support to Convex, redeploy each machine agent. Older agents can still claim commands because the response change only adds an optional field, but they ignore the selected image and continue using their provisioner environment defaults until upgraded.

Tart caches pulled OCI images. Prune old cache entries periodically:

```bash
tart prune --entries caches --older-than 7
```

### Windows: preview, not supported

**A Windows machine cannot be onboarded through any supported path today, and no code in this section has ever been run against a real Windows host.** The provisioner and image builder are written and reviewed but unvalidated, so every Windows catalog label — `windows-2022`, `windows-2025`, `rc-win` — is preview-gated: `selectImageForMachine` refuses it unless the machine carries the `rc-preview` label. A Windows machine that has not opted in matches no image and is never assigned work. `/runs-on` therefore keeps routing Windows requests to the GitHub-hosted fallback.

Two things are missing before Windows can be called supported:

1. **Onboarding.** `curl … | bash` is the only installer, and it refuses anything that is not macOS or Linux. There is no PowerShell equivalent. Registering a Windows machine means calling `POST /agents/register` yourself and running `apps/agent` by hand.
2. **Validation.** Neither `provision-win.ps1` nor `build-image.ps1` has been executed. They are covered only by the source-level regression guards in `apps/agent/tests/provisioners.test.ts`, which pin specific defects (exit-code handling, credentials on a command line, an unpinned runner download, missing cleanup) and prove nothing about whether the scripts run.

The design, for whoever picks this up:

- `build-image.ps1` turns a Windows ISO into a parent VHDX. It applies the edition with DISM instead of running interactive setup, seeds an unattend that creates the guest account, and provisions from `SetupComplete.cmd` — as SYSTEM, at the end of setup, before any logon exists. The Actions runner is downloaded at a pinned version and verified against a pinned SHA-256 before it is expanded.
- `provision-win.ps1` gives each job a differencing child disk off that read-only parent, hands the JIT configuration to the guest over PowerShell Direct, and destroys the VM and child disk in a `finally` block. The guest needs no inbound network, no WinRM and no SSH. A `PowerShell.Exiting` handler covers a graceful unwind past `finally`, and every run reaps leftover VM directories older than `ORPHAN_MAX_AGE_MIN` (default 720) so a hard-killed run cannot strand a disk pinning the parent.

Windows-specific environment: `ORPHAN_MAX_AGE_MIN`, `VM_CPU_COUNT`, `VM_MEMORY_GB`, `VM_SWITCH`, `IMAGE_USER`, `IMAGE_PASSWORD`. Windows uses the shared `RC_JOB_TIMEOUT_S` and `RC_BOOT_TIMEOUT_S` contract documented above; `JOB_TIMEOUT_S` and `BOOT_TIMEOUT_S` remain compatibility fallbacks.

Contributions are welcome, particularly a PowerShell onboarding path and a first real validation run.

## Operations

### Reconciliation

A Convex cron runs every 60 seconds and repairs control-plane state:

- assigned jobs are requeued when an agent is offline for more than 120 seconds or provisioning has not started 45 minutes after the agent claimed the command;
- running jobs are marked failed with conclusion `abandoned` after their agent has been offline for 10 minutes;
- queued jobs expire after 24 hours;
- each machine's used-slot count is rebuilt from active assigned and running jobs;
- webhook deliveries still pending after 60 seconds are retried, and abandoned after 5 attempts;
- settled webhook deliveries are kept for 7 days — deliberately longer than the window GitHub can redeliver from, so a delivery that has already been processed can never look lost to the recovery scan;
- abandoned JIT runner registrations are deleted from GitHub;
- requeued work is sent back through the scheduler immediately.

Agents heartbeat every 30 seconds. A machine is schedulable while its latest heartbeat is less than 120 seconds old.

### Webhook intake

`POST /github/webhook` verifies the signature, records the delivery keyed by `X-GitHub-Delivery`, and returns `202` immediately; a scheduled mutation does the work. GitHub marks any response slower than 10 seconds as failed and never redelivers on its own, so the recorded delivery is what makes a transient backend error survivable.

Because the delivery id is the key, a redelivery is a no-op rather than a second job. Delivery order is not guaranteed either: if `in_progress` or `completed` arrives for a job Runner Center has never seen, the job is recorded in that state, so a late `queued` cannot provision a runner for work that has already finished.

### Recovering lost deliveries

Retrying a recorded delivery only helps once it has arrived. A delivery that never reached the deployment at all — a cold start, a rotated secret rejected with `401`, a response slower than 10 seconds — leaves no record to retry, and GitHub does not resend it. The workflow then waits in GitHub's queue until it is cancelled 24 hours later, with nothing in the dashboard to explain it.

A second cron runs every 5 minutes, lists the App's recent webhook deliveries, and asks GitHub to redeliver the failed ones this deployment has no record of. Nothing about intake changes: the redelivery arrives with the same `X-GitHub-Delivery`, so a redelivery that races a late original is still a duplicate rather than a second job.

It is bounded on every axis:

- deliveries GitHub recorded as **successful are never redelivered**, even when no job came of them — that is what keeps events Runner Center deliberately ignores from being requested forever;
- deliveries older than 24 hours are skipped, because GitHub has already cancelled the job;
- at most 3 pages (300 deliveries) are examined and 20 redeliveries requested per run;
- each delivery is requested at most 3 times, with a growing gap (1m, 5m, 30m), and is then given up on;
- a run that fails widens the gap before the next one (1m, 5m, 15m, 1h), so a revoked App does not keep both sides busy.

**This requires a GitHub App.** The `/app/hook/deliveries` endpoints are authenticated with a JWT signed by the App's private key, which a classic PAT cannot produce, and the per-repository equivalent would need a webhook ID Runner Center never sees plus `read:repo_hook`/`write:repo_hook`. On the legacy path the scan exits without making a request and the dashboard says so. Recovering lost deliveries is one of the things [migrating to an App](#migrating-off-the-legacy-path) buys.

The **Intake health** panel on the Jobs page shows the last scan, how many deliveries were missing, how many redeliveries were requested, and how many were recovered or given up on. Errors are recorded by HTTP status alone — a delivery's payload and this deployment's own response are never fetched, so neither can reach a log.

### Provisioning attempts

A job gets at most 3 provisioning attempts. Each failure records a human-readable `lastError` on the job, frees the slot, hands the abandoned JIT runner registration back to GitHub, and holds the job behind a growing backoff (15s, 60s, 300s) before retrying — preferring a machine other than the one that just failed. After the third failure the job ends as `failed` with conclusion `provision-failed` rather than cycling forever.

A provisioner that exits **zero** never requeues: the runner did its work and GitHub's `completed` event settles the job.

When a job is cancelled or completes while its command is still outstanding, the command is marked `cancelled`. The agent watches its live command set and tears the provisioner down, so a cancelled job does not leave an ephemeral runner — and a runner slot — occupied.

### Agent lifecycle

Machine onboarding installs the agent under `~/.runner-center/agent` and keeps it running automatically:

- macOS uses `~/Library/LaunchAgents/center.runner.agent.plist`;
- Linux uses `~/.config/systemd/user/runner-center-agent.service` when a user systemd session is available;
- other Linux sessions use the same `nohup` plus `@reboot` crontab pattern used by the fallback installer.

Use `rc status`, `rc logs -f`, `rc restart`, `rc stop`, `rc update`, and `rc uninstall` instead of managing those files directly. Agent credentials are stored in `~/.runner-center/agent/.env` with mode `600`.

An install or update never removes the working agent before its replacement is ready. The new release is downloaded, checksummed, unpacked, and given its dependencies in a temporary directory; only then is the running service stopped, the old directory moved to `~/.runner-center/agent.previous`, and the new one moved into place. If the new agent does not log a connection within 20 seconds, an update restores `agent.previous` and restarts it.

### Releases and versioning

Runner Center is versioned as one product, not as separately published packages. The root `package.json` and `apps/agent/package.json` carry the same version, the git tag `v<version>` is the release, and packaging refuses to run if those two versions have drifted. Nothing is published to a package registry: the only artifact is the agent archive attached to the GitHub release.

Cut a release:

```bash
# bump the version in package.json and apps/agent/package.json, then
pnpm check
pnpm release:package        # writes dist/release/ and prints the SHA-256
# copy that version and SHA-256 into AGENT_RELEASE in the same release commit
git commit -am 'chore: release v0.2.0'
git tag v0.2.0
git push origin main
git push origin v0.2.0
```

Pushing the tag runs `.github/workflows/release.yml`, which refuses to publish unless the tag, both package versions, and `AGENT_RELEASE` agree. It re-runs `pnpm check`, builds the archive twice and compares the bytes, rejects any archive whose SHA-256 differs from the deployment pin, verifies that `apps/agent/package-lock.json` installs with the exact `npm ci` command machines use, records a build provenance attestation, and publishes `runner-center-agent-<version>.tar.gz` and its `.sha256` with the GitHub CLI. Assets are never replaced on an existing release; a correction is a new version.

Roll the fleet forward once the release is published by running `pnpm deploy`; the release commit already points `AGENT_RELEASE` at the verified bytes. Machines install it on their next `rc update`. Rolling back is an edit to the previous release values followed by another deploy; a single machine can be moved with `rc update --version v0.1.0`.

A machine accepts an archive only when its SHA-256 matches the checksum published beside the asset **and** the checksum pinned in the deployment that served the install script. The packager is deterministic, so that checksum is computed and committed before the tag; the release workflow rebuilds the archive and refuses to publish unless the bytes match the independent deployment pin.

The provenance attestation is an optional extra check for operators, never a requirement for installing:

```bash
gh attestation verify runner-center-agent-0.2.0.tar.gz --repo Fanzzzd/runner-center
```

### Security model

- Dashboard sign-up is closed. Creating an account requires a single-use grant: either the bootstrap grant, minted by presenting `BOOTSTRAP_SECRET` while the instance still has no users, or an invitation issued by an admin who is already signed in.
- `BOOTSTRAP_SECRET` lives only in the deployment environment, is never written to the database, and is compared as SHA-256 digests through a constant-time equality. A missing or under-32-character secret disables account creation entirely instead of reopening sign-up.
- Grants are 256 bits, stored only as a SHA-256 hash, single-use, and expire after ten minutes. A bootstrap grant becomes inert the moment any account exists, so one that loses a race cannot be replayed into a second admin. Account creation consumes the grant in the same transaction that inserts the user, and Convex mutations are serializable, so exactly one concurrent attempt can win.
- Failed bootstrap attempts are throttled: five are tolerated, then the lockout doubles up to fifteen minutes. The counter is instance-wide, because a Convex mutation cannot see a client address. An attacker can therefore stall an operator's own first-time setup, but cannot get past it.
- Every sign-up refusal returns one message, so a missing grant, an expired grant and "this instance already has an admin" are indistinguishable to an unauthenticated caller. Only a caller who has already proved the bootstrap secret is told that the instance is set up.
- GitHub credentials never leave the Convex deployment. An app created through the Manifest flow lives in the `githubApp` table, read only by internal functions; a hand-registered app lives in `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, and `GITHUB_WEBHOOK_SECRET`, alongside the optional legacy `GITHUB_PAT`.
- No client-facing query returns the private key or webhook secret; the dashboard sees only the app ID, client ID, name, and install URL. Conversion failures are logged by HTTP status alone, never by response body.
- Delivery recovery lists and redelivers only. It never calls `GET /app/hook/deliveries/{delivery_id}`, the one endpoint that returns a delivery's request payload, request headers, and this deployment's own response body — so none of that is ever fetched, stored, or logged. GitHub failures are recorded by status code alone.
- The GitHub App requests `administration: write` and `actions: read` only, and can be limited to selected repositories.
- Only repositories named in `ALLOWED_REPOS` can queue work, and a public repository additionally needs `ALLOW_PUBLIC_REPOS`. The check runs before a job row is created, so a repository you have not named never reaches a machine.
- Jobs stored with an App installation ID use it to obtain an installation-scoped token and never fall back to the legacy PAT; if no app is configured, the job fails closed with a setup error rather than downgrading.
- Runner machines hold a machine token, not GitHub credentials. Treat the token as a secret.
- Machines install a pinned, immutable release asset and verify its SHA-256 before replacing the running agent; no install path fetches a branch tarball.
- Agent dependencies come from the lockfile inside the release asset through `npm ci`, so a machine never resolves a version range on its own.
- CI and release workflows pin every action by commit SHA, and the release job holds the only write permissions in the repository.
- Webhook bodies are verified with `X-Hub-Signature-256` before processing.
- Agents initiate outbound Convex WebSocket connections; runner hosts need no inbound port or public IP.
- GitHub JIT configuration is valid for a single runner job and is cleared from the command when the agent claims it.
- Docker containers and Tart VMs are deleted after the runner process exits.

The Windows preview adds its own model, documented in full at the top of each script:

- The JIT configuration never reaches a command line on either side of the VM socket. The host passes it to `Invoke-Command` through `-ArgumentList`; the guest hands it to `Runner.Listener` through `ACTIONS_RUNNER_INPUT_JITCONFIG` instead of argv or a provisioner-owned config file. Upstream clears the variable after consuming it, but a same-uid process could inspect the listener's environment during that brief window. Linux and macOS use the same final environment-variable hand-off inside their disposable environments.
- `build-image.ps1` configures no AutoLogon, so no plaintext logon password is written to the image's registry. The guest account's password does pass through the unattend file in plaintext — Windows offers no offline alternative for creating a local account — and provisioning deletes every cached copy before the build verifies, offline, that the file is gone and that no AutoLogon values survive. The build refuses to bless an image that fails either check.
- The built-in Administrator gets an independent throwaway password that is never recorded, and the account is disabled during provisioning. The only password kept is the guest account's, DPAPI-encrypted as `<image>.cred.xml` and readable only by the account that ran the build.
- Defender real-time monitoring stays on unless `-DisableDefenderRealtime` is passed, and the choice is recorded in `<image>.image.json` next to the VHDX.
- All of this is design and code review only. None of it has been observed working.

## Development

The repository is a pnpm workspace driven by [Turborepo](https://turborepo.com):

```text
runner-center/
├── apps/
│   ├── agent/                  # Node daemon installed on runner machines
│   │   ├── provisioners/       # provision-linux.sh, provision-mac.sh, provision-win.ps1, build-image.ps1
│   │   └── tests/              # source-level guards for the PowerShell provisioners
│   └── dashboard/              # Vite + React 19 + TanStack Router UI
├── packages/
│   ├── backend/                # Convex deployment: convex/, convex.json, .env.local
│   ├── release/                # deterministic packaging of the agent release archive
│   └── typescript-config/      # shared tsconfig presets (base, node, react)
├── .github/workflows/          # ci.yml (every push) and release.yml (v* tags)
├── turbo.json                  # task graph
├── pnpm-workspace.yaml         # workspace globs + dependency catalog
├── .oxlintrc.json              # oxlint rules
└── .oxfmtrc.json               # oxfmt options
```

| Command                | Description                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| `pnpm dev`             | Run every package's dev task (Convex watcher + Vite) in parallel.                                |
| `pnpm dev:backend`     | Convex watcher only.                                                                             |
| `pnpm dev:dashboard`   | Vite dev server only.                                                                            |
| `pnpm build`           | Build the agent and the dashboard through the Turborepo task graph.                              |
| `pnpm typecheck`       | Typecheck every package.                                                                         |
| `pnpm test`            | Run every package's test suite: vitest in the backend, `node:test` in the agent.                 |
| `pnpm lint`            | oxlint over the whole repository (`pnpm lint:fix` to autofix).                                   |
| `pnpm format`          | oxfmt over the whole repository (`pnpm format:check` in CI).                                     |
| `pnpm check`           | lint + format check + typecheck + test, the same gate CI runs.                                   |
| `pnpm convex …`        | Run the Convex CLI against `packages/backend`, e.g. `pnpm convex env set FOO bar`.               |
| `pnpm deploy`          | Build the dashboard and deploy backend plus static hosting.                                      |
| `pnpm release:package` | Build the agent and write `dist/release/runner-center-agent-<version>.tar.gz` plus its checksum. |

The dashboard imports backend types through the `@runner-center/backend/api`
package export, so `convex/_generated` is committed and no path aliases point
across package boundaries.

`apps/agent` is intentionally self-contained: it is packaged into the release
archive and installed by machines with plain `npm ci`, which understands neither
the `workspace:` nor the `catalog:` protocol. It must therefore pin its
dependencies literally, its `tsconfig.json` must not extend the shared config
package, and `apps/agent/package-lock.json` is committed and regenerated
whenever its `package.json` changes. Remove the pnpm-linked `node_modules`
first, or npm records paths into the pnpm store instead of registry tarballs:

```bash
rm -rf apps/agent/node_modules
npm install --package-lock-only --prefix apps/agent
pnpm install
```

CI runs `npm ci` in `apps/agent` to catch a lockfile that has drifted from the
manifest, and does it last because it replaces the pnpm-linked `node_modules`.
Running that command locally leaves the directory without the agent's
devDependencies, and `pnpm install` reports the workspace as up to date rather
than repairing it; delete `apps/agent/node_modules` and install again.

For the same reason the agent's tests run on `node:test` alone, with no test
framework dependency, and `pnpm build` compiles `tsconfig.json` only, so they
are never emitted into `dist`.

## Contributing

Issues and pull requests are welcome, especially for provisioners, platform coverage, and scheduler hardening. Run `pnpm install` and `pnpm check` (lint, format, typecheck, test) before opening a pull request. Keep platform-specific lifecycle logic in `apps/agent/provisioners/`, keep credentials out of logs and source control, and document any new host dependency.

## License

[MIT](LICENSE) © 2026 Zhendi Fan
