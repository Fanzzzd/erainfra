// Crons on the Cloudflare platform. There are no Cron Triggers: each due cron becomes a row in
// `_scheduled_functions`, and the runtime's one alarm runs it like any scheduled function.
// `_cron_state` keeps each cron's next run time.

import { jsonToConvex, type JSONValue, type Value } from "convex/values";

import { prefixRange } from "../store/keys.ts";
import type { Transaction } from "../store/store.ts";
import type { Modules } from "./runtime.ts";

export const CRON_STATE = "_cron_state";

export type CronSpec = { name: string; udfPath: string; args: Value; everyMs: number };

/** The crons the backend's crons.ts registers. Only interval schedules are supported yet. */
export function cronSpecs(modules: Modules): CronSpec[] {
  const crons = modules.crons?.default as
    | {
        crons: Record<
          string,
          { name: string; args: JSONValue[]; schedule: Record<string, unknown> }
        >;
      }
    | undefined;
  if (!crons) return [];
  return Object.entries(crons.crons).map(([name, spec]) => {
    const s = spec.schedule;
    if (s.type !== "interval") {
      throw new Error(
        `Cron "${name}": schedule type ${String(s.type)} is not supported on the Cloudflare platform yet`,
      );
    }
    const everyMs =
      ((s.seconds as number | undefined) ?? 0) * 1000 +
      ((s.minutes as number | undefined) ?? 0) * 60_000 +
      ((s.hours as number | undefined) ?? 0) * 3_600_000;
    return { name, udfPath: spec.name, args: jsonToConvex(spec.args[0] as JSONValue), everyMs };
  });
}

function cronState(tx: Transaction, name: string): Record<string, Value | undefined> | null {
  const row = tx
    .scan({
      table: CRON_STATE,
      index: "by_name",
      ...prefixRange([name]),
      desc: false,
      matches: () => true,
    })
    .next();
  return row.done ? null : row.value.doc;
}

/** When the next cron is due. A cron that has never run is due now. */
export function nextCronDue(tx: Transaction, specs: CronSpec[], now: number): number | null {
  let next: number | null = null;
  for (const spec of specs) {
    const state = cronState(tx, spec.name);
    const due = state ? (state.nextRun as number) : now;
    next = next === null ? due : Math.min(next, due);
  }
  return next;
}

/**
 * Turns each due cron into a scheduled function due now, in `scheduledTable`. Its next run moves
 * one interval past now, so a long outage runs a cron once, not once per missed interval (as on
 * Convex). The caller commits `tx`.
 */
export function enqueueDueCrons(
  tx: Transaction,
  specs: CronSpec[],
  now: number,
  scheduledTable: string,
): void {
  for (const spec of specs) {
    const state = cronState(tx, spec.name);
    if (state && (state.nextRun as number) > now) continue;
    tx.insertSystem(scheduledTable, {
      name: spec.udfPath,
      args: [spec.args],
      scheduledTime: now,
      state: { kind: "pending" },
    });
    if (state) tx.patchSystem(state._id as string, { nextRun: now + spec.everyMs });
    else tx.insertSystem(CRON_STATE, { name: spec.name, nextRun: now + spec.everyMs });
  }
}
