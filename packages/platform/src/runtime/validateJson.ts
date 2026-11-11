// Checks function arguments and return values against the JSON validators Convex exports
// (`exportArgs()`, `exportReturns()`), as the Convex server does before and after a call.

import type { Value } from "convex/values";

export type JsonValidator =
  | { type: "any" | "null" | "number" | "bigint" | "boolean" | "string" | "bytes" }
  | { type: "literal"; value: unknown }
  | { type: "id"; tableName: string }
  | { type: "array"; value: JsonValidator }
  | { type: "union"; value: JsonValidator[] }
  | { type: "object"; value: Record<string, { fieldType: JsonValidator; optional: boolean }> }
  | { type: "record"; keys: JsonValidator; values: { fieldType: JsonValidator } };

function isObject(v: unknown): v is Record<string, Value | undefined> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof ArrayBuffer);
}

function literalValue(v: unknown): unknown {
  // Convex exports bigint literals as { $integer: base64 }.
  if (isObject(v) && "$integer" in v) {
    const bytes = Uint8Array.from(atob(v.$integer as string), (c) => c.charCodeAt(0));
    return new DataView(bytes.buffer).getBigInt64(0, true);
  }
  return v;
}

export function checkJson(
  validator: JsonValidator,
  value: Value | undefined,
  path: string,
  tableOf: (id: string) => string | null,
): string | null {
  switch (validator.type) {
    case "any":
      return null;
    case "null":
      return value === null ? null : `${path} must be null`;
    case "number":
      return typeof value === "number" ? null : `${path} must be a number`;
    case "bigint":
      return typeof value === "bigint" ? null : `${path} must be a bigint`;
    case "boolean":
      return typeof value === "boolean" ? null : `${path} must be a boolean`;
    case "string":
      return typeof value === "string" ? null : `${path} must be a string`;
    case "bytes":
      return value instanceof ArrayBuffer ? null : `${path} must be bytes`;
    case "literal":
      return value === literalValue(validator.value)
        ? null
        : `${path} must be ${JSON.stringify(validator.value)}`;
    case "id":
      if (typeof value !== "string") return `${path} must be an Id`;
      return tableOf(value) === validator.tableName
        ? null
        : `${path} must be an Id of ${validator.tableName}`;
    case "array": {
      if (!Array.isArray(value)) return `${path} must be an array`;
      for (let i = 0; i < value.length; i++) {
        const err = checkJson(validator.value, value[i], `${path}[${i}]`, tableOf);
        if (err) return err;
      }
      return null;
    }
    case "union":
      return validator.value.some((m) => checkJson(m, value, path, tableOf) === null)
        ? null
        : `${path} matches no member of its union`;
    case "object": {
      if (!isObject(value)) return `${path} must be an object`;
      for (const [name, { fieldType, optional }] of Object.entries(validator.value)) {
        const v = value[name];
        if (v === undefined) {
          if (optional) continue;
          return `${path}.${name} is required`;
        }
        const err = checkJson(fieldType, v, `${path}.${name}`, tableOf);
        if (err) return err;
      }
      for (const name of Object.keys(value)) {
        if (!(name in validator.value) && value[name] !== undefined)
          return `${path}.${name} is not expected`;
      }
      return null;
    }
    case "record": {
      if (!isObject(value)) return `${path} must be an object`;
      for (const [k, v] of Object.entries(value)) {
        const keyErr = checkJson(validator.keys, k, `${path} key ${k}`, tableOf);
        if (keyErr) return keyErr;
        const err = checkJson(validator.values.fieldType, v, `${path}.${k}`, tableOf);
        if (err) return err;
      }
      return null;
    }
  }
}
