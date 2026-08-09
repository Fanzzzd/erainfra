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

export default crons;
