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
- A GitHub classic PAT with `repo` scope and administrator access to each target repository
- Docker on Linux runner machines, or Tart and `sshpass` on macOS runner machines

Clone the project, install dependencies, and build the agent:

```bash
git clone https://github.com/Fanzzzd/runner-center.git
cd runner-center
pnpm install
pnpm --filter @runner-center/agent build
```

Create or select a Convex deployment, then initialize Convex Auth:

```bash
npx convex dev --once
npx @convex-dev/auth
```

Set the deployment secrets. Keep the webhook value: GitHub must use the same value in the next step.

```bash
npx convex env set GITHUB_WEBHOOK_SECRET '<random-webhook-secret>'
npx convex env set GITHUB_PAT '<classic-github-pat>'
```

Deploy the Convex backend and hosted dashboard:

```bash
npm run deploy
```

In the GitHub repository, open **Settings → Webhooks → Add webhook** and set:

- **Payload URL:** `https://<deployment>.convex.site/github/webhook`
- **Content type:** `application/json`
- **Secret:** the value of `GITHUB_WEBHOOK_SECRET`
- **Events:** select **Workflow jobs** only
- **Active:** enabled

The webhook is at the site root. There is no `/api` prefix.

Open `https://<deployment>.convex.site`, choose **Sign up**, and create the first account. Go to **Machines → Add machine**, select the OS, add labels such as `rc-linux`, set the slot count, and copy the generated one-line agent command.

On the registered machine, repeat the clone, install, and agent-build commands above if it does not already have the checkout. Install the OS provisioner prerequisites described below, then paste the command from the dashboard. It has this form:

```bash
CONVEX_URL='https://<deployment>.convex.cloud' MACHINE_TOKEN='<machine-token>' pnpm --filter @runner-center/agent start
```

The machine appears online after its first heartbeat.

## Using it in workflows

Request the labels registered for the machine. `self-hosted` is matched automatically by Runner Center but should remain in the workflow:

```yaml
jobs:
  build:
    runs-on: [self-hosted, rc-linux]
    steps:
      - uses: actions/checkout@v4
      - run: npm test
```

For best-effort fallback, use a small GitHub-hosted routing job. `GET /runs-on` returns either the requested self-hosted label array or the fallback runner string:

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
            'https://<deployment>.convex.site/runs-on?labels=rc-linux&fallback=ubuntu-latest' \
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

The default is pinned to `ghcr.io/actions/actions-runner:2.336.0`. Set `RUNNER_IMAGE` before starting the agent to use a compatible custom image:

```bash
export RUNNER_IMAGE='ghcr.io/actions/actions-runner:2.336.0'
```

The tag is pinned instead of using `latest` so runner updates are deliberate and deployments are reproducible. GitHub deprecates old runner versions, so update and verify this pin regularly rather than leaving it unchanged indefinitely.

### macOS: Tart

Each job clones a base image into a temporary Tart VM, boots it without graphics, runs the JIT runner over SSH, and deletes the VM when the runner exits.

```bash
brew install cirruslabs/cli/tart
brew install cirruslabs/cli/sshpass
```

The default image is `ghcr.io/cirruslabs/macos-sequoia-base:latest`. Override it before starting the agent:

```bash
export BASE_IMAGE='ghcr.io/cirruslabs/macos-sequoia-xcode:16.4'
```

Custom images must support the provisioner's `admin` SSH login and contain the runner at `~/actions-runner`. Under Apple's macOS Software License Agreement, configure no more than two concurrent macOS VM slots on one Apple-branded host.

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

### Keep the agent running

For a simple host, run it from the repository checkout with `nohup`:

```bash
nohup env CONVEX_URL='https://<deployment>.convex.cloud' MACHINE_TOKEN='<machine-token>' \
  pnpm --filter @runner-center/agent start \
  >runner-center-agent.log 2>&1 &
```

For Linux, a minimal systemd unit is more reliable:

```ini
# /etc/systemd/system/runner-center-agent.service
[Unit]
Description=Runner Center agent
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=runner
WorkingDirectory=/opt/runner-center
Environment=CONVEX_URL=https://<deployment>.convex.cloud
Environment=MACHINE_TOKEN=<machine-token>
ExecStart=/usr/bin/env bash -lc 'exec pnpm --filter @runner-center/agent start'
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now runner-center-agent
sudo systemctl status runner-center-agent
```

### Security model

- `GITHUB_PAT` and `GITHUB_WEBHOOK_SECRET` exist only in Convex deployment environment variables.
- Runner machines hold a machine token, not GitHub credentials. Treat the token as a secret.
- Webhook bodies are verified with `X-Hub-Signature-256` before processing.
- Agents initiate outbound Convex WebSocket connections; runner hosts need no inbound port or public IP.
- GitHub JIT configuration is valid for a single runner job and is cleared from the command when the agent claims it.
- Docker containers and Tart VMs are deleted after the runner process exits.

## Contributing

Issues and pull requests are welcome, especially for provisioners, platform coverage, and scheduler hardening. Run `pnpm install`, `pnpm build`, and `npx convex dev` before opening a pull request. Keep platform-specific lifecycle logic in `apps/agent/provisioners/`, keep credentials out of logs and source control, and document any new host dependency.

## License

[MIT](LICENSE) © 2026 Zhendi Fan
