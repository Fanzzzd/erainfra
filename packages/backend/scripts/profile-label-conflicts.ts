/**
 * Lists pairs of active Profiles whose scale sets share labels, so GitHub can run either one's jobs
 * on the other (convex/scaleSetLabels.ts, ADR 0017). Read-only: it reads the `profiles` rows a
 * deployment exports and writes nothing anywhere.
 *
 * Run it against production before deploying a backend that refuses new conflicts, to see which
 * Profiles that backend will keep with a warning. It needs no function on the deployment, so it
 * works against a backend of any age:
 *
 *   npx convex data profiles --prod --limit 10000 --format jsonl \
 *     | pnpm --filter @erainfra/backend --silent profile-label-conflicts
 *
 * It also takes a file of those rows as its argument, as JSON lines or one JSON array. It exits 0
 * when there is no conflict, 1 when there is, and 2 when the input cannot be read.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { labelConflicts, type ScaleSetProfile } from "../convex/scaleSetLabels.ts";

type Row = ScaleSetProfile & { state?: string };

export function parseRows(text: string): Row[] {
  const trimmed = text.trim();
  if (trimmed === "") return [];
  const values: unknown[] = trimmed.startsWith("[")
    ? (JSON.parse(trimmed) as unknown[])
    : trimmed
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as unknown);
  return values.map((value, index) => {
    const row = value as Partial<Row> | null;
    if (
      row === null ||
      typeof row !== "object" ||
      typeof row.name !== "string" ||
      typeof row.scaleSetName !== "string" ||
      (row.labels !== undefined && !Array.isArray(row.labels))
    ) {
      throw new Error(`row ${index + 1} is not a Profile: it needs a name and a scaleSetName`);
    }
    return row as Row;
  });
}

export function report(rows: readonly Row[]) {
  const active = rows.filter((row) => row.state === undefined || row.state === "active");
  const conflicts = labelConflicts(active);
  const lines =
    conflicts.length === 0
      ? [`No conflicts among ${active.length} active Profiles.`]
      : [
          `${conflicts.length} conflicting pair(s) among ${active.length} active Profiles:`,
          ...conflicts.map(
            (conflict) => `${conflict.profile} / ${conflict.other}: ${conflict.reason}`,
          ),
        ];
  return { conflicts, lines };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const source = process.argv[2];
  let rows: Row[];
  try {
    rows = parseRows(readFileSync(source ?? 0, "utf8"));
  } catch (error) {
    console.error(`profile-label-conflicts: ${(error as Error).message}`);
    process.exit(2);
  }
  const { conflicts, lines } = report(rows);
  for (const line of lines) console.log(line);
  process.exit(conflicts.length === 0 ? 0 : 1);
}
