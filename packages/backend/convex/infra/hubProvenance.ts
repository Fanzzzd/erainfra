// Who owns a row that both the Hub importer (hubImport.ts) and Convex write.
//
// Retiring the Hub is a strangler migration: the importer copies the Hub into Convex repeatedly
// while Convex starts writing the same tables. A re-import must never undo a Convex write, so every
// such row records its writer (tables.ts `provenanceValidator`) and every Convex delete of a row the
// Hub may still hold leaves a tombstone. The importer writes a row only while the Hub owns it.
//
// Every Convex writer claims a row through the helpers that write it (apps.ts upsert*, ports.ts
// allocatePort, secrets.ts putSecrets, git.ts insertBinding): with no Hub hash they record
// `{ by: "convex" }`. A writer that patches a row directly records `convexWrite(now)` itself.
import type { Infer } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { hubTombstoneKindValidator, provenanceValidator } from "./tables";

export type Provenance = Infer<typeof provenanceValidator>;
export type TombstoneKind = Infer<typeof hubTombstoneKindValidator>;

/** The importer's mark: the Hub row it copied, by hash. Env variables have none (tables.ts). */
export type HubOrigin = { hash?: string };

/** The provenance a write records: the importer's when it passes a Hub origin, else Convex's. */
export function provenanceFor(at: number, hub?: HubOrigin): Provenance {
  if (hub === undefined) return { by: "convex", at };
  return hub.hash === undefined ? { by: "hub", at } : { by: "hub", hash: hub.hash, at };
}

export const convexWrite = (at: number): Provenance => ({ by: "convex", at });

/**
 * Whether Convex wrote this row after the importer last did. A row stamped `hub` whose `updatedAt`
 * moved past the stamp was written by something that did not claim it; that write is Convex's too.
 * A row with no provenance predates the field and counts as the Hub's.
 */
export function writtenByConvex(row: { provenance?: Provenance; updatedAt?: number }) {
  const p = row.provenance;
  if (p === undefined) return false;
  if (p.by === "convex") return true;
  return row.updatedAt !== undefined && row.updatedAt !== p.at;
}

/** The hash the importer recorded for this row, or null when it is not a Hub-stamped row. */
export function hubHash(row: { provenance?: Provenance }) {
  return row.provenance?.by === "hub" ? (row.provenance.hash ?? null) : null;
}

/**
 * An App is Convex's once Convex deployed, failed over or removed it. A stored spec is written only
 * by a Convex deploy, so it marks App rows deployed before provenance was recorded as well.
 */
export function appOwnedByConvex(app: Doc<"apps">) {
  return app.spec !== undefined || writtenByConvex(app);
}

/** The tombstone key of one env variable. App and service names hold no `/` or `:`. */
export function secretKey(scope: { app: string; service?: string }, name: string) {
  return `${scope.app}${scope.service === undefined ? "" : `/${scope.service}`}:${name}`;
}

export async function hasTombstone(ctx: QueryCtx, kind: TombstoneKind, key: string) {
  const row = await ctx.db
    .query("hubImportTombstones")
    .withIndex("by_kind_key", (q) => q.eq("kind", kind).eq("key", key))
    .first();
  return row !== null;
}

/** Record that Convex deleted the row the importer knows as (`kind`, `key`). */
export async function recordTombstone(ctx: MutationCtx, kind: TombstoneKind, key: string) {
  const at = Date.now();
  const existing = await ctx.db
    .query("hubImportTombstones")
    .withIndex("by_kind_key", (q) => q.eq("kind", kind).eq("key", key))
    .first();
  if (existing === null) await ctx.db.insert("hubImportTombstones", { kind, key, at });
  else await ctx.db.patch(existing._id, { at });
}

/** SHA-256 of a value's JSON with object keys sorted, so the Hub row's key order does not matter. */
export async function contentHash(value: unknown) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(sortKeys(value))),
  );
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
  );
}
