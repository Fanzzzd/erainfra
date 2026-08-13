# Runbook: deploy the control plane without losing capability

The production Convex deployment schedules live CI. Deploying it is one command, but it swaps
the scheduler, the worker API and the dashboard under running Workers, so treat it like a
cutover, not a push. This runbook exists because `main` currently carries several deployments'
worth of undeployed change (#27, #28, #30, #32) and each has a specific thing worth checking.

## Why this deploy is safe by construction

- **Old rows validate against the new schema.** Every field #32 moved to evidence tables is
  still `v.optional` in the hot validators, with a comment marking the one-cycle window, so
  Convex's deploy-time document validation passes on existing data.
- **Legacy data paths are tested, not assumed.** convex-test covers claiming a legacy inline
  `jitConfig` (and erasing it), reading a legacy inline benchmark, and machines with no slot
  policy. The scheduler's decisions are pinned byte-identical by a pre-refactor fixture.
- **Workers need no lockstep upgrade.** Agents on rc.3 keep reporting the legacy readiness
  shape; the control plane accepts it and converges each row to the new shape on the Worker's
  next report (≤6 h healthy, 5 min unhealthy).

## 1. Before

```bash
git log --oneline origin/main -3   # know exactly what you are deploying; note the commit
pnpm check                          # green on the commit you deploy
```

Confirm the canary is green: the `smoke` workflow in `rc-e2e-smoke` runs daily against the
live fleet and on demand via workflow dispatch. A green run within 24 h means the current
deployment schedules and tears down jobs correctly — your pre-deploy baseline.

Pick a quiet window: running Attempts are not interrupted by a deploy, but scheduling
decisions made mid-deploy land on whichever code version answers.

## 2. Deploy

```bash
pnpm deploy
```

## 3. Verify, in this order

1. **Dashboard loads and shows every Profile** with its isolation badge, worker readiness and
   checks (proves #27 against production data).
2. **Workers stay ready.** Within one readiness cycle each Worker's row converges to the new
   compact shape. `rc logs -f` on a Worker shows `readiness: ready`, not schema errors.
3. **Run the canary now** — trigger `smoke` in `rc-e2e-smoke` (workflow dispatch) and wait for
   green. This exercises attempt creation → `attemptSecrets` → claim → teardown on the new
   code with real GitHub traffic.
4. **Bandwidth actually drops.** In the Convex dashboard's usage page, `tryAssign`,
   `pendingAttempts` and `reconcile.run` should fall from GB-scale to MB-scale within a day.
   If they do not, the range reads are not being hit — investigate before assuming success.
5. After ~24 h, spot-check a `workerReadiness` row: the legacy fat fields should be gone from
   hot rows (the one-cycle window closed). That green-lights the follow-up PR that tightens
   the validators.

## 4. Roll back

Convex deploys are code swaps; data written in between stays. The new code only _adds_
optional fields and one table, so the previous code reads post-deploy data correctly — with
one exception: Attempts created by the new code keep credentials in `attemptSecrets`, which
old code cannot claim.

```bash
git checkout <previous-commit> && pnpm deploy
```

Then cancel and retry any Attempt created during the window (retry creates a new Attempt, and
the old code writes the inline shape it can read). Attempts already claimed or running are
unaffected either way.

## 5. Agent pin

This deploy also moves the served agent pin to rc.4 (`agentRelease.ts`). Installed agents
update only when they next check, verify the archive against the pinned sha256, and swap
atomically; a failed verification leaves the current install untouched.
