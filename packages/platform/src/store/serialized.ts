// Turns the query Convex's client code serializes into the `1.0/queryStream` and `1.0/queryPage`
// syscalls into a ScanPlan. Convex's IndexRangeBuilderImpl has already checked the range's field
// order; this file re-checks it against the store's index so a bad range fails here, not silently.

import { compareValues, jsonToConvex, type JSONValue, type Value } from "convex/values";

import { fieldValue, IndexRangeBuilder, type Doc } from "./expressions.ts";
import { rangeFields, type ScanPlan, type Store } from "./store.ts";

type RangeExpression = {
  type: "Eq" | "Gt" | "Gte" | "Lt" | "Lte";
  fieldPath: string;
  value: JSONValue;
};

export type SerializedQuery = {
  source:
    | {
        type: "IndexRange";
        indexName: string;
        range: RangeExpression[];
        order: "asc" | "desc" | null;
      }
    | { type: "FullTableScan"; tableName: string; order: "asc" | "desc" | null }
    | { type: "Search"; indexName: string };
  operators: ({ filter: JSONValue } | { limit: number })[];
};

/** Decodes a value Convex encoded with convexOrUndefinedToJson. */
function fromJsonOrUndefined(json: JSONValue): Value | undefined {
  if (typeof json === "object" && json !== null && !Array.isArray(json) && "$undefined" in json) {
    return undefined;
  }
  return jsonToConvex(json);
}

type FilterJson = Record<string, JSONValue>;

function evaluateJson(expr: JSONValue, doc: Doc): Value | undefined {
  const e = expr as FilterJson;
  const [op] = Object.keys(e);
  const arg = e[op];
  const at = (i: number) => evaluateJson((arg as JSONValue[])[i], doc);
  switch (op) {
    case "$literal":
      return fromJsonOrUndefined(arg);
    case "$field":
      return fieldValue(doc, arg as string);
    case "$eq":
      return compareValues(at(0), at(1)) === 0;
    case "$neq":
      return compareValues(at(0), at(1)) !== 0;
    case "$lt":
      return compareValues(at(0), at(1)) < 0;
    case "$lte":
      return compareValues(at(0), at(1)) <= 0;
    case "$gt":
      return compareValues(at(0), at(1)) > 0;
    case "$gte":
      return compareValues(at(0), at(1)) >= 0;
    case "$and":
      return (arg as JSONValue[]).every((x) => evaluateJson(x, doc) === true);
    case "$or":
      return (arg as JSONValue[]).some((x) => evaluateJson(x, doc) === true);
    case "$not":
      return evaluateJson(arg, doc) !== true;
    case "$neg": {
      const x = evaluateJson(arg, doc);
      if (typeof x === "number" || typeof x === "bigint") return -x;
      throw new Error("filter: $neg needs a number or a bigint");
    }
    case "$add":
    case "$sub":
    case "$mul":
    case "$div":
    case "$mod": {
      const a = at(0);
      const b = at(1);
      const both =
        (typeof a === "number" && typeof b === "number") ||
        (typeof a === "bigint" && typeof b === "bigint");
      if (!both) throw new Error(`filter: ${op} needs two numbers or two bigints`);
      const x = a as number;
      const y = b as number;
      return op === "$add"
        ? x + y
        : op === "$sub"
          ? x - y
          : op === "$mul"
            ? x * y
            : op === "$div"
              ? x / y
              : x % y;
    }
    default:
      throw new Error(`filter: unsupported operator ${op}`);
  }
}

/** The plan for a serialized query, plus its `take` limit if any. */
export function planFromSerialized(
  store: Store,
  query: SerializedQuery,
): { plan: ScanPlan; limit: number | null } {
  const source = query.source;
  if (source.type === "Search") {
    throw new Error("Search indexes are not supported on the Cloudflare platform (ADR 0019)");
  }
  let table: string;
  let index: string;
  let range: RangeExpression[] = [];
  if (source.type === "FullTableScan") {
    table = source.tableName;
    index = "by_creation_time";
  } else {
    const dot = source.indexName.lastIndexOf(".");
    table = source.indexName.slice(0, dot);
    index = source.indexName.slice(dot + 1);
    range = source.range;
  }
  const fields = store.indexesOf(table)[index];
  if (!fields) throw new Error(`Index "${table}.${index}" is not defined`);
  const builder = new IndexRangeBuilder(index, rangeFields(index, fields));
  for (const r of range) {
    const value = fromJsonOrUndefined(r.value);
    switch (r.type) {
      case "Eq":
        builder.eq(r.fieldPath, value);
        break;
      case "Gt":
        builder.gt(r.fieldPath, value as Value);
        break;
      case "Gte":
        builder.gte(r.fieldPath, value as Value);
        break;
      case "Lt":
        builder.lt(r.fieldPath, value as Value);
        break;
      case "Lte":
        builder.lte(r.fieldPath, value as Value);
        break;
    }
  }
  const filters: JSONValue[] = [];
  let limit: number | null = null;
  for (const op of query.operators) {
    if ("filter" in op) filters.push(op.filter);
    else limit = limit === null ? op.limit : Math.min(limit, op.limit);
  }
  return {
    plan: {
      table,
      index,
      ...builder.keyRange(),
      desc: source.order === "desc",
      matches: (doc) => filters.every((f) => evaluateJson(f, doc) === true),
    },
    limit,
  };
}
