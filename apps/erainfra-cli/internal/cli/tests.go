package cli

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"unicode"
)

type testTotals struct {
	Tests      int64 `json:"tests"`
	Passed     int64 `json:"passed"`
	Failed     int64 `json:"failed"`
	Errored    int64 `json:"errored"`
	Skipped    int64 `json:"skipped"`
	Flaky      int64 `json:"flaky"`
	DurationMs int64 `json:"durationMs"`
}

type testCaseRow struct {
	ID         string  `json:"id"`
	Suite      *string `json:"suite"`
	Name       string  `json:"name"`
	Status     string  `json:"status"`
	DurationMs int64   `json:"durationMs"`
	Message    *string `json:"message"`
}

type testRunRow struct {
	AttemptID  string        `json:"attemptId"`
	Repository *string       `json:"repository"`
	Branch     *string       `json:"branch"`
	Job        *string       `json:"job"`
	Commit     *string       `json:"commit"`
	RecordedAt *string       `json:"recordedAt"`
	Truncated  bool          `json:"truncated"`
	Totals     testTotals    `json:"totals"`
	Failures   []testCaseRow `json:"failures"`
}

type flakyTestRow struct {
	Repository  string  `json:"repository"`
	ID          string  `json:"id"`
	Suite       *string `json:"suite"`
	Name        string  `json:"name"`
	LastSeenAt  *string `json:"lastSeenAt"`
	Occurrences int64   `json:"occurrences"`
	Evidence    string  `json:"evidence"`
	Branch      *string `json:"branch"`
	Message     *string `json:"message"`
}

var testFilterFlags = []flagSpec{
	{name: "repo", metavar: "OWNER/NAME", usage: "only this repository"},
	{name: "since", metavar: "SPAN|TIME", usage: "within a span (24h, 7d, 30d) or after an RFC 3339 time"},
	{name: "limit", metavar: "N", usage: "rows, 1 to 100 (default 50)"},
}

func testQuery(in invocation) (url.Values, error) {
	query := url.Values{}
	for _, name := range []string{"repo", "since"} {
		if value, ok := in.value(name); ok {
			query.Set(name, value)
		}
	}
	if limit, ok := in.value("limit"); ok {
		n, err := strconv.Atoi(limit)
		if err != nil || n < 1 || n > 100 {
			return nil, usagef("--limit must be an integer from 1 to 100")
		}
		query.Set("limit", limit)
	}
	return query, nil
}

var testsListCommand = command{
	path:    "tests list",
	summary: "List runs' JUnit results, newest first",
	long: `
Each row is one run (Attempt) that left JUnit XML in its workspace: how many
tests it ran and how they ended. Under each run with failures, its failed,
errored and flaky tests follow, at most 20.

Test names and messages are the job's own output; the table prints them
with control characters removed and json returns them as JSON strings.`,
	flags: append(append([]flagSpec{}, testFilterFlags...),
		flagSpec{name: "failed", usage: "only runs with a failed or errored test"}),
	run: func(ctx context.Context, a *App, in invocation) error {
		query, err := testQuery(in)
		if err != nil {
			return err
		}
		if in.bools["failed"] {
			query.Set("failed", "true")
		}
		c, _, err := a.connect()
		if err != nil {
			return err
		}
		body, err := c.do(ctx, http.MethodGet, "/tests", query)
		if err != nil {
			return err
		}
		if in.format == formatJSON {
			return writeRawJSON(a.Stdout, body)
		}
		var envelope struct {
			Runs []testRunRow `json:"runs"`
		}
		if err := decode(body, &envelope); err != nil {
			return err
		}
		if len(envelope.Runs) == 0 {
			_, _ = fmt.Fprintln(a.Stderr, "No test results match.")
			return nil
		}
		now := a.Now()
		tw := newTable(a.Stdout)
		row(tw, "ATTEMPT", "REPO", "JOB", "BRANCH", "TESTS", "FAILED", "FLAKY", "SKIPPED", "TIME", "RECORDED")
		for _, run := range envelope.Runs {
			duration := run.Totals.DurationMs
			row(tw, run.AttemptID, plain(orDash(run.Repository)), plain(orDash(run.Job)), plain(orDash(run.Branch)),
				strconv.FormatInt(run.Totals.Tests, 10),
				strconv.FormatInt(run.Totals.Failed+run.Totals.Errored, 10),
				strconv.FormatInt(run.Totals.Flaky, 10),
				strconv.FormatInt(run.Totals.Skipped, 10),
				millis(&duration), ago(run.RecordedAt, now))
			for _, failure := range run.Failures {
				row(tw, "", "  "+failure.Status, plain(testLabel(failure.Suite, failure.Name)), "", "", "", "", "",
					millis(&failure.DurationMs), "")
			}
		}
		return tw.Flush()
	},
}

var testsFlakyCommand = command{
	path:    "tests flaky",
	summary: "List tests seen both failing and passing",
	long: `
A test is flaky when it failed and passed in two runs of the same code, or
when its test runner retried it into a pass inside one run (Surefire's
rerunFailingTestsCount, gotestsum --rerun-fails). Two runs are the same code
when they are Attempts of one workflow run, or push, schedule, dispatch or
merge-queue runs of one branch at one commit. EVIDENCE says which. SEEN counts
the runs that showed it.`,
	flags: testFilterFlags,
	run: func(ctx context.Context, a *App, in invocation) error {
		query, err := testQuery(in)
		if err != nil {
			return err
		}
		c, _, err := a.connect()
		if err != nil {
			return err
		}
		body, err := c.do(ctx, http.MethodGet, "/tests/flaky", query)
		if err != nil {
			return err
		}
		if in.format == formatJSON {
			return writeRawJSON(a.Stdout, body)
		}
		var envelope struct {
			FlakyTests []flakyTestRow `json:"flakyTests"`
		}
		if err := decode(body, &envelope); err != nil {
			return err
		}
		if len(envelope.FlakyTests) == 0 {
			_, _ = fmt.Fprintln(a.Stderr, "No flaky tests match.")
			return nil
		}
		now := a.Now()
		tw := newTable(a.Stdout)
		row(tw, "REPO", "TEST", "SEEN", "EVIDENCE", "BRANCH", "LAST SEEN")
		for _, flaky := range envelope.FlakyTests {
			evidence := "failed, then passed"
			if flaky.Evidence == "retried" {
				evidence = "retried into a pass"
			}
			row(tw, plain(flaky.Repository), plain(testLabel(flaky.Suite, flaky.Name)),
				strconv.FormatInt(flaky.Occurrences, 10), evidence, plain(orDash(flaky.Branch)),
				ago(flaky.LastSeenAt, now))
		}
		return tw.Flush()
	},
}

func testLabel(suite *string, name string) string {
	if suite == nil || *suite == "" {
		return name
	}
	return *suite + " › " + name
}

// plain drops control characters from text a job wrote before it reaches a
// terminal, so a test named with an escape sequence cannot restyle or retitle
// the operator's terminal. The control plane refuses such names already; this
// does not rely on it.
func plain(value string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, value)
}
