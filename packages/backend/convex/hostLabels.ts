/**
 * Host labels: words an operator puts on a Worker (`gpu`, `nvme`, `hk`), and the set of them a
 * Profile pins its Attempts to (ADR 0017).
 *
 * The routing unit stays the Profile. GitHub matches a job to a scale set by labels and then gives
 * it to any idle Runner in that scale set, so no label can choose a Worker inside one Profile. A
 * Profile that needs particular Workers is a Profile of its own, with its own name, and carries
 * `workerLabels`: only Workers carrying every one of them discover it, report readiness for it and
 * are scheduled onto for it.
 */

/** A host label: lowercase, because GitHub's own labels match case-insensitively and so do these. */
export const HOST_LABEL = /^[a-z0-9][a-z0-9._-]{0,62}$/;

/** Far above any real use; bounds what a Profile or a Worker row can hold. */
export const MAX_HOST_LABELS = 16;

/**
 * Normalises a list of host labels: trimmed, lowercased, de-duplicated, sorted. Returns an error
 * naming the first label that is not one, or a list that is too long.
 */
export function normalizeHostLabels(
  raw: readonly unknown[],
): { ok: true; labels: string[] } | { ok: false; error: string } {
  const labels = new Set<string>();
  for (const value of raw) {
    if (typeof value !== "string") return { ok: false, error: "host labels must be strings" };
    const label = value.trim().toLowerCase();
    if (!HOST_LABEL.test(label)) {
      return {
        ok: false,
        error: `${JSON.stringify(value)} is not a host label: lowercase letters, digits, '.', '_' and '-', starting with a letter or digit, at most 63 characters`,
      };
    }
    labels.add(label);
  }
  if (labels.size > MAX_HOST_LABELS) {
    return { ok: false, error: `at most ${MAX_HOST_LABELS} host labels` };
  }
  return { ok: true, labels: [...labels].toSorted() };
}

/**
 * The labels a Profile requires that a Worker does not carry; empty when the Worker may serve it.
 * A Worker's labels were written before this check existed in any case, so compare lowercased.
 */
export function missingHostLabels(
  required: readonly string[] | undefined,
  carried: readonly string[] | undefined,
): string[] {
  if (required === undefined || required.length === 0) return [];
  const have = new Set((carried ?? []).map((label) => label.trim().toLowerCase()));
  return required.filter((label) => !have.has(label.toLowerCase()));
}

export function carriesHostLabels(
  required: readonly string[] | undefined,
  carried: readonly string[] | undefined,
) {
  return missingHostLabels(required, carried).length === 0;
}

/** The detail a Worker that lost a label shows for a Profile it can no longer serve. */
export function missingHostLabelsDetail(missing: readonly string[]) {
  const noun = missing.length === 1 ? "host label" : "host labels";
  return `this Worker lacks the ${noun} ${missing.join(", ")} the Profile is pinned to`;
}
