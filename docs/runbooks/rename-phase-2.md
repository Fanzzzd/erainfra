# EraInfra machine-side rename (phase 2)

Phase 1 changes the product, repository, workspace package scope, and future Agent archive name. It
deliberately leaves every name already installed on a machine unchanged. Phase 2 must be a fleet
migration with a compatibility window, not a repository-wide search and replace.

## Compatibility contract entering phase 2

Existing `rc.3` and `rc.4` installations can depend on all of these names:

- the `rc` command, `RC_*` environment variables, and `~/.runner-center` Worker state;
- `runner-center-agent.service`, `center.runner.agent`, and their systemd/launchd files;
- `runner-center-controller@<profile>`, the `runner-center-controller` account, and
  `/etc/runner-center/profiles/<profile>.env`;
- runtime/controller/guest binary names and paths under `/usr/local/lib/runner-center`;
- the guest/runtime `RUNNER_CENTER_RESULT` console protocol marker;
- `/etc/runner-center`, `/var/lib/runner-center`, `/opt/runner-center`, the runtime socket, service,
  group, containerd namespace, CNI state, thin-pool, and nftables names;
- the current `runner-center-*` image and non-Agent release asset names; and
- the `/install`, `/agents/*`, `/controller/*`, and other routes declared in `convex/http.ts`.

Do not rename the Convex deployment, tables, or function modules as part of this migration. They do
not live on fleet machines, and coupling their migration to host identity adds risk without benefit.

## Required sequence

### 1. Ship a dual-name release

The first phase-2 release must read both the proposed EraInfra names and every legacy name above.
For environment variables, accept `ERAINFRA_*` first and fall back to the corresponding `RC_*`
value; if both are present with different values, fail with the conflicting variable names instead
of choosing silently. Keep writing the legacy layout during this release so rollback remains safe.

Publish both CLI entry points from the same implementation, with `rc` retained as the stable
operator path. Add new HTTP paths only as aliases over the same handlers, and keep the old paths for
at least the full support lifetime of the last legacy Agent and Controller release.

The service compatibility layer must never permit two daemons for one machine. A new unit may have
the legacy systemd name as an alias, but start/restart logic must detect either name, select the one
already active, and prove the other is inactive. Apply the same rule to the launchd label and to
each Controller Profile.

### 2. Upgrade Workers through `rc update`

Use the command already present on every Worker:

```bash
rc update
rc status
rc doctor
```

The update installs the dual-name release while leaving `~/.runner-center`, the `rc` command, and
the active legacy service identity in place. Confirm the exact installed version, a fresh Agent
connection, Profile readiness, and successful job execution before attempting any name cutover.

Only a later, explicit migration command should move state. Stop the Agent, atomically rename the
state directory to its new location, and leave `~/.runner-center` as a compatibility symlink to the
new directory. Install the new service identity without enabling it first, stop/disable the legacy
identity, start the new identity, and assert that exactly one process is connected. On any failed
check, stop the new identity, restore the old service and directory orientation, and restart the
legacy Agent.

Keep `rc` available throughout the compatibility window even if a new command alias is introduced.
Remove it only in a separately announced major migration after fleet inventory shows no callers.

### 3. Swap Controller environments one Profile at a time

First upgrade the Controller binary in its existing path and restart
`runner-center-controller@<profile>` so the running code understands both environment namespaces.
Then, for one Profile at a time:

1. copy each `RC_*` setting to its `ERAINFRA_*` equivalent with the same value and file ownership;
2. validate that duplicate values agree and that all referenced secret files are readable;
3. drain or otherwise prevent new work for the Profile, then stop the legacy unit;
4. move the environment file and binary only after installing the new unit disabled;
5. start the new unit and verify its scale-set listener, Convex heartbeat, and a canary job; and
6. re-enable scheduling only after the old unit is confirmed inactive.

Rollback reverses steps 4–5 and uses the still-present `RC_*` values. Do not remove legacy variables,
paths, accounts, or units until every Profile has remained healthy for the agreed observation
window.

### 4. Migrate privileged runtime names separately

Treat Firecracker runtime, containerd, CNI, nftables, group, and storage names as a second host
cutover after the Worker and Controller migration is stable. Drain the host completely before
moving them. Prefer aliases or bind/symlink compatibility for configuration and immutable binaries,
but never run old and new containerd/runtime units together or create a second thin-pool/network
namespace over live state. Validate `preflight`, `verify-network`, a Firecracker canary, and teardown
before returning the host to scheduling.

## Release and test gates

Every compatibility and cutover release keeps the existing tag = root/Agent/Controller/Runtime
versions = `AGENT_RELEASE.version` rule. Compute the deterministic Agent archive first, pin those
exact bytes in `AGENT_RELEASE.sha256`, then tag; the release workflow must rebuild twice and compare
byte-for-byte as it does today.

Before any fleet rollout, automate these paths on disposable hosts:

- legacy install -> `rc update` -> dual-name release, with state and registration preserved;
- legacy service active while both unit names exist, proving only one process starts;
- Worker state cutover and rollback in both directions;
- Controller environment/unit cutover and rollback for one Profile;
- old and new HTTP clients against the same backend handlers; and
- a fully drained Firecracker host runtime cutover and rollback.

The compatibility window ends only when inventory shows no legacy versions or active legacy units,
the old HTTP routes have seen no supported-client traffic for the observation window, and backups
have passed a restore drill. Removal of legacy readers, aliases, variables, paths, and `rc` is a
separate cleanup release, never part of the cutover release.
