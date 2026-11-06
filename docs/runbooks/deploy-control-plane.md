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

## 1. Before

Pick the release and check it out in a clean worktree:

```bash
git fetch --tags origin
git worktree add ../erainfra-release v0.2.0-rc.11      # the tag you are deploying
cd ../erainfra-release
grep -n 'version:' packages/backend/convex/agentRelease.ts
pnpm install --frozen-lockfile
pnpm check                                             # green on the commit you deploy
```

The `version` must be the tag's. `mesh` and `controller` in `AGENT_RELEASE` must not be empty if
you will install Nodes with `--convex` or update controllers; an empty map makes `/install` refuse
that role.

Note the release production runs now, and build its rollback branch before the window
([Roll back](#4-roll-back) says why a plain checkout of it cannot be deployed). `--update` keeps
each controller host's old binary and unit as `.bak-<old version>` files, so those need no note.

```bash
old=0.2.0-rc.10; new=0.2.0-rc.11                     # production now, and the release you deploy
git worktree add -b "rollback/v$old-on-v$new-schema" ../erainfra-rollback "v$old"
cd ../erainfra-rollback
git checkout "v$new" -- packages/backend/convex/schema.ts
grep -n '^import' packages/backend/convex/schema.ts   # the modules its validators come from
```

Make the old code compile against the new schema. For each module `schema.ts` imports that the old
release lacks, or has without an export the schema uses, check out the new release's copy too
(`git checkout "v$new" -- packages/backend/convex/<module>`). If that breaks old code that imports
the same module, copy just the validators the schema needs into `schema.ts` instead. Then:

```bash
pnpm install --frozen-lockfile && pnpm check           # green: old functions, new schema
git commit -m "chore(rollback): v$old functions on the v$new schema"
git push origin "rollback/v$old-on-v$new-schema"
cd - >/dev/null
```

The branch is the rollback. Nothing in it is new code: the functions are the old release's, and
the schema only declares more tables and optional fields than the old one did.

Stage the new controller binary on every controller host, so the window does not wait on a
download. Take it from the GitHub Release of the tag and check it against the pin on the release
commit:

```bash
v=0.2.0-rc.11
curl -fsSLO "https://github.com/Fanzzzd/erainfra/releases/download/v$v/runner-center-controller-linux-x86_64"
sha256sum runner-center-controller-linux-x86_64   # must equal controller["linux-x86_64"] in agentRelease.ts
```

Confirm the EraInfra `smoke` workflow is green; it runs daily against the live fleet and on demand
via workflow dispatch. Pick a quiet window: running Attempts are not interrupted by a deploy, but
scheduling decisions made mid-deploy land on whichever code version answers, and GitHub queues new
jobs while the controllers restart.

List Profiles whose scale-set labels overlap (ADR 0017). The check is read-only and needs no
function on the deployment, so it works against the backend you are about to replace:

```bash
(cd packages/backend && npx convex data profiles --prod --limit 10000 --format jsonl) \
  | pnpm --filter @erainfra/backend --silent profile-label-conflicts
```

`npx convex data` reads the deployment from `packages/backend`'s `.env.local`, so it runs there,
not from the repository root.

Exit 0 means no pair. A pair it lists keeps registering after the deploy, but GitHub can run
either Profile's jobs on the other, and the new backend raises it in `erainfra profiles list`, the
Profiles table, `erainfra_profile_label_conflicts` and the _Profiles' scale-set labels overlap_
alert. Fix it by removing the other Profile's name from one side's `ERAINFRA_LABELS` and
restarting that controller.

## 2. Deploy, and update the controllers in the same window

From the release worktree:

```bash
pnpm run deploy:control-plane
```

The script calls the backend's `deploy` script through `pnpm run`, because pnpm 11 treats a bare
`pnpm deploy` as its own built-in command. The inner `convex deploy` asks for confirmation when
`CONVEX_DEPLOYMENT` names a dev deployment, and it fails in a shell that cannot prompt. In that case
run the two halves yourself from `packages/backend`: `npx convex deploy -y`, then
`pnpm run deploy --skip-convex` to build and upload the dashboard.

Then at once, on each controller host, update every running controller to the pin the new
deployment serves, from the staged file:

```bash
curl -fsSL https://<deployment>.convex.site/install | sudo bash -s -- --role controller --update \
  --source "file://$PWD/runner-center-controller-linux-x86_64"
```

`--source` changes where the bytes come from, never which digest is accepted. `--update` restarts
exactly the instances that were running and rolls itself back if one fails its health check
([operate-the-controller-host.md](operate-the-controller-host.md#dedicated-host-install-and-update)).
A controller that was not installed by `/install --role controller` has nothing for `--update` to
update; install it with the dedicated host command in that runbook instead.

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
[Before](#1-before) carries the old functions with the new schema, so it deploys over anything the
new release wrote. Old functions never read the new fields, and every new field is optional, so
the old code behaves as it did. Roll back the backend and the controllers together, in one window:

1. On each controller host, put back the binary and unit `--update` kept, and restart the
   instances that should run:

   ```bash
   sudo install -m 0755 /usr/local/lib/runner-center/runner-center-controller.bak-<old version> \
     /usr/local/lib/runner-center/runner-center-controller
   sudo cp -p /etc/systemd/system/runner-center-controller@.service.bak-<old version> \
     /etc/systemd/system/runner-center-controller@.service
   sudo systemctl daemon-reload
   sudo systemctl restart 'runner-center-controller@<profile>'
   ```

2. Deploy the rollback branch from its worktree:

   ```bash
   cd ../erainfra-rollback && pnpm install --frozen-lockfile && pnpm run deploy:control-plane
   ```

   If the push is refused with a schema validation error naming a table or field, the branch is
   missing part of the new schema: add that declaration from `v$new`, then deploy again.

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
