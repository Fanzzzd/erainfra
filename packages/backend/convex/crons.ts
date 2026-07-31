import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("reconcile runner state", { seconds: 60 }, internal.reconcile.run, {});

export default crons;
