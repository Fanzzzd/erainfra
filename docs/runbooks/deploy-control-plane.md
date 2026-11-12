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
  that does not carry the Profile's lease epoch (`controllerLease.ts`), with no legacy bypass. Each
  release pins its own controller binary, and nothing tests a backend against another release's
  controller. So the controller update runs in the same window as the deploy, and a rollback moves
  both back together.

## Check which deployment the CLI reaches

Every `npx convex` command below finds the Convex project through `packages/backend/.env.local`.
On the owner's machine that file names a dev deployment (`CONVEX_DEPLOYMENT=dev:…`), not
production. `npx convex deploy` targets the project's production deployment anyway. Every other
command (`env`, `run`, `data`) acts on the dev deployment unless it passes `--prod`, and the live
fleet never sees what it changes there. So every command below passes `--prod`. Add it to any
`npx convex` command you type yourself. Other runbooks that run `npx convex` start with the check
in this section.

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
deployment the fleet talks to: on each controller host,
`sudo grep -h CONVEX /etc/runner-center/profiles/*.env` shows `https://<name>.convex.site`
for every Profile. If the name differs, or `env list --prod` shows no `CONTROLLER_TOKEN`, stop:
`.env.local` belongs to another project. Each `env set --prod` ends its output with
`(on prod deployment <name>)`; check that it names the same deployment.

## 1. Before

`<tag>` below is the tag of the release you deploy, `v<version>`. `<previous tag>` is the tag of
the release production serves now. `/install` prints that version, without the leading `v`:

```bash
curl -fsSL https://<deployment>.convex.site/install | grep -m1 '^PINNED_VERSION='
```

Check the release out in a clean worktree, from the checkout you deploy from today:

```bash
main=$PWD                                              # this checkout, whose packages/backend/.env.local finds the project
new=<tag>                                              # the release you deploy
old=<previous tag>                                     # the release production serves now
git fetch --tags origin
git worktree add ../erainfra-release "$new"
cd ../erainfra-release
cp "$main/packages/backend/.env.local" packages/backend/
grep -n 'version:' packages/backend/convex/agentRelease.ts
pnpm install --frozen-lockfile
pnpm check                                             # green on the commit you deploy
```

The `version` must be the tag's, without the leading `v`.

### The rollback branch

A plain checkout of the release production runs now cannot be deployed over the new one
([Roll back](#4-roll-back) says why). Its rollback is a branch with the old functions on the new
schema, and it must exist and pass its checks before the window.

The branch is `rollback/$old-on-$new-schema`. If it already exists, its commit message names the
commit its schema came from and the modules it took. Confirm the tag's schema is still that one:
`git diff --stat <that commit> "$new" --` over `packages/backend/convex/schema.ts` and each listed
module. No output means the branch is current. If it lists a file, redo the steps below on the
branch for what changed. Then check the branch out where the rollback will run from, and run its
checks:

```bash
cd "$main"
git worktree add ../erainfra-rollback "origin/rollback/$old-on-$new-schema"
cd ../erainfra-rollback
cp "$main/packages/backend/.env.local" packages/backend/
pnpm install --frozen-lockfile && pnpm check           # green: old functions, new schema
pnpm --filter @erainfra/dashboard build && rm -rf apps/dashboard/dist
cd "$main"
```

If the branch does not exist, build it:

1. `git worktree add -b "rollback/$old-on-$new-schema" ../erainfra-rollback "$old"`, then copy
   `.env.local` in as above.
2. `git checkout "$new" -- packages/backend/convex/schema.ts`.
3. Follow every relative import of `schema.ts`, and of each module it brings in, except
   `import type`. For each module:
   - The old release lacks it, and it defines no Convex function (no `query(`, `mutation(`,
     `action(`, `httpAction(` or `internal…(`): take it from `$new`.
   - It would bring in functions, or a module the old functions already use: copy only the
     validators `schema.ts` needs into `schema.ts`, verbatim.
   - The old release has it and its exported validators match `$new`'s: keep the old copy, so the
     old functions behave as they did.
4. Add each module you took to `packages/backend/convex/_generated/api.d.ts`, in the order
   `convex codegen` uses (byte order of the path). Codegen itself needs a deployment.
5. In the root `package.json`, `deploy:control-plane` must be
   `pnpm --filter @erainfra/backend run deploy`. Without `run`, pnpm runs its own `deploy`.
6. `pnpm install --frozen-lockfile && pnpm check`, build the dashboard as above, and commit with a
   message that names the commit of `$new` the schema came from and every module you took. Then
   `git push origin "rollback/$old-on-$new-schema"`. Never merge it into `main`.

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

On exit 3, read the labels the controllers really use, on each controller host:

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
instance as `runner-center-controller` with `/etc/runner-center/profiles/<profile>.env`. A
controller installed by hand can differ. Check each controller host before the window. Everything
here only reads:

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

On each controller host you expect the old version, an account line, and exactly one
`runner-center-controller@<profile>.service` line for each Profile the host runs, each
with `fragment=/etc/systemd/system/runner-center-controller@.service`, no drop-ins and `env=ok`.
Anything else means `--update` would miss that controller or fail to start it, and roll back. Fix
it before the window, or plan the dedicated-host install from
[operate-the-controller-host.md](operate-the-controller-host.md#dedicated-host-install-and-update)
for it. The `--dry-run` in [step 2](#2-deploy-and-update-the-controllers-in-the-same-window)
runs these checks again with the new installer.

### Stage the controller

Stage the new controller binary on every controller host, so the window does not wait on a
download. The release names each binary by its target, and on ARM `uname -m` does not print the
target: an `aarch64` host takes `linux-arm64`, an `x86_64` host `linux-x86_64`.
So an aarch64 `<controller-host>` takes `runner-center-controller-linux-arm64`. Take the
binary from the GitHub Release of the tag and check it against the pin on the release commit:

```bash
new=<tag>
case "$(uname -m)" in
  x86_64) target=linux-x86_64 ;;
  aarch64) target=linux-arm64 ;;
  *) target=none ;;
esac
asset=runner-center-controller-$target; echo "$asset"   # an aarch64 host: runner-center-controller-linux-arm64
mkdir -p ~/erainfra-controller-$new && cd ~/erainfra-controller-$new
curl -fsSLO "https://github.com/Fanzzzd/erainfra/releases/download/$new/$asset"
pin=$(curl -fsSL "https://raw.githubusercontent.com/Fanzzzd/erainfra/$new/packages/backend/convex/agentRelease.ts" |
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
new=<tag>
curl -fsSL https://<deployment>.convex.site/install | sudo bash -s -- --role controller --update \
  --source "file://$HOME/erainfra-controller-$new/" --dry-run
curl -fsSL https://<deployment>.convex.site/install | sudo bash -s -- --role controller --update \
  --source "file://$HOME/erainfra-controller-$new/"
```

The trailing `/` matters: with it, the installer reads `runner-center-controller-linux-arm64` on
an aarch64 host and `runner-center-controller-linux-x86_64` on an x86_64 host.

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

### When a rollback is safe

The rollback branch reaches one release back: `<previous tag>`'s functions on `<tag>`'s schema. It
works within one schema-compatible release, so build and check it for every deploy. A rollback
further back needs its own branch for that pair of releases.

The old functions do not serve anything `<tag>` added. A Node, gateway Node, `erainfra` CLI command
or dashboard page that calls a function `<previous tag>` lacks stops working until the next deploy.
Running Apps and gateway routes keep serving their last state, as when
[Convex is unreachable](../infra-management.md#when-convex-is-unreachable), but whatever needs the
missing function does not deploy, fail over or change. Read the release's CHANGELOG for new Node and
operator functions before the window. If the fleet cannot take that, do not roll the control plane
back: fix forward with a new release.

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
   new schema. Add that declaration from `$new`, check the branch again, and deploy again.

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
are unaffected. Never leave the backend or the controllers rolled back alone.

## 5. Agent pins

Installed Workers and Infra Agents do not update themselves. After the deploy, `/install`
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
