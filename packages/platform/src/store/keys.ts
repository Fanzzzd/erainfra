// Order-preserving encoding of Convex values into index keys.
//
// Convex sorts values as undefined < null < int64 < float64 < boolean < string < bytes < array <
// object (convex/values compareValues). Each encoded value is self-delimiting, so concatenating the
// encodings of an index's fields gives a key whose byte order is the tuple order. Keys are stored
// as lowercase hex, so SQLite's default BINARY comparison of TEXT compares them byte by byte.
//
// Because a key is only hex digits, PREFIX + "g" is greater than every key that starts with PREFIX
// and smaller than every key that does not and sorts after it. Range bounds use that.

import type { Value } from "convex/values";

const TAG = {
  undefined: 0x01,
  null: 0x02,
  int64: 0x03,
  float64: 0x04,
  boolean: 0x05,
  string: 0x06,
  bytes: 0x07,
  array: 0x08,
  object: 0x0a,
} as const;

const TERMINATOR = 0x00;
const ESCAPE = 0xff;

class ByteWriter {
  private bytes: number[] = [];
  push(...b: number[]): void {
    for (const x of b) this.bytes.push(x);
  }
  // A terminated byte string: each 0x00 becomes 0x00 0xFF, and 0x00 0x00 ends it. A shorter
  // string therefore sorts before every longer string it is a prefix of.
  escaped(data: Uint8Array): void {
    for (const b of data) {
      if (b === TERMINATOR) this.bytes.push(TERMINATOR, ESCAPE);
      else this.bytes.push(b);
    }
    this.bytes.push(TERMINATOR, TERMINATOR);
  }
  hex(): string {
    let out = "";
    for (const b of this.bytes) out += b.toString(16).padStart(2, "0");
    return out;
  }
}

const utf8 = new TextEncoder();

function writeValue(w: ByteWriter, v: Value | undefined): void {
  if (v === undefined) return w.push(TAG.undefined);
  if (v === null) return w.push(TAG.null);
  if (typeof v === "bigint") {
    // Two's complement int64 with the sign bit flipped sorts like the number.
    const u = BigInt.asUintN(64, v) ^ 0x8000000000000000n;
    w.push(TAG.int64);
    for (let shift = 56n; shift >= 0n; shift -= 8n) w.push(Number((u >> shift) & 0xffn));
    return;
  }
  if (typeof v === "number") {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, v);
    // IEEE 754 bits sort like the number once negatives are inverted and positives get the
    // sign bit set. -0 lands just below +0, as compareValues orders them.
    const negative = (view.getUint8(0) & 0x80) !== 0;
    w.push(TAG.float64);
    for (let i = 0; i < 8; i++) {
      const b = view.getUint8(i);
      w.push(negative ? ~b & 0xff : i === 0 ? b | 0x80 : b);
    }
    return;
  }
  if (typeof v === "boolean") return w.push(TAG.boolean, v ? 1 : 0);
  if (typeof v === "string") {
    w.push(TAG.string);
    return w.escaped(utf8.encode(v));
  }
  if (v instanceof ArrayBuffer) {
    w.push(TAG.bytes);
    return w.escaped(new Uint8Array(v));
  }
  if (Array.isArray(v)) {
    w.push(TAG.array);
    for (const item of v) writeValue(w, item);
    return w.push(TERMINATOR);
  }
  // compareValues compares objects as their key-sorted [key, value] pairs.
  w.push(TAG.object);
  for (const key of Object.keys(v).toSorted()) {
    w.push(TAG.array);
    writeValue(w, key);
    writeValue(w, (v as Record<string, Value>)[key]);
    w.push(TERMINATOR);
  }
  w.push(TERMINATOR);
}

/** The hex key of a tuple of values, in Convex order. */
export function encodeKey(values: readonly (Value | undefined)[]): string {
  const w = new ByteWriter();
  for (const v of values) writeValue(w, v);
  return w.hex();
}

/** A string greater than every key that starts with `prefix`, and no other key. */
export function prefixEnd(prefix: string): string {
  return `${prefix}g`;
}

/** The key range of every index entry whose leading fields equal `values`. */
export function prefixRange(values: readonly (Value | undefined)[]): { lo: string; hi: string } {
  const prefix = encodeKey(values);
  return { lo: prefix, hi: prefixEnd(prefix) };
}
