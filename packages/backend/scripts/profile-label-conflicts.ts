/**
 * Lists pairs of active Profiles whose scale sets share labels, so GitHub can run either one's jobs
 * on the other (convex/scaleSetLabels.ts, ADR 0017). Read-only: it reads the `profiles` rows a
 * deployment exports and writes nothing anywhere.
 *
 * Run it against production before deploying a backend that refuses new conflicts, to see which
 * Profiles that backend will keep with a warning. It needs no function on the deployment, so it
 * works against a backend of any age. Export to a file first, so a failed export stops the command
 * instead of reaching this script as empty input:
 *
 *   npx convex data profiles --prod --limit 10000 --format jsonl > profiles.jsonl &&
 *     pnpm --filter @erainfra/backend --silent profile-label-conflicts "$PWD/profiles.jsonl"
 *
 * It also reads the rows from stdin, as JSON lines or one JSON array. Exit codes:
 *
 *   0  no conflict, and the export showed every active Profile's labels
 *   1  at least one conflicting pair
 *   2  the input could not be read, or held no Profile at all
 *   3  no conflict among what the export shows, but some active Profiles carry no labels in it
 *
 * A row without labels is what a backend that never stored them exports (v0.2.0-rc.10 and
 * earlier). Its controller still registers with RC_LABELS from its env file, which this script
 * cannot see, so it names those Profiles instead of calling them safe.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { labelConflicts, type ScaleSetProfile } from "../convex/scaleSetLabels.ts";

type Row = ScaleSetProfile & { state?: string };

export function parseRows(text: string): Row[] {
  const trimmed = text.trim();
  const values: unknown[] =
    trimmed === ""
      ? []
      : trimmed.startsWith("[")
        ? (JSON.parse(trimmed) as unknown[])
        : trimmed
            .split("\n")
            .filter((line) => line.trim() !== "")
            .map((line) => JSON.parse(line) as unknown);
  // A deployment that runs CI has at least one Profile, so no rows means the export failed or read
  // the wrong deployment. Reporting "no conflicts" for that would pass the check it should fail.
  if (values.length === 0)
    throw new Error(
      "read no Profile rows; the export failed or named a deployment with no Profiles",
    );
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
  const unlabeled = active
    .filter((row) => row.labels === undefined || row.labels.length === 0)
    .map((row) => row.name)
    .toSorted();
  const lines =
    conflicts.length === 0
      ? [`No conflicts among ${active.length} active Profiles.`]
      : [
          `${conflicts.length} conflicting pair(s) among ${active.length} active Profiles:`,
          ...conflicts.map(
            (conflict) => `${conflict.profile} / ${conflict.other}: ${conflict.reason}`,
          ),
        ];
  const warnings =
    unlabeled.length === 0
      ? []
      : [
          `${unlabeled.length} active Profile(s) carry no labels in this export: ${unlabeled.join(", ")}.`,
          "The deployment does not record the labels their controllers register with (RC_LABELS), so only their names were compared.",
          "On each controller host, `sudo grep -H LABELS= /etc/runner-center/profiles/*.env` lists them. No Profile's labels may include another Profile's name.",
        ];
  return { conflicts, unlabeled, lines, warnings };
}

/** The exit status for a report: a conflict first, then labels the export could not show. */
export function exitCode(result: { conflicts: readonly unknown[]; unlabeled: readonly string[] }) {
  if (result.conflicts.length > 0) return 1;
  return result.unlabeled.length > 0 ? 3 : 0;
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
  const result = report(rows);
  for (const line of result.lines) console.log(line);
  for (const line of result.warnings) console.error(line);
  process.exit(exitCode(result));
}
