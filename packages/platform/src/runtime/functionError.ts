// The error a Convex function call ends with. `data` is a ConvexError's payload, which crosses the
// wire as JSON and becomes a ConvexError again on the client.

import { convexToJson, jsonToConvex, type JSONValue, type Value } from "convex/values";

/** An error a function threw, with ConvexError data decoded. */
export class FunctionError extends Error {
  constructor(
    message: string,
    readonly data: Value | undefined,
  ) {
    super(message);
  }
}

export function asFunctionError(err: unknown): FunctionError {
  if (err instanceof FunctionError) return err;
  const e = err as { message?: string; data?: unknown };
  const isConvexError = typeof err === "object" && err !== null && Symbol.for("ConvexError") in err;
  let data: Value | undefined;
  if (isConvexError || e.data !== undefined) {
    data = typeof e.data === "string" ? jsonToConvex(JSON.parse(e.data)) : (e.data as Value);
  }
  return new FunctionError(e.message ?? String(err), data);
}

// Convex's performAsyncSyscall turns an error with `data` back into a ConvexError, and expects
// `data` as JSON.
export function rethrowable(err: unknown): Error {
  const e = asFunctionError(err);
  const out = new Error(e.message) as Error & { data?: JSONValue };
  if (e.data !== undefined) out.data = convexToJson(e.data);
  return out;
}
