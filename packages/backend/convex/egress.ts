import { v, type Infer } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

/**
 * A Profile's egress policy, as the controller publishes it and every Worker
 * enforces it. This file mirrors `apps/runtime/internal/netpolicy/egress.go`:
 * the control plane validates and normalizes a policy before storing it, and
 * the Worker validates it again before enforcing it. Both read the shared
 * cases in `testdata/egress-policy-cases.json`, so the two cannot drift
 * without a test going red.
 *
 * A Profile without the field is public egress, which is what every Profile
 * registered before the field existed means; no migration is needed.
 */
export const egressModeValidator = v.union(
  v.literal("public"),
  v.literal("audit"),
  v.literal("allowlist"),
);
export type EgressMode = Infer<typeof egressModeValidator>;

export const profileEgressValidator = v.object({
  mode: egressModeValidator,
  presets: v.array(v.literal("github")),
  domains: v.array(v.string()),
  cidrs: v.array(v.string()),
});
export type ProfileEgress = Infer<typeof profileEgressValidator>;

export const PUBLIC_EGRESS: ProfileEgress = { mode: "public", presets: [], domains: [], cidrs: [] };

export const MAX_EGRESS_DOMAINS = 256;
export const MAX_EGRESS_CIDRS = 256;

const DOMAIN_LABEL = /^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$/;

function sortedUnique(values: string[]) {
  return [...new Set(values)].toSorted();
}

function parseIPv4(text: string): number | undefined {
  const parts = text.split(".");
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    // Go's netip refuses leading zeros, and so does this: "010" is not 10.
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    value = value * 256 + octet;
  }
  return value;
}

function formatIPv4(value: number) {
  return [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join(".");
}

/** An IPv4 address or CIDR, masked, as "a.b.c.d/n"; undefined if it is not one. */
export function normalizeIPv4Destination(text: string): string | undefined {
  const [address, length, extra] = text.split("/");
  if (address === undefined || extra !== undefined) return undefined;
  const parsed = parseIPv4(address);
  if (parsed === undefined) return undefined;
  if (length === undefined) return `${formatIPv4(parsed)}/32`;
  if (!/^(0|[1-9][0-9]?)$/.test(length)) return undefined;
  const bits = Number(length);
  if (bits > 32) return undefined;
  const size = 2 ** (32 - bits);
  return `${formatIPv4(Math.floor(parsed / size) * size)}/${bits}`;
}

export function normalizeDomain(domain: string) {
  return domain.trim().toLowerCase().replace(/\.$/, "");
}

function domainProblem(domain: string): string | undefined {
  const name = domain.startsWith("*.") ? domain.slice(2) : domain;
  if (name.includes("*")) return `${domain}: a wildcard is allowed only as the whole first label`;
  if (name.length > 253) return `${domain} is longer than 253 characters`;
  const labels = name.split(".");
  if (labels.length < 2) return `${domain} must have at least two labels`;
  if (labels.some((label) => !DOMAIN_LABEL.test(label))) return `${domain} has an invalid label`;
  if (parseIPv4(name) !== undefined) return `${domain} is an address; list it as a CIDR`;
  return undefined;
}

/**
 * Validates and normalizes a policy from an untrusted payload. Returns the
 * canonical policy, or the reason it is refused. `undefined` is public.
 */
export function parseProfileEgress(
  payload: unknown,
): { ok: true; egress: ProfileEgress } | { ok: false; error: string } {
  if (payload === undefined || payload === null) return { ok: true, egress: PUBLIC_EGRESS };
  if (typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "egress must be an object" };
  }
  const record = payload as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!["mode", "presets", "domains", "cidrs"].includes(key)) {
      return { ok: false, error: `egress has an unknown field ${key}` };
    }
  }
  const lists: Record<"presets" | "domains" | "cidrs", string[]> = {
    presets: [],
    domains: [],
    cidrs: [],
  };
  for (const key of ["presets", "domains", "cidrs"] as const) {
    const value = record[key];
    if (value === undefined || value === null) continue;
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
      return { ok: false, error: `egress.${key} must be a list of strings` };
    }
    lists[key] = (value as string[]).map((entry) => entry.trim()).filter((entry) => entry !== "");
  }
  const rawMode = record.mode === undefined ? "public" : record.mode;
  if (rawMode !== "public" && rawMode !== "audit" && rawMode !== "allowlist") {
    return { ok: false, error: "egress.mode must be public, audit, or allowlist" };
  }
  const mode: EgressMode = rawMode;
  const presets = sortedUnique(lists.presets.map((preset) => preset.toLowerCase()));
  const domains = sortedUnique(
    lists.domains.map(normalizeDomain).filter((domain) => domain !== ""),
  );
  const cidrs: string[] = [];
  for (const cidr of lists.cidrs) {
    const normalized = normalizeIPv4Destination(cidr);
    if (normalized === undefined) {
      return {
        ok: false,
        error: `${cidr} must be an IPv4 address or CIDR; guests have no IPv6 egress`,
      };
    }
    cidrs.push(normalized);
  }
  const uniqueCidrs = sortedUnique(cidrs);
  const allowed = presets.length + domains.length + uniqueCidrs.length;
  if (mode === "public" && allowed > 0) {
    return { ok: false, error: "public egress takes no allowlist; use audit or allowlist mode" };
  }
  for (const preset of presets) {
    if (preset !== "github") return { ok: false, error: `unknown egress preset ${preset}` };
  }
  if (domains.length > MAX_EGRESS_DOMAINS) {
    return { ok: false, error: `an egress allowlist holds at most ${MAX_EGRESS_DOMAINS} domains` };
  }
  if (uniqueCidrs.length > MAX_EGRESS_CIDRS) {
    return { ok: false, error: `an egress allowlist holds at most ${MAX_EGRESS_CIDRS} CIDRs` };
  }
  for (const domain of domains) {
    const problem = domainProblem(domain);
    if (problem !== undefined) return { ok: false, error: `allowed domain ${problem}` };
  }
  if (mode === "allowlist" && allowed === 0) {
    return {
      ok: false,
      error: "allowlist egress with nothing allowed denies GitHub itself; add the github preset",
    };
  }
  return {
    ok: true,
    egress: { mode, presets: presets as "github"[], domains, cidrs: uniqueCidrs },
  };
}

/** The stored policy of a Profile, with the absent field read as public. */
export function profileEgressOf(profile: Pick<Doc<"profiles">, "egress">): ProfileEgress {
  return profile.egress ?? PUBLIC_EGRESS;
}

function sameList(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Canonical equality: both sides are stored normalized. */
export function sameEgress(left: ProfileEgress, right: ProfileEgress) {
  return (
    left.mode === right.mode &&
    sameList(left.presets, right.presets) &&
    sameList(left.domains, right.domains) &&
    sameList(left.cidrs, right.cidrs)
  );
}

const EGRESS_RANK: Record<EgressMode, number> = { public: 0, audit: 1, allowlist: 2 };

export function egressRank(mode: string | undefined) {
  return mode === "audit" || mode === "allowlist" || mode === "public" ? EGRESS_RANK[mode] : -1;
}

/** The part of a Worker's readiness evidence that describes Profile egress. */
export const egressEvidenceValidator = v.object({
  mode: v.string(),
  hostMode: v.string(),
  profileMode: v.string(),
  presets: v.optional(v.array(v.string())),
  domains: v.optional(v.array(v.string())),
  cidrs: v.optional(v.array(v.string())),
  allowedDomainCount: v.number(),
});
export type EgressEvidence = Infer<typeof egressEvidenceValidator>;

/**
 * Why a Worker's evidence does not prove it enforces the Profile's egress now,
 * or undefined when it does.
 *
 * A public Profile is satisfied by evidence that predates Profile egress:
 * that is exactly what every Worker enforced before. Any other Profile needs
 * evidence that names the same policy, an effective mode at least as strict,
 * and a passing egress-policy check. A Profile whose egress changed after the
 * Worker reported therefore stops admitting that Worker until it reports again.
 */
export function egressEvidenceError(
  profile: ProfileEgress,
  evidence: EgressEvidence | undefined,
  checks: { name: string; passed: boolean }[] | undefined,
): string | undefined {
  if (evidence === undefined) {
    return profile.mode === "public"
      ? undefined
      : `network.egress is required for a ${profile.mode} Profile`;
  }
  const enforced: ProfileEgress = {
    mode: evidence.profileMode as EgressMode,
    presets: (evidence.presets ?? []) as "github"[],
    domains: evidence.domains ?? [],
    cidrs: evidence.cidrs ?? [],
  };
  if (!sameEgress(enforced, profile)) {
    return "network.egress does not match the Profile's current egress policy";
  }
  if (egressRank(evidence.mode) < EGRESS_RANK[profile.mode]) {
    return `network.egress.mode ${evidence.mode} is weaker than the Profile's ${profile.mode}`;
  }
  const check = (checks ?? []).find((entry) => entry.name === "egress-policy");
  if (profile.mode !== "public" && check?.passed !== true) {
    return "the egress-policy check must pass";
  }
  return undefined;
}

export const egressVerdictValidator = v.union(
  v.literal("allowed"),
  v.literal("blocked"),
  v.literal("unlisted"),
);

export const MAX_RECORD_NAMES = 256;
export const MAX_RECORD_FLOWS = 512;

/** What one Attempt's guest talked to, measured on the Worker's host. */
export const egressRecordValidator = v.object({
  mode: egressModeValidator,
  names: v.optional(
    v.array(v.object({ name: v.string(), verdict: egressVerdictValidator, queries: v.number() })),
  ),
  flows: v.optional(
    v.array(
      v.object({
        destination: v.string(),
        protocol: v.union(v.literal("tcp"), v.literal("udp")),
        port: v.number(),
        name: v.optional(v.string()),
        verdict: egressVerdictValidator,
      }),
    ),
  ),
  omittedNames: v.optional(v.number()),
  omittedFlows: v.optional(v.number()),
  error: v.optional(v.string()),
});
export type EgressRecord = Infer<typeof egressRecordValidator>;

/**
 * Clamps a reported record to its bounds. The runtime already bounds it; the
 * control plane does not trust that, because a Worker's report is the only
 * input here that a compromised host controls.
 */
export function boundedEgressRecord(record: EgressRecord): EgressRecord {
  const names = (record.names ?? []).slice(0, MAX_RECORD_NAMES).map((entry) => ({
    name: entry.name.slice(0, 253),
    verdict: entry.verdict,
    queries: Math.max(0, Math.floor(entry.queries)),
  }));
  const flows = (record.flows ?? []).slice(0, MAX_RECORD_FLOWS).map((entry) => ({
    destination: entry.destination.slice(0, 64),
    protocol: entry.protocol,
    port: Math.min(65_535, Math.max(0, Math.floor(entry.port))),
    ...(entry.name === undefined ? {} : { name: entry.name.slice(0, 253) }),
    verdict: entry.verdict,
  }));
  return {
    mode: record.mode,
    names,
    flows,
    omittedNames:
      Math.max(0, Math.floor(record.omittedNames ?? 0)) +
      Math.max(0, (record.names?.length ?? 0) - MAX_RECORD_NAMES),
    omittedFlows:
      Math.max(0, Math.floor(record.omittedFlows ?? 0)) +
      Math.max(0, (record.flows?.length ?? 0) - MAX_RECORD_FLOWS),
    ...(record.error === undefined ? {} : { error: record.error.slice(0, 1_000) }),
  };
}

export async function deleteAttemptEgress(ctx: MutationCtx, attemptId: Doc<"attempts">["_id"]) {
  const record = await ctx.db
    .query("attemptEgress")
    .withIndex("by_attempt", (query) => query.eq("attemptId", attemptId))
    .unique();
  if (record !== null) await ctx.db.delete(record._id);
}
