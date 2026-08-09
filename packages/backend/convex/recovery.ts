// Recovering webhook deliveries that never reached this deployment.
//
// GitHub does not retry a failed webhook delivery. A cold deployment, a 401
// during a secret rotation, or a response slower than ten seconds loses the
// event outright: no `webhookDeliveries` row is ever written, so
// `retryStalledDeliveries` — which only knows about rows — cannot help, and the
// workflow waits in GitHub's queue until it is cancelled 24 hours later.
//
// The repair is to ask GitHub which of its recent deliveries it recorded as
// failures and redeliver the ones we have no record of. The delivery GUID is
// constant across redeliveries and is the value GitHub sends as
// X-GitHub-Delivery, so `webhooks.recordDelivery` already treats a redelivery
// that races a late original as a duplicate.
//
// This module is deliberately free of Convex and Octokit imports, like policy.ts
// and retry.ts: every decision here is a total function of its arguments, and
// `runRecovery` reaches GitHub and the database only through injected callbacks.

import { summarizeError } from "./retry";

/**
 * How far back GitHub lets us look. Current documentation says deliveries are
 * viewable and redeliverable for "the past 3 days".
 *
 * `reconcile.DELIVERY_RETENTION_MS` must stay strictly greater than this — see
 * the comment there. A `webhookDeliveries` row that expired while GitHub could
 * still list its delivery would look "never received" to this module and be
 * redelivered, re-applying a stale `queued` event for a job that has long
 * finished.
 */
export const RECOVERY_WINDOW_MS = 3 * 24 * 60 * 60 * 1_000;

/**
 * Deliveries older than this are not worth recovering: GitHub cancels a job
 * that has been queued for 24 hours, so redelivering its `queued` event would
 * only provision a runner for work that no longer exists.
 */
export const MAX_RECOVERABLE_AGE_MS = 24 * 60 * 60 * 1_000;

/**
 * How far back the very first run looks. A deployment that has never run
 * recovery must not replay three days of dead events on boot, but an hour is
 * enough to catch the outage that was in progress while it was rolling out.
 */
export const RECOVERY_SEED_MS = 60 * 60 * 1_000;

/**
 * Rescan overlap. GitHub lists by delivery time, but a throttled delivery is
 * recorded when it is finally attempted, so the newest timestamp on one page is
 * not a hard boundary. Stepping the watermark back by ten minutes costs one
 * cheap re-examination and avoids stepping over a straggler.
 */
export const WATERMARK_OVERLAP_MS = 10 * 60 * 1_000;

/** GitHub's maximum for this endpoint. */
export const PER_PAGE = 100;

/** At most 300 deliveries examined per run — see `runRecovery` on truncation. */
export const MAX_PAGES = 3;

/** Redelivery requests per run, so one bad hour cannot spend the API budget. */
export const MAX_REDELIVERIES_PER_RUN = 20;

/**
 * Redelivery requests per GUID, ever. Some deliveries can never be accepted —
 * a payload `parseWorkflowJob` rejects, a signature from a retired secret — and
 * without a cap those would be re-requested on every run for three days.
 */
export const MAX_RECOVERY_ATTEMPTS = 3;

const RECOVERY_BACKOFF_MS = [60_000, 300_000, 1_800_000] as const;

/**
 * Circuit breaker for the run itself. A revoked App or a wrong private key must
 * not keep both sides busy every five minutes: this widens the gap to an hour.
 */
const RUN_BACKOFF_MS = [60_000, 300_000, 900_000, 3_600_000] as const;

/**
 * The fields of GitHub's `hook-delivery-item` this module uses. Named as GitHub
 * names them so an Octokit response satisfies it structurally.
 *
 * Note what is absent: the list endpoint returns no request payload and no
 * response payload, which is exactly why `GET /app/hook/deliveries/{id}` — the
 * one endpoint that does return both — is never called.
 */
export type DeliveryItem = {
  id: number;
  guid: string;
  delivered_at: string;
  status_code: number;
  event: string;
};

export type RecoveryCandidate = {
  guid: string;
  githubDeliveryId: number;
  event: string;
  deliveredAt: number;
  statusCode: number;
};

/** GitHub records any non-2xx as a failure, and 0 when it could not connect. */
export function isFailedDelivery(item: Pick<DeliveryItem, "status_code">) {
  return item.status_code < 200 || item.status_code >= 300;
}

/**
 * Reduce a listing to the deliveries worth redelivering.
 *
 * The load-bearing rule is step 1: a GUID with *any* successful attempt is
 * dropped, whatever its age or event. `/github/webhook` answers 200 "Ignored"
 * for a payload it cannot parse, which produces no `webhookDeliveries` row — so
 * "absent from the table" on its own would ask GitHub to redeliver those
 * forever. Grouping by GUID and requiring that nothing ever succeeded is what
 * makes absence a safe signal.
 */
export function selectRecoverable(
  items: readonly DeliveryItem[],
  opts: { now: number; scannedThrough: number },
): RecoveryCandidate[] {
  // 1. Every GUID GitHub ever delivered successfully, across the whole listing.
  const delivered = new Set<string>();
  for (const item of items) {
    if (!isFailedDelivery(item)) {
      delivered.add(item.guid);
    }
  }

  // 2. Failed attempts that are recent enough to still matter.
  const newest = new Map<string, RecoveryCandidate>();
  for (const item of items) {
    if (delivered.has(item.guid) || !isFailedDelivery(item)) continue;
    if (item.event !== "workflow_job") continue;

    const deliveredAt = Date.parse(item.delivered_at);
    if (!Number.isFinite(deliveredAt)) continue;
    if (deliveredAt <= opts.scannedThrough) continue;
    if (opts.now - deliveredAt > MAX_RECOVERABLE_AGE_MS) continue;

    // 3. One candidate per GUID: the most recent attempt is the one to retry.
    const previous = newest.get(item.guid);
    if (previous !== undefined && previous.deliveredAt >= deliveredAt) continue;
    newest.set(item.guid, {
      guid: item.guid,
      githubDeliveryId: item.id,
      event: item.event,
      deliveredAt,
      statusCode: item.status_code,
    });
  }

  // 4. Oldest first: those are closest to being cancelled by GitHub. The GUID
  //    tie-break keeps the slice deterministic when timestamps collide.
  return [...newest.values()]
    .toSorted((a, b) => a.deliveredAt - b.deliveredAt || a.guid.localeCompare(b.guid))
    .slice(0, MAX_REDELIVERIES_PER_RUN);
}

/**
 * The `cursor` of the `rel="next"` link, or undefined at the end of the list.
 * This endpoint paginates by cursor, not by page number.
 */
export function parseNextCursor(link: string | undefined): string | undefined {
  if (link === undefined || link.length === 0) {
    return undefined;
  }
  for (const part of link.split(",")) {
    const match = /^\s*<([^>]+)>\s*;\s*rel="?next"?/.exec(part);
    if (match === null) continue;
    try {
      const cursor = new URL(match[1]).searchParams.get("cursor");
      return cursor === null || cursor.length === 0 ? undefined : cursor;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** True once a page holds nothing newer than the watermark: stop paginating. */
export function pageIsExhausted(items: readonly DeliveryItem[], scannedThrough: number) {
  return items.every((item) => {
    const deliveredAt = Date.parse(item.delivered_at);
    return !Number.isFinite(deliveredAt) || deliveredAt <= scannedThrough;
  });
}

export function recoveryBackoffMs(attempts: number) {
  if (attempts <= 0) {
    return 0;
  }
  return RECOVERY_BACKOFF_MS[Math.min(attempts, RECOVERY_BACKOFF_MS.length) - 1];
}

export function nextRunDelayMs(consecutiveFailures: number) {
  if (consecutiveFailures <= 0) {
    return 0;
  }
  return RUN_BACKOFF_MS[Math.min(consecutiveFailures, RUN_BACKOFF_MS.length) - 1];
}

export type RecoveryRow = {
  attempts: number;
  nextAttemptAt: number;
  state: "requested" | "recovered" | "abandoned";
};

export type RecoveryDecision =
  | { kind: "request"; attempts: number; nextAttemptAt: number }
  | { kind: "skip" }
  | { kind: "abandon"; attempts: number; lastError: string };

/** What to do about one candidate, given whatever we already recorded for it. */
export function decideRecovery(existing: RecoveryRow | null, now: number): RecoveryDecision {
  if (existing === null) {
    return { kind: "request", attempts: 1, nextAttemptAt: now + recoveryBackoffMs(1) };
  }
  // Already settled: recovered needs nothing, abandoned is deliberate.
  if (existing.state !== "requested") {
    return { kind: "skip" };
  }
  if (now < existing.nextAttemptAt) {
    return { kind: "skip" };
  }

  const attempts = existing.attempts + 1;
  if (attempts > MAX_RECOVERY_ATTEMPTS) {
    return {
      kind: "abandon",
      attempts: existing.attempts,
      lastError: `GitHub accepted ${existing.attempts} redelivery requests but the delivery never arrived`,
    };
  }
  return { kind: "request", attempts, nextAttemptAt: now + recoveryBackoffMs(attempts) };
}

/**
 * The HTTP status an error carries, or 0. Reads the field structurally so this
 * module does not have to import Octokit's RequestError.
 */
export function statusOf(error: unknown): number {
  if (typeof error === "object" && error !== null && "status" in error) {
    const { status } = error as { status: unknown };
    if (typeof status === "number" && Number.isFinite(status)) {
      return status;
    }
  }
  return 0;
}

/**
 * What an operator is told about a failed GitHub call: a status code, never a
 * response body. Octokit folds GitHub's response into `error.message`, so any
 * error that carries a status is summarised by its number alone. Errors without
 * one came from this process, not from GitHub, and their message is ours to
 * show.
 */
export function describeRecoveryFailure(error: unknown, action: string) {
  const status = statusOf(error);
  if (status > 0) {
    return `GitHub responded ${status} while ${action}`;
  }
  return summarizeError(
    error instanceof Error
      ? `Could not reach GitHub while ${action}: ${error.message}`
      : `Could not reach GitHub while ${action}`,
  );
}

/** Keep a stale watermark inside the window GitHub can still redeliver from. */
export function clampWatermark(previous: number, now: number) {
  return Math.min(Math.max(previous, now - RECOVERY_WINDOW_MS), now);
}

/** Where the next scan starts after a complete one. Never moves backwards. */
export function advanceWatermark(previous: number, newestDeliveredAt: number, now: number) {
  return clampWatermark(Math.max(previous, newestDeliveredAt - WATERMARK_OVERLAP_MS), now);
}

export type RecoveryOutcome = "ok" | "skipped-no-app" | "skipped-backoff" | "error";

export type FinishRecoveryRun = {
  now: number;
  outcome: "ok" | "skipped-no-app" | "error";
  /** Absent means the scan was incomplete, so the watermark must not advance. */
  newestDeliveredAt?: number;
  listed: number;
  missing: number;
  requested: number;
  error?: string;
};

/** The two GitHub calls, injected so the orchestration can be tested offline. */
export type RecoveryClient = {
  listDeliveries: (
    cursor: string | undefined,
  ) => Promise<{ items: DeliveryItem[]; nextCursor: string | undefined }>;
  redeliver: (githubDeliveryId: number) => Promise<void>;
};

export type RecoveryDeps = {
  now: () => number;
  reconcile: (now: number) => Promise<{ recovered: number; abandoned: number }>;
  begin: (now: number) => Promise<{ run: false } | { run: true; scannedThrough: number }>;
  /** Null when no GitHub App is configured — the legacy PAT cannot mint a JWT. */
  openClient: () => Promise<RecoveryClient | null>;
  missingGuids: (guids: string[]) => Promise<string[]>;
  claim: (
    now: number,
    candidates: RecoveryCandidate[],
  ) => Promise<{ guid: string; githubDeliveryId: number }[]>;
  settle: (guid: string, ok: boolean, error?: string) => Promise<void>;
  finish: (result: FinishRecoveryRun) => Promise<void>;
};

export type RecoveryRunResult = {
  listed: number;
  missing: number;
  requested: number;
  outcome: RecoveryOutcome;
};

function newestDeliveryTime(items: readonly DeliveryItem[]): number | undefined {
  let newest: number | undefined;
  for (const item of items) {
    const deliveredAt = Date.parse(item.delivered_at);
    if (Number.isFinite(deliveredAt) && (newest === undefined || deliveredAt > newest)) {
      newest = deliveredAt;
    }
  }
  return newest;
}

/**
 * One bounded pass: reconcile what already landed, list recent deliveries, and
 * redeliver the failures we never received.
 *
 * Every exit writes a run record, so the dashboard can always say why nothing
 * happened, and the circuit breaker in `finishRecoveryRun` can widen the gap
 * when GitHub keeps refusing.
 */
export async function runRecovery(deps: RecoveryDeps): Promise<RecoveryRunResult> {
  const now = deps.now();
  await deps.reconcile(now);

  const gate = await deps.begin(now);
  if (!gate.run) {
    return { listed: 0, missing: 0, requested: 0, outcome: "skipped-backoff" };
  }

  const client = await deps.openClient();
  if (client === null) {
    // Not an error: a deployment on the legacy PAT has no App to authenticate
    // as, and recovery stays unavailable there by design.
    await deps.finish({ now, outcome: "skipped-no-app", listed: 0, missing: 0, requested: 0 });
    return { listed: 0, missing: 0, requested: 0, outcome: "skipped-no-app" };
  }

  try {
    const items: DeliveryItem[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const listed = await client.listDeliveries(cursor);
      items.push(...listed.items);
      cursor = listed.nextCursor;
      if (cursor === undefined || pageIsExhausted(listed.items, gate.scannedThrough)) {
        cursor = undefined;
        break;
      }
    }
    const pagesTruncated = cursor !== undefined;
    if (pagesTruncated) {
      console.warn(
        `Webhook delivery scan stopped at the ${MAX_PAGES}-page cap; the watermark was not advanced and the rest is picked up on the next run`,
      );
    }

    const candidates = selectRecoverable(items, { now, scannedThrough: gate.scannedThrough });
    // Either cap can leave part of the window unhandled: the page cap stops the
    // listing early, and the per-run cap drops candidates off the end of it.
    // Advancing the watermark past either would discard exactly the backlog a
    // long outage produces, so the next run rescans the same range and drains
    // it MAX_REDELIVERIES_PER_RUN at a time. Being one run late is the cost of
    // a scan that happened to end on a round number.
    const candidatesCapped = candidates.length === MAX_REDELIVERIES_PER_RUN;
    if (candidatesCapped) {
      console.warn(
        `Webhook delivery scan hit the ${MAX_REDELIVERIES_PER_RUN}-redelivery cap; the watermark was not advanced and the rest is picked up on the next run`,
      );
    }
    const truncated = pagesTruncated || candidatesCapped;

    const missing = new Set(await deps.missingGuids(candidates.map((c) => c.guid)));
    const claimed = await deps.claim(
      now,
      candidates.filter((candidate) => missing.has(candidate.guid)),
    );

    let requested = 0;
    for (const { guid, githubDeliveryId } of claimed) {
      try {
        await client.redeliver(githubDeliveryId);
        await deps.settle(guid, true);
        requested += 1;
      } catch (error) {
        // One refusal must not abandon the rest of the batch. The attempt was
        // already counted by `claim`, so a permanently rejected delivery still
        // walks its way to "abandoned".
        await deps.settle(guid, false, describeRecoveryFailure(error, "requesting a redelivery"));
      }
    }

    await deps.finish({
      now,
      outcome: "ok",
      newestDeliveredAt: truncated ? undefined : newestDeliveryTime(items),
      listed: items.length,
      missing: missing.size,
      requested,
    });
    return { listed: items.length, missing: missing.size, requested, outcome: "ok" };
  } catch (error) {
    const message = describeRecoveryFailure(error, "scanning webhook deliveries");
    console.error(`Webhook delivery recovery failed: ${message}`);
    await deps.finish({
      now,
      outcome: "error",
      listed: 0,
      missing: 0,
      requested: 0,
      error: message,
    });
    return { listed: 0, missing: 0, requested: 0, outcome: "error" };
  }
}
