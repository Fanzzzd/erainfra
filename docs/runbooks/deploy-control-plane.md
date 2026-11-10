# Runbook: deploy the control plane without losing capability

The production Convex deployment schedules live CI and serves `/install`. Deploying it is one
command, but it swaps the scheduler, the worker and controller APIs, the install script and the
dashboard under running Workers and controllers. Treat it as a cutover.

Two facts decide the order:

- **The deployment pins the release.** `packages/backend/convex/agentRelease.ts` names the release
  version and the SHA-256 of every binary `/install` hands out: Worker archive, Infra Agent,
  `erainfra-mesh`, cache service and controller. The pins match one tagged release, so deploy from
  that release's commit, never from the tip of `main`. A commit after the tag can carry pins for a
  release that does not exist yet.
- **The backend and the controllers move together.** The backend refuses every controller write
  that does not carry the Profile's lease epoch (`controllerLease.ts`), with no legacy bypass. A
  controller from before the lease code stops working the moment the new backend is live, and a
  lease-aware controller cannot talk to a backend from before it. So the controller update runs in
  the same window as the deploy, and a rollback moves both back together.

## Check which deployment the CLI reaches

Every `npx convex` command below finds the Convex project through `packages/backend/.env.local`.
On the owner's machine that file names a dev deployment (`CONVEX_DEPLOYMENT=dev:…`), not
production. `npx convex deploy` targets the project's production deployment anyway. Every other
command (`env`, `run`, `data`) acts on the dev deployment unless it passes `--prod`, so every one
below does. Add `--prod` to any `npx convex` command you type yourself.

Git ignores `*.local`, so a new worktree does not have the file: copy it in after every
`git worktree add`, as each block below does. Without it, `npx convex deploy` stops with "No
CONVEX_DEPLOYMENT set". Exporting `CONVEX_DEPLOY_KEY` (the production deploy key) in the shell
works too. Relative paths below start from the checkout you deploy from today (`$main`), beside
which both worktrees go.

Before anything else, from `packages/backend` in the checkout you deploy from today, confirm what
`--prod` reaches:

```bash
grep '^CONVEX_DEPLOYMENT=' .env.local      # dev:<name> is expected; --prod picks the same project's production
npx convex dashboard --prod --no-open      # https://dashboard.convex.dev/d/<production name>
npx convex env list --prod --names-only    # production's variables: CONTROLLER_TOKEN, SITE_URL, …
```

The name after `/d/` is the production deployment. Its URLs are `https://<name>.convex.cloud` and
`https://<name>.convex.site`, and `<deployment>` in every URL below is that name. It must be the
deployment the fleet talks to: on `oracle-singapore-1`,
`sudo grep -h CONVEX /etc/runner-center/profiles/*.env` shows `https://<name>.convex.site`
for every Profile. If the name differs, or `env list --prod` shows no `CONTROLLER_TOKEN`, stop:
`.env.local` belongs to another project.

## 1. Before

Pick the release and check it out in a clean worktree, from the checkout you deploy from today:

```bash
main=$PWD                                              # this checkout, whose packages/backend/.env.local finds the project
git fetch --tags origin
git worktree add ../erainfra-release v0.2.0-rc.11      # the tag you are deploying
cd ../erainfra-release
cp "$main/packages/backend/.env.local" packages/backend/
grep -n 'version:' packages/backend/convex/agentRelease.ts
pnpm install --frozen-lockfile
pnpm check                                             # green on the commit you deploy
```

The `version` must be the tag's. `mesh` and `controller` in `AGENT_RELEASE` must not be empty if
you will install Nodes with `--convex` or update controllers; an empty map makes `/install` refuse
that role.

### The rollback branch

A plain checkout of the release production runs now cannot be deployed over the new one
([Roll back](#4-roll-back) says why). Its rollback is a branch with the old functions on the new
schema, and it must exist and pass its checks before the window.

For v0.2.0-rc.10 to v0.2.0-rc.11 it exists:
`rollback/v0.2.0-rc.10-on-v0.2.0-rc.11-schema`. It was built against `0bfc2b1`, the rc.11
candidate, and its commit message lists what it took from there. Confirm the tag's schema is still
that one. No output means the branch is current:

```bash
git diff --stat 0bfc2b1 v0.2.0-rc.11 -- packages/backend/convex/{schema,alertRules,attemptMetricsModel,benchmark,controllerLiveness,egress,testReportsModel,workerPolicy}.ts \
  packages/backend/convex/infra/{nodeCommandModel,policy,tables}.ts
```

If it lists a file, redo the steps below on the branch for what changed. Then check the branch out
where the rollback will run from, and run its checks:

```bash
cd "$main"
git worktree add ../erainfra-rollback origin/rollback/v0.2.0-rc.10-on-v0.2.0-rc.11-schema
cd ../erainfra-rollback
cp "$main/packages/backend/.env.local" packages/backend/
pnpm install --frozen-lockfile && pnpm check           # green: old functions, new schema
pnpm --filter @erainfra/dashboard build && rm -rf apps/dashboard/dist
cd "$main"
```

For a later pair of releases, build the branch the same way (`old` is production now, `new` the
release you deploy):

1. `git worktree add -b "rollback/v$old-on-v$new-schema" ../erainfra-rollback "v$old"`, then copy
   `.env.local` in as above.
2. `git checkout "v$new" -- packages/backend/convex/schema.ts`.
3. Follow every relative import of `schema.ts`, and of each module it brings in, except
   `import type`. For each module:
   - The old release lacks it, and it defines no Convex function (no `query(`, `mutation(`,
     `action(`, `httpAction(` or `internal…(`): take it from `v$new`.
   - It would bring in functions, or a module the old functions already use: copy only the
     validators `schema.ts` needs into `schema.ts`, verbatim.
   - The old release has it and its exported validators match `v$new`'s: keep the old copy, so the
     old functions behave as they did.
4. Add each module you took to `packages/backend/convex/_generated/api.d.ts`, in the order
   `convex codegen` uses (byte order of the path). Codegen itself needs a deployment.
5. In the root `package.json`, `deploy:control-plane` must be
   `pnpm --filter @erainfra/backend run deploy`. Without `run`, pnpm runs its own `deploy`.
6. `pnpm install --frozen-lockfile && pnpm check`, build the dashboard as above, commit, and
   `git push origin "rollback/v$old-on-v$new-schema"`. Never merge it into `main`.

The branch adds no function code: the functions are the old release's, and the schema only declares
more tables and optional fields than the old one did.

### Profile label conflicts

List Profiles whose scale-set labels overlap (ADR 0017). The check is read-only and needs no
function on the deployment, so it works against the backend you are about to replace. Export to a
file first, so a failed export stops the command instead of reaching the check as empty input:

```bash
cd ../erainfra-release/packages/backend
npx convex data profiles --prod --limit 10000 --format jsonl > profiles.jsonl &&
  pnpm --silent profile-label-conflicts "$PWD/profiles.jsonl"; echo "exit $?"
rm profiles.jsonl
cd "$main"
```

| Exit | Meaning                                                                                                                                                                                       |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | No pair, and the export showed every active Profile's labels.                                                                                                                                 |
| 1    | It lists each conflicting pair.                                                                                                                                                               |
| 2    | The input could not be read or held no Profile. Fix the export and run it again.                                                                                                              |
| 3    | No pair among what the export shows, but the Profiles it names carry no labels in it. Their controllers register with `RC_LABELS` from their env files, which the deployment does not record. |

v0.2.0-rc.10 stores no labels, so expect 3. On each controller host, read the labels the
controllers really use:

```bash
sudo grep -H LABELS= /etc/runner-center/profiles/*.env
```

No Profile's `RC_LABELS` (or `ERAINFRA_LABELS`) may include another Profile's name. A pair keeps
registering after the deploy, but GitHub can run either Profile's jobs on the other, and the new
backend raises it in `erainfra profiles list`, the Profiles table,
`erainfra_profile_label_conflicts` and the _Profiles' scale-set labels overlap_ alert. Fix it by
removing the other Profile's name from one side's labels and restarting that controller.

### Prove `--update` will find the controllers

`--update` moves only instances named `runner-center-controller@<profile>` that run from
`/etc/systemd/system/runner-center-controller@.service`, it replaces the binary at
`/usr/local/lib/runner-center/runner-center-controller`, and the unit it installs runs each
instance as `runner-center-controller` with `/etc/runner-center/profiles/<profile>.env`.
v0.2.0-rc.10's `/install` has no controller role, so a controller on rc.10 was installed by hand.
Check each controller host before the window. Everything here only reads:

```bash
sudo /usr/local/lib/runner-center/runner-center-controller version
getent passwd runner-center-controller
units=$(systemctl list-units --type=service --state=active --plain --no-legend \
  'runner-center-controller@*' | awk '{ print $1 }')
for u in $units; do
  p=${u#runner-center-controller@}; p=${p%.service}
  printf '%s fragment=%s dropins=%s env=%s\n' "$u" \
    "$(systemctl show -p FragmentPath --value "$u")" \
    "$(systemctl show -p DropInPaths --value "$u")" \
    "$(sudo test -f "/etc/runner-center/profiles/$p.env" && echo ok || echo MISSING)"
done
```

On `oracle-singapore-1` you expect the old version, an account line, and exactly
`runner-center-controller@rc-e2e.service` and `runner-center-controller@rc-linux-js.service`, each
with `fragment=/etc/systemd/system/runner-center-controller@.service`, no drop-ins and `env=ok`.
Anything else means `--update` would miss that controller or fail to start it, and roll back. Fix
it before the window, or plan the dedicated-host install from
[operate-the-controller-host.md](operate-the-controller-host.md#dedicated-host-install-and-update)
for it. From v0.2.0-rc.11 on, `/install … --role controller --update --dry-run` runs these checks
itself.

### Stage the controller

Stage the new controller binary on every controller host, so the window does not wait on a
download. The release names each binary by its target, and on ARM `uname -m` does not print the
target: an `aarch64` host takes `linux-arm64`, an `x86_64` host `linux-x86_64`.
`oracle-singapore-1` is aarch64, so it takes `runner-center-controller-linux-arm64`. Take the
binary from the GitHub Release of the tag and check it against the pin on the release commit:

```bash
v=0.2.0-rc.11
case "$(uname -m)" in
  x86_64) target=linux-x86_64 ;;
  aarch64) target=linux-arm64 ;;
  *) target=none ;;
esac
asset=runner-center-controller-$target; echo "$asset"   # oracle-singapore-1: runner-center-controller-linux-arm64
mkdir -p ~/erainfra-controller-v$v && cd ~/erainfra-controller-v$v
curl -fsSLO "https://github.com/Fanzzzd/erainfra/releases/download/v$v/$asset"
pin=$(curl -fsSL "https://raw.githubusercontent.com/Fanzzzd/erainfra/v$v/packages/backend/convex/agentRelease.ts" |
  awk '/^  controller: \{/,/^  \},/' | grep -F "\"$target\"" | cut -d '"' -f 4)
echo "$pin  $asset" | sha256sum -c -                    # runner-center-controller-linux-arm64: OK
```

`sha256sum -c` must print `OK`. It fails when the bytes differ from the pin and when the tag pins
nothing for this target. The update below passes the directory, not the file, to `--source`, and
the installer adds the asset name for the host's own CPU, so the command is the same on every host.

`--update` keeps each controller host's old binary and unit as `.bak-<old version>` files, so those
need no note.

Confirm the EraInfra `smoke` workflow is green; it runs daily against the live fleet and on demand
via workflow dispatch. Pick a quiet window: running Attempts are not interrupted by a deploy, but
scheduling decisions made mid-deploy land on whichever code version answers, and GitHub queues new
jobs while the controllers restart.

## 2. Deploy, and update the controllers in the same window

From the release worktree, deploy the functions, then build and upload the dashboard:

```bash
cd ../erainfra-release/packages/backend
npx convex deploy -y
pnpm run deploy --skip-convex
```

Run the backend's `deploy` script through `pnpm run`: pnpm treats a bare `pnpm deploy` as its
own built-in command. `-y` skips the confirmation `convex deploy` asks for when `CONVEX_DEPLOYMENT`
names a dev deployment, which would fail in a shell that cannot prompt.

Then at once, on each controller host, update every running controller to the pin the new
deployment serves, from the staged file. The `--dry-run` line takes seconds, changes nothing, and
repeats the checks from [Before](#prove---update-will-find-the-controllers) with the new
installer:

```bash
v=0.2.0-rc.11
curl -fsSL https://<deployment>.convex.site/install | sudo bash -s -- --role controller --update \
  --source "file://$HOME/erainfra-controller-v$v/" --dry-run
curl -fsSL https://<deployment>.convex.site/install | sudo bash -s -- --role controller --update \
  --source "file://$HOME/erainfra-controller-v$v/"
```

The trailing `/` matters: with it, the installer reads `runner-center-controller-linux-arm64` on
`oracle-singapore-1` and `runner-center-controller-linux-x86_64` on an x86_64 host.

`--source` changes where the bytes come from, never which digest is accepted. `--update` restarts
exactly the instances that were running and rolls itself back if one fails its health check
([operate-the-controller-host.md](operate-the-controller-host.md#dedicated-host-install-and-update)).

## 3. Verify, in this order

1. **Each controller holds its lease.** `journalctl -u runner-center-controller@<profile> -n 50`
   shows `acquired controller lease`, then `runner scale-set controller started`. The dashboard's
   Profiles table shows each Profile listening.
2. **The dashboard loads and shows every Profile** with its isolation badge, Worker readiness and
   checks.
3. **Workers stay ready.** `rc logs -f` on a Worker shows `readiness: ready`, not schema errors.
4. **Run the canary.** Trigger EraInfra's `smoke` workflow (workflow dispatch) and wait for green.
   It exercises Attempt creation, `attemptSecrets`, claim and the in-job executor probes on the new
   code with real GitHub traffic. Post-job teardown remains a separate check.
5. **`/install` serves the new release.** The usage it prints lists this release's options:

   ```bash
   curl -fsSL https://<deployment>.convex.site/install | bash -s -- --role node --help
   ```

## 4. Roll back

A Convex deploy swaps the code and keeps the data. Before it accepts a schema, Convex checks every
document already stored against it. So once the new release has written a field the old schema
does not declare, `profiles.githubConfigUrl` for example, a deploy of the old commit as it was is
refused at that check, and the rollback fails exactly when it is needed. The rollback branch from
[Before](#the-rollback-branch) carries the old functions with the new schema, so it deploys over
anything the new release wrote. Old functions never read the new fields, and every new field is
optional, so the old code behaves as it did.

### When a rollback to v0.2.0-rc.10 is safe

v0.2.0-rc.10 has no `convex/infra/`: no Node API, no deploy pipeline, no failover, no operator API.
Every Node running `connect-convex` and every gateway Node depends on it. Rolled back under them,
running Apps and gateway routes keep serving their last state (as when
[Convex is unreachable](../infra-management.md#when-convex-is-unreachable)), but nothing deploys,
fails over, changes env or links, or updates a route, and the `erainfra` CLI and the dashboard's
Nodes, Apps, Deployments and Links pages stop working. So the rule depends on how far
[retire-the-hub.md](retire-the-hub.md) has gone:

- **Before its step 2** (no Node runs `connect-convex`): roll back as below.
- **After step 2, before step 5** (only the gateway Nodes run `connect-convex`; the Hub still
  serves every App): first put the gateway Nodes back in Hub mode
  ([Roll back to Hub mode](../infra-management.md#roll-back-to-hub-mode)), then roll back as below.
- **From step 5 on**: first run [retire-the-hub.md, Roll back](retire-the-hub.md#roll-back) in full,
  so every Node is in Hub mode and `*.<zone>` points at the Hub again. Then roll back as below.

If the Apps cannot take that, do not roll the control plane back: fix forward with a new release.

### Order and commands

Deploy first, then move the controllers. The deploy is the step that can be refused; while it has
not succeeded, the new backend and the new controllers still work together, so a refused deploy
leaves CI running. Once it succeeds, the new controllers cannot talk to the old backend, so revert
them at once.

1. Deploy the rollback branch from its worktree:

   ```bash
   cd ../erainfra-rollback/packages/backend
   npx convex deploy -y
   pnpm run deploy --skip-convex
   ```

   If `npx convex deploy` is refused with a schema validation error naming a table or field, stop
   here: nothing changed, and CI still runs on the new release. The branch is missing part of the
   new schema. Add that declaration from `v$new`, check the branch again, and deploy again.

2. On each controller host, put back the binary and unit `--update` kept, and restart the
   instances that should run:

   ```bash
   sudo install -m 0755 /usr/local/lib/runner-center/runner-center-controller.bak-<old version> \
     /usr/local/lib/runner-center/runner-center-controller
   sudo cp -p /etc/systemd/system/runner-center-controller@.service.bak-<old version> \
     /etc/systemd/system/runner-center-controller@.service
   sudo systemctl daemon-reload
   sudo systemctl restart 'runner-center-controller@<profile>'
   ```

Then cancel and retry any Attempt created during the window. Attempts already claimed or running
are unaffected. If the previous backend predates the controller lease, the previous controller
binary is the only one that works with it, and the reverse holds too; never leave one side rolled
back alone.

## 5. Agent pins

Installed Worker agents and Infra Agents do not update themselves. After the deploy, `/install`
serves the new pins:

- Workers: `rc update` on each Worker fetches the release this deployment pins, verifies it and
  swaps atomically. Re-running `/install --role worker-host` to update the Firecracker runtime
  refuses while any Firecracker VM runs, including the idle warm VMs the runtime keeps parked:
  drain the Worker first, as the refusal and
  [firecracker-cutover.md](firecracker-cutover.md#2-provision-the-worker-host) say.
- Nodes: re-run the `/install --role node …` command the Node was installed with. A `--convex`
  Node can pass `--credential-file /etc/erainfra-node.credential`, the copy the installer keeps.

Until a machine is updated it runs the previous release's behaviour; the canary makes that drift
visible.
