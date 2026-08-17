// Stage 1 of retiring "Portless" from running systems (ADR 0004; CONTEXT.md rule 4).
//
// Rule 4 says no identifier a running system already holds may change, because a mistake there
// silently disconnects live Nodes or empties a Hub. A name can still be retired — in three
// releases, not one. This is the first: every consumer learns to accept BOTH names, prefers the
// new one, and says so when the old one is what it found. Nothing in this release WRITES an
// `ERAINFRA_*` name, so on every box in the field today each of these returns exactly the
// `PORTLESS_*` value it returned before and prints one line. That is the entire behavioural change.
//
// This is the idiom convex/installScript.ts:649 already established for the
// `runner-center-agent-` → `erainfra-agent-` asset rename ("Pre-rename releases keep their
// published asset names forever"): try the new name, fall back to the old, delete nothing. ADR 0005
// names it as the pattern to reuse, so there is one of these in the codebase rather than two.
//
// Both names are passed as literals at every call site on purpose. The CI gate from #61 is a
// set-difference over the diff — a frozen identifier that leaves the tree fails it — so a helper
// that took only the suffix would delete all 30 of the Hub's `PORTLESS_*` literals in one commit
// and could not tell that apart from a rename.

import { existsSync } from "node:fs";

// Once per retired name per process. These fire from module scope, from request handlers and from
// timers; a Hub that printed the same line on every deploy would train its operator to ignore it.
const warned = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[erainfra] ${message}`);
}

/**
 * Read a renamed environment variable: the new name wins, the old name still works and warns.
 *
 * `undefined` (not `""`) is what counts as unset, matching the `??` the call sites already use —
 * `PORTLESS_BIND=` means "bound to the empty string", and a helper that treated it as absent would
 * change what a box does rather than only what it prints.
 */
export function renamedEnv(newName: string, oldName: string): string | undefined {
  const current = process.env[newName];
  if (current !== undefined) return current;
  const retired = process.env[oldName];
  if (retired === undefined) return undefined;
  warnOnce(
    oldName,
    `${oldName} is a retired name — set ${newName} instead. The old name still works; a later release will say when it stops.`,
  );
  return retired;
}

/**
 * Read a renamed *path*: the new location wins if it already exists, otherwise the old one.
 *
 * Falling back is not enough on its own for a path that gets CREATED when it is missing — that is
 * how you get a second, empty state directory beside the real one. So this never invents the new
 * location: with neither present it returns the old path, and the caller creates it exactly where
 * it creates it today. The release that starts writing new names is the one that flips this.
 */
export function renamedPath(newPath: string, oldPath: string): string {
  if (existsSync(newPath)) return newPath;
  if (existsSync(oldPath)) {
    warnOnce(
      oldPath,
      `${oldPath} is a retired location — a later release moves it to ${newPath}. Nothing to do yet.`,
    );
  }
  return oldPath;
}

/**
 * Warn once about a retired *value* — a cookie name, a filename, a unit — rather than a variable.
 * Same once-per-process budget as the two readers above, so all three share one warn-once set.
 */
export function retiredName(old: string, next: string, note: string): void {
  warnOnce(old, `${old} is a retired name — a later release moves it to ${next}. ${note}`);
}

/** Test seam: the warn-once state is per process, and a suite asserts on the warnings. */
export function resetRenameWarnings(): void {
  warned.clear();
}
