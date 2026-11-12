import { cronJobs } from "convex/server";

import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("reconcile runner state", { seconds: 60 }, internal.reconcile.run, {});

// Off unless ERAINFRA_STRANDED_JOB_ACTION is cancel or rerun; then it acts on jobs routed to a
// Profile that lost every ready Worker (strandedJobs.ts).
crons.interval("recover stranded jobs", { minutes: 1 }, internal.strandedJobs.scan, {});

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

// The actions/runner release list behind the runner-release-expiring alert. Hourly, but the action
// asks GitHub only once its list is six hours old, so a failed fetch is retried within the hour.
crons.interval(
  "refresh actions/runner releases",
  { hours: 1 },
  internal.github.refreshRunnerReleases,
  {},
);

// Per-Attempt resource series are kept 14 days after their last upload. Hourly keeps each run's
// batch small; the purge reschedules itself while it finds full batches.
crons.interval(
  "purge expired Attempt metrics",
  { hours: 1 },
  internal.attemptMetrics.purgeExpired,
  {},
);

// JUnit results are kept 30 days, and a flaky test not seen for 30 days drops off the list.
crons.interval("purge expired test results", { hours: 1 }, internal.testReports.purgeExpired, {});

// `/runs-on` decisions are kept 90 days. Hourly keeps each run's batch small; the purge
// reschedules itself while it finds full batches.
crons.interval(
  "purge expired router decisions",
  { hours: 1 },
  internal.routerDecisions.purgeExpired,
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

// The deploy pipeline's clock (infra/pipeline.ts): starts queued runs whose App is free, renews
// the lease of every live run and applies step timeouts. A Node's report moves its run at once;
// this is the fallback, and with nothing in flight it is a few indexed reads.
crons.interval("advance App deploy runs", { seconds: 10 }, internal.infra.pipeline.pulse, {});

// Failover for connect-convex Nodes (infra/failover.ts), decided from missed heartbeats.
crons.interval("fail over silent Nodes", { seconds: 10 }, internal.infra.failover.check, {});

export default crons;
