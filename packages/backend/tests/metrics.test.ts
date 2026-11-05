import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import { attemptOutcome } from "../convex/fleetObservation";
import { formatSampleValue, quantile, renderExposition } from "../convex/metricsFormat";
import { CONTRACT, MINUTE, NOW, operator, seedFleet } from "./support/fleetFixture.ts";

const modules = import.meta.glob("../convex/**/*.ts");
type Harness = TestConvex<typeof schema>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

async function mint(
  t: Harness,
  name = "prometheus",
  scope: "read" | "admin" | "metrics" = "metrics",
) {
  const { _id, token } = await (await operator(t)).mutation(api.apiTokens.create, { name, scope });
  return { id: _id, token };
}

function scrape(t: Harness, authorization?: string) {
  return t.fetch("/metrics", {
    method: "GET",
    headers: authorization === undefined ? {} : { Authorization: authorization },
  });
}

// ------------------------------------------------------------------------------------------
// A small parser for the text exposition format, version 0.0.4
// (https://prometheus.io/docs/instrumenting/exposition_formats/). It rejects anything outside
// the grammar instead of skipping it, so a malformed line fails the test.

const METRIC_NAME = "[a-zA-Z_:][a-zA-Z0-9_:]*";
const LABEL = `([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\\\\\n]|\\\\[\\\\"n])*)"`;
const VALUE = "[-+]?(?:[0-9]+(?:\\.[0-9]*)?(?:[eE][-+]?[0-9]+)?|\\.[0-9]+|NaN|Inf)";
const HELP_LINE = new RegExp(`^# HELP (${METRIC_NAME}) (.*)$`);
const TYPE_LINE = new RegExp(`^# TYPE (${METRIC_NAME}) (counter|gauge|histogram|summary|untyped)$`);
const SAMPLE_LINE = new RegExp(
  `^(${METRIC_NAME})(?:\\{((?:${LABEL})(?:,${LABEL})*)?,?\\})? (${VALUE})(?: -?[0-9]+)?$`,
);

type Series = { name: string; labels: Record<string, string>; value: number };
type Parsed = { types: Map<string, string>; help: Map<string, string>; series: Series[] };

function parseExposition(text: string): Parsed {
  expect(text.endsWith("\n")).toBe(true);
  const types = new Map<string, string>();
  const help = new Map<string, string>();
  const series: Series[] = [];
  const seen = new Set<string>();
  let current: string | undefined;
  for (const [index, line] of text.slice(0, -1).split("\n").entries()) {
    const where = `line ${index + 1}: ${line}`;
    const helpMatch = HELP_LINE.exec(line);
    if (helpMatch !== null) {
      const name = helpMatch[1] as string;
      expect(help.has(name), `duplicate HELP, ${where}`).toBe(false);
      help.set(name, helpMatch[2] as string);
      continue;
    }
    const typeMatch = TYPE_LINE.exec(line);
    if (typeMatch !== null) {
      const name = typeMatch[1] as string;
      expect(types.has(name), `duplicate TYPE, ${where}`).toBe(false);
      expect(
        series.some((sample) => sample.name === name),
        `TYPE after samples, ${where}`,
      ).toBe(false);
      types.set(name, typeMatch[2] as string);
      current = name;
      continue;
    }
    expect(line.startsWith("#"), `unknown comment, ${where}`).toBe(false);
    const sampleMatch = SAMPLE_LINE.exec(line);
    expect(sampleMatch, `not a sample, ${where}`).not.toBeNull();
    const name = sampleMatch?.[1] as string;
    expect(name, `sample outside its family, ${where}`).toBe(current);
    const labels: Record<string, string> = {};
    const labelText = line.slice(name.length).match(/^\{(.*)\} /)?.[1] ?? "";
    for (const label of labelText.matchAll(new RegExp(LABEL, "g"))) {
      const key = label[1] as string;
      expect(key in labels, `duplicate label, ${where}`).toBe(false);
      labels[key] = (label[2] as string)
        .replace(/\\n/g, "\n")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    }
    const identity = `${name}${JSON.stringify(Object.entries(labels).toSorted())}`;
    expect(seen.has(identity), `duplicate series, ${where}`).toBe(false);
    seen.add(identity);
    const rawValue = sampleMatch?.at(-1) as string;
    const value =
      rawValue === "NaN"
        ? Number.NaN
        : rawValue.endsWith("Inf")
          ? Number(rawValue.replace("Inf", "Infinity"))
          : Number(rawValue);
    series.push({ name, labels, value });
  }
  for (const name of types.keys()) {
    expect(help.has(name), `${name} has no HELP`).toBe(true);
  }
  return { types, help, series };
}

function valueOf(parsed: Parsed, name: string, labels: Record<string, string> = {}) {
  const matches = parsed.series.filter(
    (sample) =>
      sample.name === name &&
      Object.entries(labels).every(([key, value]) => sample.labels[key] === value),
  );
  if (matches.length !== 1) {
    throw new Error(`${name}${JSON.stringify(labels)} matched ${matches.length} series`);
  }
  return matches[0]?.value;
}

// ------------------------------------------------------------------------------------------

describe("GET /metrics authentication", () => {
  it("refuses a request with no token", async () => {
    const t = convexTest(schema, modules);
    const response = await scrape(t);
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe('Bearer realm="erainfra-metrics"');
  });

  it("refuses a malformed header and a token it never minted", async () => {
    const t = convexTest(schema, modules);
    const { token } = await mint(t);
    expect((await scrape(t, token)).status).toBe(401);
    expect((await scrape(t, `Basic ${token}`)).status).toBe(401);
    expect((await scrape(t, `Bearer erainfra_${"0".repeat(64)}`)).status).toBe(401);
    expect((await scrape(t, `Bearer ${token}x`)).status).toBe(401);
  });

  it("serves a minted token and refuses it once revoked", async () => {
    const t = convexTest(schema, modules);
    const { id, token } = await mint(t);
    const ok = await scrape(t, `Bearer ${token}`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Content-Type")).toBe("text/plain; version=0.0.4; charset=utf-8");

    await (await operator(t)).mutation(api.apiTokens.revoke, { tokenId: id });
    const refused = await scrape(t, `Bearer ${token}`);
    expect(refused.status).toBe(401);
    expect(await refused.text()).toBe("Unauthorized\n");
  });

  it("keeps a replacement token working while the old one is revoked", async () => {
    const t = convexTest(schema, modules);
    const old = await mint(t, "old");
    const replacement = await mint(t, "new");
    await (await operator(t)).mutation(api.apiTokens.revoke, { tokenId: old.id });
    expect((await scrape(t, `Bearer ${old.token}`)).status).toBe(401);
    expect((await scrape(t, `Bearer ${replacement.token}`)).status).toBe(200);
  });

  it("lets a metrics token scrape and nothing else, and any API token scrape", async () => {
    const t = convexTest(schema, modules);
    const metrics = await mint(t, "prometheus", "metrics");
    const read = await mint(t, "laptop", "read");
    const admin = await mint(t, "ops", "admin");
    for (const { token } of [metrics, read, admin]) {
      expect((await scrape(t, `Bearer ${token}`)).status).toBe(200);
    }
    const refused = await t.fetch("/api/v1/profiles", {
      method: "GET",
      headers: { Authorization: `Bearer ${metrics.token}` },
    });
    expect(refused.status).toBe(403);
    const registration = await t.fetch("/api/v1/workers/registration-tokens", {
      method: "POST",
      headers: { Authorization: `Bearer ${metrics.token}` },
    });
    expect(registration.status).toBe(403);
  });

  it("records when a token was last used, at most every five minutes", async () => {
    const t = convexTest(schema, modules);
    const { id, token } = await mint(t);
    const lastUsed = async () => (await t.run((ctx) => ctx.db.get(id)))?.lastUsedAt;
    await scrape(t, `Bearer ${token}`);
    vi.setSystemTime(NOW + MINUTE);
    await scrape(t, `Bearer ${token}`);
    expect(await lastUsed()).toBe(NOW);
    vi.setSystemTime(NOW + 6 * MINUTE);
    await scrape(t, `Bearer ${token}`);
    expect(await lastUsed()).toBe(NOW + 6 * MINUTE);
  });
});

describe("GET /metrics exposition", () => {
  async function scrapeFixture() {
    const t = convexTest(schema, modules);
    await seedFleet(t);
    const { token } = await mint(t);
    const response = await scrape(t, `Bearer ${token}`);
    expect(response.status).toBe(200);
    const text = await response.text();
    return { text, parsed: parseExposition(text) };
  }

  it("is valid text exposition with a gauge TYPE and HELP for every family", async () => {
    const { parsed } = await scrapeFixture();
    expect(parsed.types.size).toBeGreaterThan(15);
    for (const type of parsed.types.values()) expect(type).toBe("gauge");
    for (const name of parsed.types.keys()) {
      expect(name).toMatch(/^erainfra_/);
      // Counter suffix on a gauge would tell PromQL users to rate() it.
      expect(name).not.toMatch(/_total$/);
    }
  });

  it("never labels a series with a repository, runner or job", async () => {
    const { text, parsed } = await scrapeFixture();
    expect(text).not.toContain("acme/secret-repo");
    expect(text).not.toContain("runner-");
    const allowed = new Set([
      "profile",
      "machine",
      "executor",
      "state",
      "result",
      "quantile",
      "dimension",
      "os",
      "arch",
      "slot_policy",
      "rule",
    ]);
    for (const sample of parsed.series) {
      for (const key of Object.keys(sample.labels)) expect(allowed.has(key), key).toBe(true);
    }
  });

  it("reports the seeded Profiles, Workers and Attempts", async () => {
    const { parsed } = await scrapeFixture();
    const profile = { profile: CONTRACT.profile };

    expect(
      valueOf(parsed, "erainfra_profile_info", {
        profile: CONTRACT.profile,
        executor: "firecracker",
        state: "active",
      }),
    ).toBe(1);
    expect(
      valueOf(parsed, "erainfra_profile_info", {
        profile: "rc-docker",
        executor: "docker",
        state: "paused",
      }),
    ).toBe(1);
    expect(valueOf(parsed, "erainfra_profile_runners_min", profile)).toBe(1);
    expect(valueOf(parsed, "erainfra_profile_runners_max", profile)).toBe(6);

    expect(valueOf(parsed, "erainfra_profile_workers", { ...profile, state: "ready" })).toBe(1);
    expect(valueOf(parsed, "erainfra_profile_workers", { ...profile, state: "degraded" })).toBe(1);
    expect(valueOf(parsed, "erainfra_profile_workers", { ...profile, state: "failed" })).toBe(0);
    expect(valueOf(parsed, "erainfra_profile_workers_schedulable", profile)).toBe(1);
    expect(valueOf(parsed, "erainfra_profile_workers_schedulable", { profile: "rc-docker" })).toBe(
      0,
    );

    expect(valueOf(parsed, "erainfra_attempts", { ...profile, state: "pending" })).toBe(2);
    expect(valueOf(parsed, "erainfra_attempts", { ...profile, state: "running" })).toBe(1);
    expect(valueOf(parsed, "erainfra_attempts", { ...profile, state: "ready" })).toBe(0);
    expect(valueOf(parsed, "erainfra_attempt_queue_oldest_age_seconds", profile)).toBe(300);
    expect(
      valueOf(parsed, "erainfra_attempt_queue_oldest_age_seconds", { profile: "rc-docker" }),
    ).toBe(0);
  });

  it("reports the last hour of finished Attempts as window gauges", async () => {
    const { parsed } = await scrapeFixture();
    const profile = { profile: CONTRACT.profile };
    expect(valueOf(parsed, "erainfra_recent_window_seconds")).toBe(3600);
    expect(
      valueOf(parsed, "erainfra_recent_attempts_finished", { ...profile, result: "succeeded" }),
    ).toBe(2);
    expect(
      valueOf(parsed, "erainfra_recent_attempts_finished", { ...profile, result: "failed" }),
    ).toBe(2);
    expect(
      valueOf(parsed, "erainfra_recent_attempts_finished", { ...profile, result: "cancelled" }),
    ).toBe(1);
    expect(
      valueOf(parsed, "erainfra_recent_attempts_finished", { ...profile, result: "unknown" }),
    ).toBe(0);

    const wait = (q: string) =>
      valueOf(parsed, "erainfra_recent_attempt_queue_wait_seconds", { ...profile, quantile: q });
    expect([wait("0.5"), wait("0.9"), wait("0.99"), wait("1")]).toEqual([20, 30, 30, 30]);
    const run = (q: string) =>
      valueOf(parsed, "erainfra_recent_attempt_run_duration_seconds", { ...profile, quantile: q });
    expect([run("0.5"), run("1")]).toEqual([120, 180]);
    // No finished Attempt on the paused Profile, so no quantile series rather than a fake zero.
    expect(
      parsed.series.filter(
        (sample) =>
          sample.name === "erainfra_recent_attempt_queue_wait_seconds" &&
          sample.labels.profile === "rc-docker",
      ),
    ).toEqual([]);
    expect(valueOf(parsed, "erainfra_recent_attempts_sample_truncated", profile)).toBe(0);
  });

  it("reports each Worker's slots, heartbeat and benchmark", async () => {
    const { parsed } = await scrapeFixture();
    const ubuntu = { machine: "ubuntu0" };
    expect(
      valueOf(parsed, "erainfra_machine_info", {
        machine: "mac-mini",
        os: "linux",
        arch: "x86_64",
        slot_policy: "fixed",
      }),
    ).toBe(1);
    expect(valueOf(parsed, "erainfra_machine_online", ubuntu)).toBe(1);
    expect(valueOf(parsed, "erainfra_machine_online", { machine: "gone-box" })).toBe(0);
    expect(valueOf(parsed, "erainfra_machine_heartbeat_age_seconds", ubuntu)).toBe(10);
    expect(valueOf(parsed, "erainfra_machine_heartbeat_age_seconds", { machine: "gone-box" })).toBe(
      1800,
    );
    expect(valueOf(parsed, "erainfra_machine_last_heartbeat_timestamp_seconds", ubuntu)).toBe(
      (NOW - 10_000) / 1000,
    );
    // A Worker that never heartbeated has no heartbeat series at all.
    expect(
      parsed.series.filter(
        (sample) =>
          sample.name.startsWith("erainfra_machine_") &&
          sample.name.includes("heartbeat") &&
          sample.labels.machine === "never-seen",
      ),
    ).toEqual([]);

    expect(valueOf(parsed, "erainfra_machine_slots_effective", ubuntu)).toBe(4);
    expect(valueOf(parsed, "erainfra_machine_slots_used", ubuntu)).toBe(1);
    expect(valueOf(parsed, "erainfra_machine_slots_recommended", ubuntu)).toBe(4);
    expect(valueOf(parsed, "erainfra_machine_slots_configured", { machine: "mac-mini" })).toBe(2);
    expect(
      parsed.series.filter(
        (sample) =>
          sample.name === "erainfra_machine_slots_configured" &&
          sample.labels.machine === "ubuntu0",
      ),
    ).toEqual([]);

    expect(
      valueOf(parsed, "erainfra_machine_benchmark_score", { ...ubuntu, dimension: "cpu" }),
    ).toBe(80);
    expect(
      valueOf(parsed, "erainfra_machine_benchmark_score", { ...ubuntu, dimension: "network" }),
    ).toBe(55.5);
    expect(valueOf(parsed, "erainfra_machine_benchmark_timestamp_seconds", ubuntu)).toBe(
      (NOW - 60 * MINUTE) / 1000,
    );
    expect(valueOf(parsed, "erainfra_scrape_truncated")).toBe(0);
  });

  it("counts open firing incidents per enabled rule, with zero for a quiet rule", async () => {
    const t = convexTest(schema, modules);
    await seedFleet(t);
    const ops = await operator(t);
    await ops.mutation(api.alerts.createRule, {
      name: "Queue backlog",
      condition: { kind: "queue-backlog", minutes: 2 },
      forMinutes: 0,
      cooldownMinutes: 0,
      destinationIds: [],
    });
    await ops.mutation(api.alerts.createRule, {
      name: "Stuck jobs",
      condition: { kind: "attempt-duration", minutes: 60 },
      forMinutes: 0,
      cooldownMinutes: 0,
      destinationIds: [],
    });
    await t.action(internal.alerts.evaluate, {});
    const { token } = await ops.mutation(api.apiTokens.create, { name: "p", scope: "metrics" });
    const parsed = parseExposition(await (await scrape(t, `Bearer ${token}`)).text());
    expect(valueOf(parsed, "erainfra_alerts_firing", { rule: "Queue backlog" })).toBe(1);
    expect(valueOf(parsed, "erainfra_alerts_firing", { rule: "Stuck jobs" })).toBe(0);
  });
});

describe("exposition helpers", () => {
  it("escapes label values and HELP text", () => {
    const text = renderExposition([
      {
        name: "erainfra_test",
        help: "line one\nback\\slash",
        samples: [{ labels: { machine: 'a"b\\c\nd' }, value: 1.5 }],
      },
    ]);
    expect(text).toBe(
      '# HELP erainfra_test line one\\nback\\\\slash\n# TYPE erainfra_test gauge\nerainfra_test{machine="a\\"b\\\\c\\nd"} 1.5\n',
    );
    const parsed = parseExposition(text);
    expect(parsed.series[0]?.labels.machine).toBe('a"b\\c\nd');
  });

  it("formats special values the way Prometheus parses them", () => {
    expect(formatSampleValue(Number.NaN)).toBe("NaN");
    expect(formatSampleValue(Infinity)).toBe("+Inf");
    expect(formatSampleValue(0.1 + 0.2)).toBe("0.3");
    expect(formatSampleValue(42)).toBe("42");
  });

  it("takes nearest-rank quantiles", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(quantile([1, 2, 3, 4], 0.99)).toBe(4);
    expect(quantile([7], 0.5)).toBe(7);
    expect(Number.isNaN(quantile([], 0.5))).toBe(true);
  });

  it("maps GitHub results to a closed outcome set", () => {
    expect(attemptOutcome({ state: "completed", result: "Succeeded" })).toBe("succeeded");
    expect(attemptOutcome({ state: "completed", result: "canceled" })).toBe("cancelled");
    expect(attemptOutcome({ state: "completed", result: "failed" })).toBe("failed");
    expect(attemptOutcome({ state: "completed", result: "skipped" })).toBe("unknown");
    expect(attemptOutcome({ state: "completed" })).toBe("unknown");
    expect(attemptOutcome({ state: "failed", result: "succeeded" })).toBe("failed");
    expect(attemptOutcome({ state: "cancelled" })).toBe("cancelled");
  });
});
