/**
 * The Worker-side environment under both of its names: the legacy `RC_<NAME>`
 * every Worker in the field holds, and `ERAINFRA_<NAME>`, the name it is moving
 * to (docs/runbooks/rename-phase-2.md, section 1). This is the expand step:
 * nothing here writes an ERAINFRA_ name.
 *
 * The same rules as the Go package internal/dualenv and the sh and PowerShell
 * copies in provisioners/:
 *
 * - `ERAINFRA_<NAME>` wins over `RC_<NAME>`.
 * - An empty value counts as unset, under either name, as it did at every
 *   `process.env.RC_<NAME>?.trim() || default` read before this file existed.
 * - Both set to different values is an error naming both. Values never appear
 *   in it, because some of these variables are secrets.
 *
 * Unlike apps/hub/src/env.ts it does not warn when only the old name is set.
 * This release still writes RC_ names itself (start-agent.sh, and every child
 * process below), so a warning would fire on every Attempt with nothing for an
 * operator to change. The release that flips the writers adds it.
 */

export type LegacyName = `RC_${string}`;

const LEGACY_PREFIX = "RC_";
const NEW_PREFIX = "ERAINFRA_";

export function newName(legacy: LegacyName): string {
  if (!legacy.startsWith(LEGACY_PREFIX) || legacy.length === LEGACY_PREFIX.length) {
    throw new Error(`${legacy} is not an RC_ variable name`);
  }
  return NEW_PREFIX + legacy.slice(LEGACY_PREFIX.length);
}

export class DualEnvConflictError extends Error {
  readonly newName: string;
  readonly legacyName: string;

  constructor(current: string, legacy: string) {
    super(
      `${current} and ${legacy} are both set, to different values; ` +
        "remove one, or give both the same value",
    );
    this.name = "DualEnvConflictError";
    this.newName = current;
    this.legacyName = legacy;
  }
}

/**
 * The value of `ERAINFRA_<NAME>`, or of `RC_<NAME>` when the new name is unset
 * or empty; `undefined` when neither holds a value. Throws when both are set to
 * different values.
 */
export function dualEnv(
  legacy: LegacyName,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const name = newName(legacy);
  const current = env[name] || undefined;
  const old = env[legacy] || undefined;
  if (current !== undefined && old !== undefined && current !== old) {
    throw new DualEnvConflictError(name, legacy);
  }
  return current ?? old;
}

/**
 * Throws, naming every pair, when any `RC_<NAME>` in the environment has an
 * `ERAINFRA_<NAME>` counterpart set to a different value. The Agent calls it
 * once at startup, so a conflict stops the process before it registers rather
 * than at the first Attempt that reads the variable.
 */
export function assertNoDualEnvConflicts(env: NodeJS.ProcessEnv = process.env) {
  const legacyNames = Object.keys(env).filter(
    (name) => name.startsWith(LEGACY_PREFIX) && name.length > LEGACY_PREFIX.length,
  );
  // False positive: filter() has already produced a fresh array, so sort()
  // mutates nothing. toSorted() is ES2023 and this package targets ES2022.
  // oxlint-disable-next-line unicorn/no-array-sort
  const conflicts = legacyNames.sort().flatMap((legacy) => {
    try {
      dualEnv(legacy as LegacyName, env);
      return [];
    } catch (error) {
      return error instanceof DualEnvConflictError ? [error.message] : [];
    }
  });
  if (conflicts.length > 0) {
    throw new Error(conflicts.join("\n"));
  }
}

/**
 * The environment for a child process this Agent starts: its own environment
 * with `overrides` on top. Each RC_ name in `overrides` is a value the Agent
 * decided for this child, so an inherited ERAINFRA_ twin is dropped rather than
 * left to win over it (or to conflict with it) in the child's own dual read.
 * The legacy name is the one written, because a runtime or provisioner from the
 * previous release reads only that.
 */
export function childEnvironment(
  overrides: Record<string, string>,
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...inherited };
  for (const name of Object.keys(overrides)) {
    if (name.startsWith(LEGACY_PREFIX) && name.length > LEGACY_PREFIX.length) {
      delete env[newName(name as LegacyName)];
    }
  }
  return { ...env, ...overrides };
}

/** The runtime CLI the Agent drives on Linux, as start-agent.sh points it. */
export function runtimeBinary(env: NodeJS.ProcessEnv = process.env) {
  return dualEnv("RC_RUNTIME_BINARY", env)?.trim() || "runner-center-runtime";
}
