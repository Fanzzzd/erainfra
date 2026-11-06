import { Badge } from "@/components/ui/badge";
import { formatDuration } from "@/lib/time";

// Test names, suites, files and messages are written by the job under test, so they are rendered
// only as React text children: React escapes them, and nothing here builds HTML or a URL from
// them. Long values wrap or truncate with the full text in a title attribute.

export type TestStatus = "passed" | "failed" | "errored" | "skipped" | "flaky";

export type TestCaseView = {
  testId: string;
  suite?: string;
  name: string;
  file?: string;
  status: TestStatus;
  durationMs: number;
  message?: string;
  retries?: number;
};

export type TestTotalsView = {
  tests: number;
  passed: number;
  failed: number;
  errored: number;
  skipped: number;
  flaky: number;
  durationMs: number;
};

const statusVariant = {
  passed: "success",
  failed: "destructive",
  errored: "destructive",
  skipped: "outline",
  flaky: "warning",
} as const;

export function TestStatusBadge({ status }: { status: TestStatus }) {
  return (
    <Badge variant={statusVariant[status]} className="capitalize">
      {status}
    </Badge>
  );
}

/** A test's duration: milliseconds matter here, where a run's do not. */
export function formatTestDuration(milliseconds: number) {
  if (milliseconds < 1000) return `${milliseconds} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)} s`;
  return formatDuration(milliseconds);
}

/** One line: "120 tests · 2 failed · 1 flaky · 3 skipped · 41.2 s". */
export function totalsLine(totals: TestTotalsView) {
  const parts = [`${totals.tests} tests`];
  if (totals.failed > 0) parts.push(`${totals.failed} failed`);
  if (totals.errored > 0) parts.push(`${totals.errored} errored`);
  if (totals.flaky > 0) parts.push(`${totals.flaky} flaky`);
  if (totals.skipped > 0) parts.push(`${totals.skipped} skipped`);
  if (totals.durationMs > 0) parts.push(formatTestDuration(totals.durationMs));
  return parts.join(" · ");
}

export function TestName({ name, suite, file }: { name: string; suite?: string; file?: string }) {
  const context = [suite, file].filter((value) => value !== undefined && value !== "").join(" · ");
  return (
    <div className="min-w-0">
      <p className="truncate font-mono text-xs text-foreground" title={name}>
        {name}
      </p>
      {context !== "" && (
        <p className="truncate text-[11px] text-subtle-foreground" title={context}>
          {context}
        </p>
      )}
    </div>
  );
}

export function TestMessage({ message }: { message?: string }) {
  if (message === undefined || message === "") return null;
  return (
    <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted px-2.5 py-2 font-mono text-[11px] leading-4 text-muted-foreground">
      {message}
    </pre>
  );
}

/** The cases one run listed, failures first as the report orders them. */
export function TestCaseList({ cases }: { cases: TestCaseView[] }) {
  return (
    <ul className="divide-y divide-border">
      {cases.map((testCase) => (
        <li key={testCase.testId} className="flex gap-3 px-4 py-2.5">
          <div className="w-[76px] shrink-0 pt-0.5">
            <TestStatusBadge status={testCase.status} />
          </div>
          <div className="min-w-0 flex-1">
            <TestName name={testCase.name} suite={testCase.suite} file={testCase.file} />
            {testCase.status !== "passed" && <TestMessage message={testCase.message} />}
          </div>
          <div className="shrink-0 text-right text-xs tabular-nums text-muted-foreground">
            {formatTestDuration(testCase.durationMs)}
            {testCase.retries !== undefined && testCase.retries > 0 && (
              <p className="text-[11px] text-subtle-foreground">
                {testCase.retries} {testCase.retries === 1 ? "retry" : "retries"}
              </p>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
