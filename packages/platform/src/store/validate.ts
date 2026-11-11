// Checks a document against its table's Convex validator before a write, as Convex does when
// schema validation is on. The messages name the path, not Convex's exact wording.

import type { GenericValidator, Value } from "convex/values";

type AnyValidator = GenericValidator & {
  kind: string;
  isOptional: "optional" | "required";
  tableName?: string;
  fields?: Record<string, AnyValidator>;
  element?: AnyValidator;
  members?: AnyValidator[];
  key?: AnyValidator;
  value?: AnyValidator | Value;
};

export type IdTableOf = (id: string) => string | null;

function isPlainObject(v: unknown): v is Record<string, Value | undefined> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof ArrayBuffer);
}

function check(
  validator: AnyValidator,
  value: Value | undefined,
  path: string,
  tableOf: IdTableOf,
): string | null {
  switch (validator.kind) {
    case "any":
      return null;
    case "null":
      return value === null ? null : `${path} must be null`;
    case "float64":
      return typeof value === "number" ? null : `${path} must be a number`;
    case "int64":
      return typeof value === "bigint" ? null : `${path} must be a bigint`;
    case "boolean":
      return typeof value === "boolean" ? null : `${path} must be a boolean`;
    case "string":
      return typeof value === "string" ? null : `${path} must be a string`;
    case "bytes":
      return value instanceof ArrayBuffer ? null : `${path} must be bytes`;
    case "literal":
      return value === validator.value
        ? null
        : `${path} must be ${JSON.stringify(validator.value)}`;
    case "id": {
      if (typeof value !== "string") return `${path} must be an Id`;
      const table = tableOf(value);
      return table === validator.tableName
        ? null
        : `${path} must be an Id of ${validator.tableName}`;
    }
    case "array": {
      if (!Array.isArray(value)) return `${path} must be an array`;
      for (let i = 0; i < value.length; i++) {
        const err = check(validator.element as AnyValidator, value[i], `${path}[${i}]`, tableOf);
        if (err) return err;
      }
      return null;
    }
    case "record": {
      if (!isPlainObject(value)) return `${path} must be an object`;
      for (const [k, v] of Object.entries(value)) {
        const keyErr = check(validator.key as AnyValidator, k, `${path} key ${k}`, tableOf);
        if (keyErr) return keyErr;
        const err = check(validator.value as AnyValidator, v, `${path}.${k}`, tableOf);
        if (err) return err;
      }
      return null;
    }
    case "object": {
      if (!isPlainObject(value)) return `${path} must be an object`;
      const fields = validator.fields ?? {};
      for (const [name, field] of Object.entries(fields)) {
        const v = value[name];
        if (v === undefined) {
          if (field.isOptional === "optional") continue;
          return `${path}.${name} is required`;
        }
        const err = check(field, v, `${path}.${name}`, tableOf);
        if (err) return err;
      }
      for (const name of Object.keys(value)) {
        if (!(name in fields) && value[name] !== undefined) {
          return `${path}.${name} is not in the schema`;
        }
      }
      return null;
    }
    case "union": {
      for (const member of validator.members ?? []) {
        if (check(member, value, path, tableOf) === null) return null;
      }
      return `${path} matches no member of its union`;
    }
    default:
      return `${path} has a validator kind the store does not support: ${validator.kind}`;
  }
}

/** Throws when `doc` (without system fields) does not match `validator`. */
export function validateDocument(
  table: string,
  validator: GenericValidator,
  doc: Record<string, Value | undefined>,
  tableOf: IdTableOf,
): void {
  const { _id: _ignoredId, _creationTime: _ignoredTime, ...fields } = doc;
  const err = check(validator as AnyValidator, fields, table, tableOf);
  if (err) throw new Error(`Document does not match the schema: ${err}`);
}
