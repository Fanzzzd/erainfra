# The erainfra CLI and operator API

`erainfra` reads and manages the fleet from a terminal. This page covers installing it, tokens,
the commands, and the HTTP API it uses.

## Install and sign in

`erainfra` is the operator CLI. It reads Profiles, Workers and jobs through the control plane's
operator API, the way the Blacksmith CLI and actuated-cli read theirs, and prints a table or stable
JSON. It also runs infrastructure management against Convex: Nodes, Apps, deploys, env, mesh links
and log tails (`erainfra nodes|apps|deploy|deployments|env|links|logs`; see
[docs/infra-management.md](infra-management.md#operate-from-the-erainfra-cli)). It is a single static binary with no dependencies. `rc` on a Worker remains the tool for that
one machine (`rc status`, `rc logs -f`, `rc update`), and `erainfra worker <command>` runs it from
this CLI on the Worker; [ADR 0011](adr/0011-one-erainfra-cli-over-an-operator-api.md)
explains the split.

Install it from a release (releases after v0.2.0-rc.10; Linux, macOS and Windows, x64 and ARM64
except Windows ARM64), or build it from source:

```bash
case "$(uname -m)" in x86_64) cpu=x86_64 ;; aarch64) cpu=arm64 ;; esac   # Linux; aarch64 is arm64
gh release download v<version> -R Fanzzzd/erainfra -p "erainfra-linux-$cpu*"
sha256sum -c "erainfra-linux-$cpu.sha256"
install -m 0755 "erainfra-linux-$cpu" ~/.local/bin/erainfra

go install github.com/Fanzzzd/erainfra/apps/erainfra-cli/cmd/erainfra@latest
```

Create a token in the dashboard under **Settings → API tokens**. The same list holds every token
the control plane accepts, told apart by scope:

| Scope     | `/api/v1` reads | `/api/v1` admin routes | `/metrics` |
| --------- | --------------- | ---------------------- | ---------- |
| `read`    | yes             | no                     | yes        |
| `admin`   | yes             | yes                    | yes        |
| `metrics` | no              | no                     | yes        |

The fleet's admin routes mint Worker registration tokens (`erainfra workers add`) and replace a
Worker's host labels (`erainfra workers set-labels`). The
infrastructure routes add enrolling and revoking Nodes, deploying, removing Apps, setting env,
declaring links and reading log tails; each is in the audit
log with the token's name. The dashboard shows a new token once, stores only its SHA-256, records when each
token was last used (to five minutes), and revokes a token on its next request. No route mints
tokens, so a leaked admin token cannot create its own replacement.

```bash
erainfra auth login --url https://<deployment>.convex.site --token -   # reads the token from stdin
erainfra auth status
erainfra profiles list
erainfra workers list
erainfra workers set-labels worker-01 gpu   # admin token; see "Pin a Profile to some Workers"
erainfra jobs list --profile erainfra-4vcpu-ubuntu-2404 --state failed --since 24h
erainfra jobs list --repo acme/web --all --json | jq '.attempts[] | {id, queueWaitMs, durationMs}'
erainfra jobs view <id>
erainfra jobs logs <id>
erainfra rightsize --repo acme/web --since 7d
erainfra rightsize --map > runs-on-map.json
erainfra tests list --repo acme/web --failed --since 24h
erainfra tests flaky --repo acme/web --json | jq '.flakyTests[] | {name, occurrences, evidence}'
erainfra migrate runs-on --repo ../web   # see "Move a repository's workflows onto Profiles"
```

The login is stored in `$XDG_CONFIG_HOME/erainfra/config.json` (default
`~/.config/erainfra/config.json`, `%AppData%\erainfra\config.json` on Windows) with mode 0600.
`ERAINFRA_URL` and `ERAINFRA_TOKEN` together override it, for CI and scripts. Every command takes
`--format table|json` (or `--json`) and `--help`. Exit codes: 0 success, 1 the request failed, 2
usage error or a filter the API refused, 4 not logged in or token refused. A read (GET) or a
whole-value write (PUT) that loses its connection, times out or gets a 5xx is sent again, up to 4
attempts with jittered exponential backoff, and each retry is noted on stderr. A POST or DELETE is
sent once, since a repeat could create something twice or report a done delete as failed. Printed
errors never show a `token=` URL value.

Each `jobs` row is one Attempt. `WAIT` is how long GitHub held the job before a Runner of this fleet
took it. GitHub's scale-set messages have so far carried no queue time, so `WAIT` counts from when GitHub handed
the job to the Profile's scale set, `queuedAt` stays null, and `jobs view` prints that start as
"On scale set" (`scaleSetAssignedAt` in JSON). `DURATION` runs from GitHub assigning the job to a
Runner to it finishing. The control plane stores no job
or Worker logs: GitHub holds the job log, so `jobs logs` runs `gh run view <run> --log` when the
GitHub CLI is installed and prints the run URL otherwise. A Worker's own Agent log is read on the
Worker with `rc logs`.

The API under `/api/v1` takes the token as `Authorization: Bearer <token>`:

| Route                                      | Scope | Returns                                                                                                         |
| ------------------------------------------ | ----- | --------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/token`                        | read  | the calling token's name and scope                                                                              |
| `GET /api/v1/profiles`                     | read  | Profiles with ready Workers, free/ready slots, Workers per readiness state, and the host labels pinned to       |
| `GET /api/v1/workers`                      | read  | Workers with host labels, slots, readiness per Profile, last heartbeat and active Attempts                      |
| `GET /api/v1/attempts`                     | read  | Attempts newest first; `profile`, `state`, `repo`, `since` (`24h`, `7d` or RFC 3339), `limit` (1–100), `cursor` |
| `GET /api/v1/attempts/<id>`                | read  | one Attempt with its timeline, queue wait, duration and run URL                                                 |
| `GET /api/v1/rightsize`                    | read  | a Profile recommendation per repository and job, and the `runs-on` map; `repo`, `since` (at most 14 days back)  |
| `POST /api/v1/workers/registration-tokens` | admin | a single-use Worker registration token and the install commands                                                 |
| `GET /api/v1/tests`                        | read  | runs with JUnit results and their failures, newest first; `repo`, `since`, `limit`, `failed`                    |
| `GET /api/v1/tests/flaky`                  | read  | tests seen both failing and passing, latest first; `repo`, `since`, `limit`                                     |
| `PUT /api/v1/workers/<name>/labels`        | admin | replaces the Worker's host labels with `{"labels": [...]}`; `[]` clears them                                    |

The infrastructure routes (`/api/v1/nodes`, `/apps`, `/deployments`, `/links`, `/logs`) are listed
in [docs/infra-management.md](infra-management.md#the-operator-api-routes).

Absent values are `null`, timestamps are RFC 3339 in UTC, durations are milliseconds, and an error
is `{"error": {"code", "message"}}` with 400, 401, 403 or 404. The control plane does not record a
Worker's Agent version, so `workers` does not report one; `rc status` on the Worker prints it.
