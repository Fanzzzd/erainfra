import { describe, expect, it, vi } from "vitest";
import { DELIVERY_RETENTION_MS } from "../convex/reconcile.ts";
import {
  advanceWatermark,
  clampWatermark,
  decideRecovery,
  describeRecoveryFailure,
  isFailedDelivery,
  MAX_PAGES,
  MAX_RECOVERABLE_AGE_MS,
  MAX_RECOVERY_ATTEMPTS,
  MAX_REDELIVERIES_PER_RUN,
  nextRunDelayMs,
  pageIsExhausted,
  parseNextCursor,
  recoveryBackoffMs,
  RECOVERY_WINDOW_MS,
  runRecovery,
  selectRecoverable,
  statusOf,
  WATERMARK_OVERLAP_MS,
  type DeliveryItem,
  type FinishRecoveryRun,
  type RecoveryCandidate,
  type RecoveryDeps,
  type RecoveryRow,
} from "../convex/recovery.ts";

const NOW = Date.parse("2026-08-09T12:00:00Z");

function item(overrides: Partial<DeliveryItem> = {}): DeliveryItem {
  return {
    id: 1,
    guid: "guid-1",
    delivered_at: new Date(NOW - 60_000).toISOString(),
    status_code: 500,
    event: "workflow_job",
    ...overrides,
  };
}

function select(items: DeliveryItem[], scannedThrough = 0) {
  return selectRecoverable(items, { now: NOW, scannedThrough });
}

describe("isFailedDelivery", () => {
  it("treats every 2xx as delivered", () => {
    for (const status_code of [200, 201, 202, 204, 299]) {
      expect(isFailedDelivery({ status_code })).toBe(false);
    }
  });

  it("treats everything else as failed, including a connection that never landed", () => {
    // GitHub records status_code 0 for "failed to connect".
    for (const status_code of [0, 301, 400, 401, 404, 500, 502]) {
      expect(isFailedDelivery({ status_code })).toBe(true);
    }
  });
});

describe("selectRecoverable", () => {
  // The rule that stops the loop: /github/webhook answers 200 "Ignored" for a
  // payload it cannot parse, which writes no delivery row, so absence alone
  // would ask GitHub to redeliver it forever.
  it("drops a GUID that ever succeeded, even when a later attempt failed", () => {
    const candidates = select([
      item({ id: 1, guid: "ignored", status_code: 200 }),
      item({ id: 2, guid: "ignored", status_code: 500 }),
    ]);
    expect(candidates).toEqual([]);
  });

  it("keeps the newest failed attempt for a GUID that never succeeded", () => {
    const candidates = select([
      item({ id: 1, guid: "lost", delivered_at: new Date(NOW - 300_000).toISOString() }),
      item({ id: 2, guid: "lost", delivered_at: new Date(NOW - 60_000).toISOString() }),
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ guid: "lost", githubDeliveryId: 2, statusCode: 500 });
  });

  it("ignores events this deployment does not subscribe to", () => {
    expect(select([item({ event: "installation" })])).toEqual([]);
  });

  it("ignores deliveries GitHub has already cancelled the job for", () => {
    const stale = new Date(NOW - MAX_RECOVERABLE_AGE_MS - 60_000).toISOString();
    expect(select([item({ delivered_at: stale })])).toEqual([]);
  });

  it("ignores anything at or before the watermark", () => {
    const deliveredAt = NOW - 60_000;
    const items = [item({ delivered_at: new Date(deliveredAt).toISOString() })];
    expect(select(items, deliveredAt)).toEqual([]);
    expect(select(items, deliveredAt - 1)).toHaveLength(1);
  });

  it("ignores a timestamp it cannot parse", () => {
    expect(select([item({ delivered_at: "not a date" })])).toEqual([]);
  });

  it("returns the oldest first and stops at the per-run cap", () => {
    const items = Array.from({ length: MAX_REDELIVERIES_PER_RUN + 5 }, (_, index) =>
      item({
        id: index,
        guid: `guid-${index}`,
        // Descending timestamps, so input order is the reverse of the answer.
        delivered_at: new Date(NOW - 1_000 * (index + 1)).toISOString(),
      }),
    );

    const candidates = select(items);
    expect(candidates).toHaveLength(MAX_REDELIVERIES_PER_RUN);
    expect(candidates[0]?.guid).toBe(`guid-${MAX_REDELIVERIES_PER_RUN + 4}`);
    expect(candidates.toSorted((a, b) => a.deliveredAt - b.deliveredAt)).toEqual(candidates);
  });
});

describe("parseNextCursor", () => {
  it("reads the cursor out of a rel=next link", () => {
    const link =
      '<https://api.github.com/app/hook/deliveries?per_page=100&cursor=v1_123>; rel="next"';
    expect(parseNextCursor(link)).toBe("v1_123");
  });

  it("picks next out of a multi-relation header", () => {
    const link =
      '<https://api.github.com/app/hook/deliveries?cursor=v1_prev>; rel="prev", <https://api.github.com/app/hook/deliveries?cursor=v1_next>; rel="next"';
    expect(parseNextCursor(link)).toBe("v1_next");
  });

  it("returns undefined when there is no next page", () => {
    expect(parseNextCursor(undefined)).toBeUndefined();
    expect(parseNextCursor("")).toBeUndefined();
    expect(
      parseNextCursor('<https://api.github.com/app/hook/deliveries>; rel="prev"'),
    ).toBeUndefined();
    // A next link with no cursor cannot be followed.
    expect(
      parseNextCursor('<https://api.github.com/app/hook/deliveries>; rel="next"'),
    ).toBeUndefined();
    expect(parseNextCursor('<not-a-url>; rel="next"')).toBeUndefined();
  });
});

describe("pageIsExhausted", () => {
  it("is true once nothing on the page is newer than the watermark", () => {
    const page = [item({ delivered_at: new Date(NOW - 60_000).toISOString() })];
    expect(pageIsExhausted(page, NOW - 30_000)).toBe(true);
    expect(pageIsExhausted(page, NOW - 120_000)).toBe(false);
    expect(pageIsExhausted([], NOW)).toBe(true);
  });
});

describe("watermarks", () => {
  it("never leaves the window GitHub can redeliver from", () => {
    expect(clampWatermark(0, NOW)).toBe(NOW - RECOVERY_WINDOW_MS);
    expect(clampWatermark(NOW + 60_000, NOW)).toBe(NOW);
  });

  it("steps back by the overlap and never moves backwards", () => {
    const previous = NOW - 60 * 60_000;
    const newest = NOW - 60_000;
    expect(advanceWatermark(previous, newest, NOW)).toBe(newest - WATERMARK_OVERLAP_MS);
    // An older page cannot rewind a watermark a newer run already advanced.
    expect(advanceWatermark(previous, previous - 60_000, NOW)).toBe(previous);
  });
});

describe("backoff", () => {
  it("widens the gap between redelivery requests and then holds", () => {
    expect(recoveryBackoffMs(0)).toBe(0);
    expect(recoveryBackoffMs(1)).toBe(60_000);
    expect(recoveryBackoffMs(2)).toBe(300_000);
    expect(recoveryBackoffMs(3)).toBe(1_800_000);
    expect(recoveryBackoffMs(9)).toBe(1_800_000);
  });

  it("widens the gap between runs up to an hour", () => {
    expect(nextRunDelayMs(0)).toBe(0);
    expect(nextRunDelayMs(1)).toBe(60_000);
    expect(nextRunDelayMs(2)).toBe(300_000);
    expect(nextRunDelayMs(3)).toBe(900_000);
    expect(nextRunDelayMs(4)).toBe(3_600_000);
    expect(nextRunDelayMs(40)).toBe(3_600_000);
  });
});

describe("decideRecovery", () => {
  function row(overrides: Partial<RecoveryRow> = {}): RecoveryRow {
    return { attempts: 1, nextAttemptAt: NOW - 1, state: "requested", ...overrides };
  }

  it("requests a first attempt for an unseen delivery", () => {
    expect(decideRecovery(null, NOW)).toEqual({
      kind: "request",
      attempts: 1,
      nextAttemptAt: NOW + 60_000,
    });
  });

  it("waits out the backoff", () => {
    expect(decideRecovery(row({ nextAttemptAt: NOW + 1 }), NOW)).toEqual({ kind: "skip" });
  });

  it("leaves settled rows alone", () => {
    expect(decideRecovery(row({ state: "recovered" }), NOW)).toEqual({ kind: "skip" });
    expect(decideRecovery(row({ state: "abandoned" }), NOW)).toEqual({ kind: "skip" });
  });

  it("gives up once the attempt budget is spent", () => {
    expect(decideRecovery(row({ attempts: MAX_RECOVERY_ATTEMPTS - 1 }), NOW).kind).toBe("request");
    const spent = decideRecovery(row({ attempts: MAX_RECOVERY_ATTEMPTS }), NOW);
    expect(spent.kind).toBe("abandon");
    expect(spent.kind === "abandon" && spent.lastError).toContain(String(MAX_RECOVERY_ATTEMPTS));
  });
});

describe("describeRecoveryFailure", () => {
  it("reports a GitHub failure by status code and nothing else", () => {
    const error = Object.assign(new Error('{"message":"Bad credentials","hint":"secret"}'), {
      status: 401,
    });
    const described = describeRecoveryFailure(error, "requesting a redelivery");
    expect(described).toBe("GitHub responded 401 while requesting a redelivery");
    expect(described).not.toContain("Bad credentials");
    expect(described).not.toContain("secret");
  });

  it("keeps a local failure readable", () => {
    expect(describeRecoveryFailure(new Error("fetch failed"), "scanning webhook deliveries")).toBe(
      "Could not reach GitHub while scanning webhook deliveries: fetch failed",
    );
    expect(describeRecoveryFailure("boom", "scanning webhook deliveries")).toBe(
      "Could not reach GitHub while scanning webhook deliveries",
    );
  });

  it("reads a status off an error without importing Octokit", () => {
    expect(statusOf(Object.assign(new Error("x"), { status: 404 }))).toBe(404);
    expect(statusOf(new Error("x"))).toBe(0);
    expect(statusOf(null)).toBe(0);
  });
});

// The recovery scan uses "no webhookDeliveries row" as proof a delivery never
// arrived. That only holds while our rows outlive GitHub's redelivery window.
it("keeps delivery rows longer than GitHub can redeliver them", () => {
  expect(DELIVERY_RETENTION_MS).toBeGreaterThan(RECOVERY_WINDOW_MS);
});

type Recorded = {
  listCursors: (string | undefined)[];
  redelivered: number[];
  settled: { guid: string; ok: boolean; error?: string }[];
  finished: FinishRecoveryRun[];
  claimed: RecoveryCandidate[][];
};

function harness(
  options: {
    pages?: { items: DeliveryItem[]; nextCursor: string | undefined }[];
    missing?: string[];
    noApp?: boolean;
    open?: boolean;
    scannedThrough?: number;
    redeliver?: (id: number) => Promise<void>;
  } = {},
) {
  const recorded: Recorded = {
    listCursors: [],
    redelivered: [],
    settled: [],
    finished: [],
    claimed: [],
  };
  const pages = options.pages ?? [{ items: [], nextCursor: undefined }];
  let page = 0;

  const deps: RecoveryDeps = {
    now: () => NOW,
    reconcile: async () => ({ recovered: 0, abandoned: 0 }),
    begin: async () =>
      options.open === false
        ? { run: false }
        : { run: true, scannedThrough: options.scannedThrough ?? 0 },
    openClient: async () =>
      options.noApp === true
        ? null
        : {
            listDeliveries: async (cursor) => {
              recorded.listCursors.push(cursor);
              const current = pages[Math.min(page, pages.length - 1)];
              page += 1;
              return current;
            },
            redeliver: async (id) => {
              recorded.redelivered.push(id);
              if (options.redeliver !== undefined) {
                await options.redeliver(id);
              }
            },
          },
    missingGuids: async (guids) =>
      options.missing === undefined
        ? guids
        : guids.filter((guid) => options.missing?.includes(guid)),
    claim: async (_now, candidates) => {
      recorded.claimed.push(candidates);
      return candidates.map((candidate) => ({
        guid: candidate.guid,
        githubDeliveryId: candidate.githubDeliveryId,
      }));
    },
    settle: async (guid, ok, error) => {
      recorded.settled.push({ guid, ok, error });
    },
    finish: async (finished) => {
      recorded.finished.push(finished);
    },
  };

  return { deps, recorded };
}

describe("runRecovery", () => {
  it("redelivers a failed delivery this deployment never received", async () => {
    const { deps, recorded } = harness({
      pages: [{ items: [item({ id: 7, guid: "lost" })], nextCursor: undefined }],
    });

    const result = await runRecovery(deps);

    expect(result).toMatchObject({ listed: 1, missing: 1, requested: 1, outcome: "ok" });
    expect(recorded.redelivered).toEqual([7]);
    expect(recorded.settled).toEqual([{ guid: "lost", ok: true, error: undefined }]);
    expect(recorded.finished[0]).toMatchObject({ outcome: "ok", newestDeliveredAt: NOW - 60_000 });
  });

  it("leaves a delivery it already has alone", async () => {
    const { deps, recorded } = harness({
      pages: [{ items: [item({ guid: "already-here" })], nextCursor: undefined }],
      missing: [],
    });

    const result = await runRecovery(deps);

    expect(result.requested).toBe(0);
    expect(recorded.redelivered).toEqual([]);
    expect(recorded.claimed).toEqual([[]]);
  });

  it("stops at the page cap and refuses to advance the watermark", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { deps, recorded } = harness({
      pages: [{ items: [item({ guid: "a" })], nextCursor: "v1_more" }],
      missing: [],
    });

    await runRecovery(deps);

    expect(recorded.listCursors).toHaveLength(MAX_PAGES);
    expect(recorded.finished[0]?.newestDeliveredAt).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${MAX_PAGES}-page cap`));
    warn.mockRestore();
  });

  // A full batch means selectRecoverable may have dropped candidates off the
  // end, so the range has to be rescanned rather than stepped over.
  it("holds the watermark when the per-run redelivery cap is reached", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { deps, recorded } = harness({
      pages: [
        {
          items: Array.from({ length: MAX_REDELIVERIES_PER_RUN + 3 }, (_, index) =>
            item({
              id: index,
              guid: `guid-${index}`,
              delivered_at: new Date(NOW - 1_000 * (index + 1)).toISOString(),
            }),
          ),
          nextCursor: undefined,
        },
      ],
    });

    await runRecovery(deps);

    expect(recorded.redelivered).toHaveLength(MAX_REDELIVERIES_PER_RUN);
    expect(recorded.finished[0]?.newestDeliveredAt).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`${MAX_REDELIVERIES_PER_RUN}-redelivery cap`),
    );
    warn.mockRestore();
  });

  it("stops early once a page holds nothing newer than the watermark", async () => {
    const { deps, recorded } = harness({
      pages: [{ items: [item({ guid: "old" })], nextCursor: "v1_more" }],
      scannedThrough: NOW,
      missing: [],
    });

    await runRecovery(deps);

    expect(recorded.listCursors).toEqual([undefined]);
    // A complete scan, so the watermark may move.
    expect(recorded.finished[0]?.newestDeliveredAt).toBe(NOW - 60_000);
  });

  it("does nothing at all when no GitHub App is configured", async () => {
    const { deps, recorded } = harness({ noApp: true });

    const result = await runRecovery(deps);

    expect(result.outcome).toBe("skipped-no-app");
    expect(recorded.listCursors).toEqual([]);
    expect(recorded.redelivered).toEqual([]);
    // Recorded, not swallowed: the dashboard has to be able to explain it.
    expect(recorded.finished[0]).toMatchObject({ outcome: "skipped-no-app" });
  });

  it("touches nothing while the circuit breaker is open", async () => {
    const { deps, recorded } = harness({ open: false });

    const result = await runRecovery(deps);

    expect(result.outcome).toBe("skipped-backoff");
    expect(recorded.listCursors).toEqual([]);
    expect(recorded.finished).toEqual([]);
  });

  it("keeps going when GitHub refuses one redelivery", async () => {
    const { deps, recorded } = harness({
      pages: [
        {
          items: [
            item({ id: 1, guid: "a", delivered_at: new Date(NOW - 300_000).toISOString() }),
            item({ id: 2, guid: "b", delivered_at: new Date(NOW - 200_000).toISOString() }),
          ],
          nextCursor: undefined,
        },
      ],
      redeliver: async (id) => {
        if (id === 1) {
          throw Object.assign(new Error("Not Found"), { status: 404 });
        }
      },
    });

    const result = await runRecovery(deps);

    expect(recorded.redelivered).toEqual([1, 2]);
    expect(recorded.settled).toEqual([
      { guid: "a", ok: false, error: "GitHub responded 404 while requesting a redelivery" },
      { guid: "b", ok: true, error: undefined },
    ]);
    expect(result).toMatchObject({ requested: 1, outcome: "ok" });
  });

  it("opens the circuit breaker when the listing itself fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps, recorded } = harness();
    deps.openClient = async () => ({
      listDeliveries: async () => {
        throw Object.assign(new Error("Bad credentials"), { status: 401 });
      },
      redeliver: async () => {},
    });

    const result = await runRecovery(deps);

    expect(result.outcome).toBe("error");
    expect(recorded.finished[0]).toMatchObject({
      outcome: "error",
      error: "GitHub responded 401 while scanning webhook deliveries",
    });
    expect(recorded.finished[0]?.error).not.toContain("Bad credentials");
    error.mockRestore();
  });
});
