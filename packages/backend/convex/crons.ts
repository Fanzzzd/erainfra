import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("reconcile runner state", { seconds: 60 }, internal.reconcile.run, {});

// Five minutes, not the six hours GitHub's own recipe suggests: a `queued`
// event recovered six hours late is usually worthless, because the workflow it
// belongs to has been sitting in GitHub's queue toward its 24-hour cancellation
// the whole time. The run is cheap when there is nothing to do — one query and
// no network on a deployment with no App, none at all while the circuit breaker
// is open — so the short interval buys latency rather than load.
crons.interval(
  "recover lost webhook deliveries",
  { minutes: 5 },
  internal.github.recoverLostDeliveries,
  {},
);

// Alert rules from the dashboard. A query reads fleet state and computes breaches, then a mutation
// that touches only the alert tables advances incidents and enqueues notifications, which are sent
// by their own scheduled actions. With no enabled rule the run is one indexed read and a
// retention sweep.
crons.interval("evaluate alert rules", { minutes: 1 }, internal.alerts.evaluate, {});

// Per-Attempt resource series are kept 14 days after their last upload. Hourly keeps each run's
// batch small; the purge reschedules itself while it finds full batches.
crons.interval(
  "purge expired Attempt metrics",
  { hours: 1 },
  internal.attemptMetrics.purgeExpired,
  {},
);

// App deploy runs whose lease lapsed can never finish; mark them failed so pollers see a terminal
// state. This replaces the Hub's failStale-at-boot. With no run in flight it is a few indexed reads.
crons.interval(
  "fail stale App deploy runs",
  { minutes: 1 },
  internal.infra.deployments.sweepStale,
  {},
);

export default crons;
