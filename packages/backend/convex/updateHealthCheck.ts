/**
 * The update health check both Worker installers run: `installScript.ts` (`--update`, bash) and
 * `installScriptPowerShell.ts` (`-Update`, Windows). Before an update replaces the Action Runner
 * Agent, the installer records which Profiles `GET /agents/readiness` (answered by
 * `workerApi.readiness`) reports `ready`. After the restart, each of them must report `ready` again
 * from a check made after the old Agent stopped, or the installer restores `agent.previous`.
 *
 * This module owns the two rules the installers share. Each renderer interpolates them, so the two
 * scripts cannot drift apart.
 */

/**
 * How long an update waits for each Profile that was ready before it to report ready again. A
 * cached Image Release prepares in about a second, but ubuntu0 took about 3 minutes after the
 * v0.2.0-rc.22 update, and the runtime gives one warm-pool guest up to 15 minutes to boot
 * (`warmBootTimeout`), so 15 minutes rolls back a broken Agent without failing a slow healthy one.
 */
export const UPDATE_READY_TIMEOUT_SECONDS = 900;

/**
 * The installers' reader of the readiness answer, run by the Worker's own Node.js with the program
 * on stdin: `node - MODE FILE [SINCE PROFILE...]`. Stdin keeps it out of the argument list, where
 * Windows PowerShell 5.1 would strip its double quotes, and keeps bash from parsing it at all.
 *
 * - `now FILE` prints the control plane's clock, in milliseconds.
 * - `ready FILE` prints each ready Profile, one per line.
 * - `verdict FILE SINCE PROFILE...` judges the named Profiles on reports newer than SINCE
 *   (control-plane milliseconds) and prints `ready`, `fail <why>` or `wait <profile> <why>`. A
 *   named Profile this Worker no longer serves is not waited for.
 *
 * Both scripts quote it literally (bash in single quotes, PowerShell in a single-quoted here-string),
 * so it must not contain a single quote, and the PowerShell script must stay pure ASCII.
 */
export const UPDATE_READINESS_JS = String.raw`const fs = require("node:fs");
const [mode, file, since, ...wanted] = process.argv.slice(2);
const answer = JSON.parse(fs.readFileSync(file, "utf8"));
const profiles = Array.isArray(answer.profiles) ? answer.profiles : [];
if (mode === "now") {
  if (!Number.isFinite(answer.now)) process.exit(1);
  process.stdout.write(String(Math.trunc(answer.now)));
} else if (mode === "ready") {
  for (const row of profiles) if (row.state === "ready") process.stdout.write(row.profile + "\n");
} else {
  const why = (row) => {
    const reasons = Array.isArray(row.failedChecks) ? row.failedChecks.slice() : [];
    if (reasons.length === 0 && typeof row.detail === "string") reasons.push(row.detail);
    return reasons.length === 0 ? "" : ": " + reasons.join("; ");
  };
  let verdict = "ready";
  for (const name of wanted) {
    const row = profiles.find((candidate) => candidate.profile === name);
    if (row === undefined) continue;
    const fresh = typeof row.checkedAt === "number" && row.checkedAt > Number(since);
    if (fresh && row.state === "ready") continue;
    if (fresh && (row.state === "degraded" || row.state === "failed")) {
      verdict = "fail Profile " + name + " reported " + row.state + why(row);
      break;
    }
    if (verdict === "ready") {
      verdict = fresh
        ? "wait " + name + " it last reported " + row.state + why(row)
        : "wait " + name + " it has not reported since the Agent restarted";
    }
  }
  process.stdout.write(verdict + "\n");
}`;
