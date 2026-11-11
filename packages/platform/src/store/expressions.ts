// The builders Convex passes to `withIndex` and `filter`, evaluated by the store instead of the
// Convex server.

import { compareValues, type Value } from "convex/values";

import { encodeKey, prefixEnd } from "./keys.ts";

export type Doc = Record<string, Value | undefined>;

export function fieldValue(doc: Doc, path: string): Value | undefined {
  let current: Value | undefined = doc as Value;
  for (const part of path.split(".")) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    if (current instanceof ArrayBuffer) return undefined;
    current = (current as Record<string, Value | undefined>)[part];
  }
  return current;
}

// ---- index ranges ---------------------------------------------------------------------------

type Bound = { value: Value | undefined; inclusive: boolean };

export class IndexRangeBuilder {
  readonly eqs: (Value | undefined)[] = [];
  lower: Bound | undefined;
  upper: Bound | undefined;
  private next = 0;
  constructor(
    private readonly index: string,
    private readonly fields: readonly string[],
  ) {}

  private field(name: string, op: string): void {
    const expected = this.fields[this.next];
    if (name !== expected) {
      throw new Error(
        `withIndex on ${this.index}: ${op}("${name}") must name "${expected ?? "(no more fields)"}", the next field of the index`,
      );
    }
  }
  eq(name: string, value: Value | undefined): this {
    if (this.lower || this.upper) throw new Error(`withIndex on ${this.index}: eq after a range`);
    this.field(name, "eq");
    this.eqs.push(value);
    this.next++;
    return this;
  }
  gt(name: string, value: Value): this {
    return this.setLower(name, value, false, "gt");
  }
  gte(name: string, value: Value): this {
    return this.setLower(name, value, true, "gte");
  }
  lt(name: string, value: Value): this {
    return this.setUpper(name, value, false, "lt");
  }
  lte(name: string, value: Value): this {
    return this.setUpper(name, value, true, "lte");
  }
  private setLower(name: string, value: Value, inclusive: boolean, op: string): this {
    if (this.upper) throw new Error(`withIndex on ${this.index}: ${op} must come before lt or lte`);
    this.field(name, op);
    this.lower = { value, inclusive };
    return this;
  }
  private setUpper(name: string, value: Value, inclusive: boolean, op: string): this {
    if (this.lower) {
      if (name !== this.fields[this.next])
        throw new Error(`withIndex on ${this.index}: ${op} must name the range field`);
    } else {
      this.field(name, op);
    }
    this.upper = { value, inclusive };
    return this;
  }

  /** The half-open key range [lo, hi) the builder selects. */
  keyRange(): { lo: string; hi: string } {
    const prefix = encodeKey(this.eqs);
    const lo = !this.lower
      ? prefix
      : this.lower.inclusive
        ? prefix + encodeKey([this.lower.value])
        : prefixEnd(prefix + encodeKey([this.lower.value]));
    const hi = !this.upper
      ? prefixEnd(prefix)
      : this.upper.inclusive
        ? prefixEnd(prefix + encodeKey([this.upper.value]))
        : prefix + encodeKey([this.upper.value]);
    return { lo, hi };
  }
}

// ---- filter expressions ---------------------------------------------------------------------

export type Expression =
  | { op: "field"; path: string }
  | { op: "literal"; value: Value | undefined }
  | { op: string; args: Expression[] };

type Operand = Expression | Value | undefined;

const isExpression = (v: unknown): v is Expression =>
  typeof v === "object" && v !== null && "op" in v && EXPRESSION in v;

const EXPRESSION = Symbol("erainfra.expression");

function wrap(e: Expression): Expression {
  Object.defineProperty(e, EXPRESSION, { value: true });
  return e;
}

function toExpression(v: Operand): Expression {
  return isExpression(v) ? v : wrap({ op: "literal", value: v });
}

function nary(op: string, args: Operand[]): Expression {
  return wrap({ op, args: args.map(toExpression) });
}

export const filterBuilder = {
  field: (path: string) => wrap({ op: "field", path }),
  eq: (l: Operand, r: Operand) => nary("eq", [l, r]),
  neq: (l: Operand, r: Operand) => nary("neq", [l, r]),
  lt: (l: Operand, r: Operand) => nary("lt", [l, r]),
  lte: (l: Operand, r: Operand) => nary("lte", [l, r]),
  gt: (l: Operand, r: Operand) => nary("gt", [l, r]),
  gte: (l: Operand, r: Operand) => nary("gte", [l, r]),
  add: (l: Operand, r: Operand) => nary("add", [l, r]),
  sub: (l: Operand, r: Operand) => nary("sub", [l, r]),
  mul: (l: Operand, r: Operand) => nary("mul", [l, r]),
  div: (l: Operand, r: Operand) => nary("div", [l, r]),
  mod: (l: Operand, r: Operand) => nary("mod", [l, r]),
  neg: (x: Operand) => nary("neg", [x]),
  and: (...xs: Operand[]) => nary("and", xs),
  or: (...xs: Operand[]) => nary("or", xs),
  not: (x: Operand) => nary("not", [x]),
};

function arithmetic(op: string, a: Value | undefined, b: Value | undefined): Value | undefined {
  if (typeof a === "bigint" && typeof b === "bigint") {
    switch (op) {
      case "add":
        return a + b;
      case "sub":
        return a - b;
      case "mul":
        return a * b;
      case "div":
        return a / b;
      case "mod":
        return a % b;
    }
  }
  if (typeof a === "number" && typeof b === "number") {
    switch (op) {
      case "add":
        return a + b;
      case "sub":
        return a - b;
      case "mul":
        return a * b;
      case "div":
        return a / b;
      case "mod":
        return a % b;
    }
  }
  throw new Error(`filter: ${op} needs two numbers or two bigints`);
}

export function evaluate(e: Expression, doc: Doc): Value | undefined {
  if (e.op === "field") return fieldValue(doc, (e as { path: string }).path);
  if (e.op === "literal") return (e as { value: Value | undefined }).value;
  const args = (e as { args: Expression[] }).args;
  const v = (i: number) => evaluate(args[i] as Expression, doc);
  switch (e.op) {
    case "eq":
      return compareValues(v(0), v(1)) === 0;
    case "neq":
      return compareValues(v(0), v(1)) !== 0;
    case "lt":
      return compareValues(v(0), v(1)) < 0;
    case "lte":
      return compareValues(v(0), v(1)) <= 0;
    case "gt":
      return compareValues(v(0), v(1)) > 0;
    case "gte":
      return compareValues(v(0), v(1)) >= 0;
    case "and":
      return args.every((_, i) => v(i) === true);
    case "or":
      return args.some((_, i) => v(i) === true);
    case "not":
      return v(0) !== true;
    case "neg": {
      const x = v(0);
      if (typeof x === "number") return -x;
      if (typeof x === "bigint") return -x;
      throw new Error("filter: neg needs a number or a bigint");
    }
    default:
      return arithmetic(e.op, v(0), v(1));
  }
}
