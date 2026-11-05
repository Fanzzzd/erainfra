# ADR 0014: Controllers run on the Workers, under a lease

- Status: Accepted; implementation in progress (until it lands, controllers run as ADR 0013 describes)
- Date: 2026-11-05
- Owners: EraInfra
- Supersedes: [ADR 0013](0013-run-controllers-off-the-workers.md)

## Context

[ADR 0013](0013-run-controllers-off-the-workers.md) put each Profile's controller on a host that is
not a Worker, for four reasons: demand intake should survive a Worker rollout, Workers should stay
interchangeable, the controller's GitHub long-poll should not share a Worker's uplink, and the
machine that runs untrusted jobs should hold fewer secrets. In practice that host is one
hand-provisioned VM serving every Profile. It is a server the owner has to keep, patch and pay for,
nothing alerts when it dies, and on Oracle's Always Free tier an idle VM of exactly this profile can
be reclaimed.

The owner's goal is the fewest servers that are not doing jobs. Convex already hosts the control
plane, the scheduler, the dashboard and authentication without a server of the owner's. The
controller is the only remaining component that needs one.

Each of ADR 0013's reasons is really about a property, not a place:

1. Intake surviving a Worker rollout needs _some other_ process to take over, not a separate host.
   GitHub keeps queued jobs and re-offers them to the next session, so a short gap delays jobs and
   loses none.
2. Interchangeable Workers need every Worker able to serve, not none of them.
3. A bad uplink should not hold intake, which a takeover rule can express.
4. Fewer secrets on a job host is achieved by not giving the job host long-lived secrets.

## Decision

Every Worker may run a standby controller for each Profile it serves. Exactly one of them, the
**lease holder**, holds GitHub's scale-set session for that Profile at a time. Convex is the
arbiter.

1. **Lease.** Convex keeps one lease row per Profile: holder (machine and process instance), expiry,
   and an `epoch` that increases on every change of holder. A standby asks for the lease; Convex
   grants it when it is free or expired. The holder renews it every 10 seconds with a 30-second
   expiry. A holder that fails to renew, or learns it has lost the lease, closes its scale-set
   session and stops creating Attempts at once.
2. **Fencing.** Every controller write to Convex (create, cancel or update an Attempt, job started,
   job completed, heartbeat) carries the holder's epoch, and Convex refuses a write with a stale
   one. A paused or partitioned former holder therefore cannot act on a Profile it no longer owns,
   even before it notices. The lease alone cannot promise that; the epoch check can.
3. **The GitHub session stays single-owner.** GitHub refuses a second message session for a scale
   set with `409`. A new holder whose predecessor died without closing its session retries with
   backoff until GitHub lets the old session go. The lease and GitHub's own check are two
   independent guards against two listeners.
4. **Who takes the lease.** Any Worker that is ready for the Profile may. A Worker whose fresh
   benchmark rates its network to GitHub poorly waits longer before asking, so a better-connected
   Worker wins when there is one, and a lone Worker still serves.
5. **No long-lived controller secrets on Workers.** The lease holder authenticates to Convex with
   its own machine credential, which Convex accepts for controller routes only while that machine
   holds the Profile's lease. It obtains GitHub credentials from Convex as a short-lived GitHub App
   installation token for the Profile's scale-set URL, renewed before expiry. The App's private key
   and the shared `CONTROLLER_TOKEN` stay in Convex. A compromised Worker host can act as the
   controller of the Profiles it already serves, for as long as it holds their leases, and nothing
   more.
6. **A dedicated controller host is still allowed.** A machine enrolled for the controller role only
   competes for leases like any Worker. Existing per-Profile env files and units keep working
   during migration; a unit started with `CONTROLLER_TOKEN` behaves as a permanent lease candidate.

## Consequences

- The minimum deployment is Convex plus the Workers. The controller VM can be retired once a Worker
  has held each Profile's lease through a rollout.
- The controller's heartbeat (who holds the lease, since when, last GitHub message) is the liveness
  signal the dashboard, `/metrics` and the "controller silent" alert read.
- A Worker reboot with no other Worker hands the lease to nobody until it is back. That is a delay,
  not a loss: GitHub re-offers queued jobs, and the `/runs-on` router, which runs in Convex, still
  sends new runs to a GitHub-hosted fallback while no Worker is ready.
- Convex becomes the controller's identity provider for GitHub, so its GitHub App key handling must
  meet the same bar as the controller's did: stored server-side only, never returned to a client,
  minted into installation tokens scoped to the Profile's repository or organization.
- Moving a live Profile from the VM to the Workers is an operator step. Install the controller role
  on the Worker, watch it stand by, stop the VM's unit, and confirm the Worker takes the lease and
  the session.
