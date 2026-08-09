# Runner Center

Runner Center is an open-source control plane on Convex for ephemeral self-hosted GitHub Actions runners on your own machines. Linux and macOS are supported today, with Windows planned. Machines need no public IP or inbound firewall rule: the agent connects out over WebSocket. Every job gets a clean Docker container or Tart VM, and workflows can use Runner Center as a drop-in `runs-on` target with an optional GitHub-hosted fallback when the fleet is busy.

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

Choose a random webhook secret, then create a GitHub App from the settings for the target user or organization. Keep the app private by allowing installation only on that account, and use these settings:

- **Homepage URL:** `https://<deployment>.convex.site` is sufficient
- **Webhook:** active
- **Webhook URL:** `https://<deployment>.convex.site/github/webhook`
- **Webhook secret:** the random value you chose for `GITHUB_WEBHOOK_SECRET`
- **Repository permissions → Actions:** **Read and write**. Workflow job events require read access, and the JIT runner endpoint requires write access.
- **Subscribe to events:** **Workflow jobs** only

After creating the app, note its **App ID** and generate and download a private key PEM. Store the webhook secret, App ID, and PEM in the Convex deployment:

```bash
pnpm convex env set GITHUB_WEBHOOK_SECRET '<random-webhook-secret>'
pnpm convex env set GITHUB_APP_ID '<github-app-id>'
pnpm convex env set GITHUB_APP_PRIVATE_KEY "$(cat /path/to/private-key.pem)"
```

The private key can be stored as a multiline PEM or with escaped `\n` newline sequences. Deploy the Convex backend and hosted dashboard:

```bash
pnpm deploy
```

From the GitHub App page, choose **Install App** and install it for all repositories or only the repositories Runner Center should serve. The installation ID does not need manual configuration; GitHub includes it in each App webhook payload. The webhook is at the site root, with no `/api` prefix.

### Legacy PAT and repository webhook fallback

Existing setups can keep a classic PAT and one webhook per repository. This path is used only for repository webhook jobs whose payload has no GitHub App installation ID:

```bash
pnpm convex env set GITHUB_PAT '<classic-github-pat-with-repo-scope>'
```

The PAT needs `repo` scope and administrator access to each target repository. In each repository, add an active `application/json` webhook at `https://<deployment>.convex.site/github/webhook`, use the same `GITHUB_WEBHOOK_SECRET`, and subscribe only to **Workflow jobs**. A job stored with an App installation ID always uses installation authentication and never falls back to the PAT. When migrating, install the App, disable the old repository webhooks, wait for jobs already received through them to finish, and then remove the PAT. Disabling the old webhooks avoids overlapping deliveries after assignment has begun.

Open `https://<deployment>.convex.site`, choose **Sign up**, and create the first account. Go to **Machines → Add machine** and copy the generated command. Run it on the macOS or Linux host you want to register:

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

| Label          | OS    | Image                                          | Notes                                                                                                                                                 |
| -------------- | ----- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ubuntu-22.04` | Linux | `ghcr.io/actions/actions-runner:2.336.0`       | Compatibility label. The current pinned image reports `ImageOS=ubuntu24`; it is a minimal runner image, not the GitHub-hosted Ubuntu 22.04 toolchain. |
| `ubuntu-24.04` | Linux | `ghcr.io/actions/actions-runner:2.336.0`       | Minimal Ubuntu 24.04-based runner image. Install project dependencies in workflow steps.                                                              |
| `rc-linux`     | Linux | `ghcr.io/actions/actions-runner:2.336.0`       | Alias for the default Linux image.                                                                                                                    |
| `macos-15`     | macOS | `ghcr.io/cirruslabs/macos-sequoia-base:latest` | Tart base image for macOS Sequoia.                                                                                                                    |
| `macos-26`     | macOS | `ghcr.io/cirruslabs/macos-tahoe-base:latest`   | Tart base image for macOS Tahoe.                                                                                                                      |
| `rc-mac`       | macOS | `ghcr.io/cirruslabs/macos-sequoia-base:latest` | Alias for the default macOS image.                                                                                                                    |

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

### macOS: Tart

Each job clones a base image into a temporary Tart VM, boots it without graphics, runs the JIT runner over SSH, and deletes the VM when the runner exits.

```bash
brew install cirruslabs/cli/tart
brew install cirruslabs/cli/sshpass
```

Catalog-backed commands pass their selected image as `IMAGE`. The provisioner resolves macOS images in this order: `IMAGE`, then `BASE_IMAGE`, then `ghcr.io/cirruslabs/macos-sequoia-base:latest`. `BASE_IMAGE` remains a fallback when a command has no image field:

```bash
export BASE_IMAGE='ghcr.io/cirruslabs/macos-sequoia-xcode:16.4'
```

Custom images must support the provisioner's `admin` SSH login and contain the runner at `~/actions-runner`. Under Apple's macOS Software License Agreement, configure no more than two concurrent macOS VM slots on one Apple-branded host.

After deploying catalog support to Convex, redeploy each machine agent. Older agents can still claim commands because the response change only adds an optional field, but they ignore the selected image and continue using their provisioner environment defaults until upgraded.

Tart caches pulled OCI images. Prune old cache entries periodically:

```bash
tart prune --entries caches --older-than 7
```

### Windows: planned

The Windows provisioner is currently a stub and exits with an error. The planned backend uses a Hyper-V golden image, GitHub JIT configuration, and one disposable VM per job. Contributions are welcome.

## Operations

### Reconciliation

A Convex cron runs every 60 seconds and repairs control-plane state:

- assigned jobs are requeued when an agent is offline for more than 120 seconds or an assignment is stuck for 10 minutes;
- running jobs are marked failed with conclusion `abandoned` after their agent has been offline for 10 minutes;
- queued jobs expire after 24 hours;
- each machine's used-slot count is rebuilt from active assigned and running jobs;
- requeued work is sent back through the scheduler immediately.

Agents heartbeat every 30 seconds. A machine is schedulable while its latest heartbeat is less than 120 seconds old.

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
git commit -am 'chore: release v0.2.0'
git tag v0.2.0
git push origin main
git push origin v0.2.0
```

Pushing the tag runs `.github/workflows/release.yml`, which refuses to publish unless the tag matches both package versions exactly, re-runs `pnpm check`, builds the archive twice and compares the bytes, verifies that `apps/agent/package-lock.json` installs with the exact `npm ci` command machines use, records a build provenance attestation, and publishes `runner-center-agent-<version>.tar.gz` and its `.sha256` with the GitHub CLI. Assets are never replaced on an existing release; a correction is a new version.

Roll the fleet forward once the release is published: set `AGENT_RELEASE` in `packages/backend/convex/agentRelease.ts` to that version and the checksum from the release notes, then run `pnpm deploy`. Machines install it on their next `rc update`. Rolling back is the same edit with the previous values; a single machine can be moved with `rc update --version v0.1.0`.

A machine accepts an archive only when its SHA-256 matches the checksum published beside the asset **and** the checksum pinned in the deployment that served the install script. The pin can only be filled in after the release exists, so a version that has not shipped yet has an empty `sha256` and installs verify against the published checksum alone.

The provenance attestation is an optional extra check for operators, never a requirement for installing:

```bash
gh attestation verify runner-center-agent-0.2.0.tar.gz --repo Fanzzzd/runner-center
```

### Security model

- `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, and the optional legacy `GITHUB_PAT` exist only in Convex deployment environment variables.
- The recommended GitHub App has only Actions read/write access and can be limited to selected repositories.
- Jobs stored with an App installation ID use it to obtain an installation-scoped token and never fall back to the legacy PAT.
- Runner machines hold a machine token, not GitHub credentials. Treat the token as a secret.
- Machines install a pinned, immutable release asset and verify its SHA-256 before replacing the running agent; no install path fetches a branch tarball.
- Agent dependencies come from the lockfile inside the release asset through `npm ci`, so a machine never resolves a version range on its own.
- CI and release workflows pin every action by commit SHA, and the release job holds the only write permissions in the repository.
- Webhook bodies are verified with `X-Hub-Signature-256` before processing.
- Agents initiate outbound Convex WebSocket connections; runner hosts need no inbound port or public IP.
- GitHub JIT configuration is valid for a single runner job and is cleared from the command when the agent claims it.
- Docker containers and Tart VMs are deleted after the runner process exits.

## Development

The repository is a pnpm workspace driven by [Turborepo](https://turborepo.com):

```text
runner-center/
├── apps/
│   ├── agent/                  # Node daemon installed on runner machines
│   │   └── provisioners/       # provision-linux.sh, provision-mac.sh, provision-win.ps1
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
| `pnpm lint`            | oxlint over the whole repository (`pnpm lint:fix` to autofix).                                   |
| `pnpm format`          | oxfmt over the whole repository (`pnpm format:check` in CI).                                     |
| `pnpm check`           | lint + format check + typecheck, the same gate CI runs.                                          |
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
manifest.

## Contributing

Issues and pull requests are welcome, especially for provisioners, platform coverage, and scheduler hardening. Run `pnpm install` and `pnpm check` (lint, format, typecheck) before opening a pull request. Keep platform-specific lifecycle logic in `apps/agent/provisioners/`, keep credentials out of logs and source control, and document any new host dependency.

## License

[MIT](LICENSE) © 2026 Zhendi Fan
