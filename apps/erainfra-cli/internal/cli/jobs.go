package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"time"
)

type attemptRow struct {
	ID             string  `json:"id"`
	Profile        string  `json:"profile"`
	State          string  `json:"state"`
	Result         *string `json:"result"`
	Worker         *string `json:"worker"`
	Repo           *string `json:"repo"`
	Job            *string `json:"job"`
	WorkflowRunID  *int64  `json:"workflowRunId"`
	WorkflowRunURL *string `json:"workflowRunUrl"`
	CreatedAt      *string `json:"createdAt"`
	QueuedAt       *string `json:"queuedAt"`
	StartedAt      *string `json:"startedAt"`
	FinishedAt     *string `json:"finishedAt"`
	QueueWaitMs    *int64  `json:"queueWaitMs"`
	DurationMs     *int64  `json:"durationMs"`
	Error          *string `json:"error"`
}

type attemptPage struct {
	Attempts   []json.RawMessage `json:"attempts"`
	NextCursor *string           `json:"nextCursor"`
}

// A --since span as the operator API reads it (convex/operatorHttp.ts parseSince).
var sinceSpan = regexp.MustCompile(`^([1-9][0-9]{0,5})([mhd])$`)

var sinceUnit = map[string]time.Duration{"m": time.Minute, "h": time.Hour, "d": 24 * time.Hour}

// resolveSince turns a span such as 7d into the RFC 3339 time it means at now. The API resolves a
// span against its own clock on every request, and a cursor is bound to the window it was issued
// for, so a span sent with a cursor names a later window and the API refuses the cursor. Anything
// that is not a span is returned unchanged for the API to judge.
func resolveSince(value string, now time.Time) (string, bool) {
	match := sinceSpan.FindStringSubmatch(value)
	if match == nil {
		return value, false
	}
	n, _ := strconv.Atoi(match[1])
	return now.Add(-time.Duration(n) * sinceUnit[match[2]]).UTC().Format("2006-01-02T15:04:05.000Z"), true
}

// maxPages bounds `jobs list --all`: 100 pages of 100 is ten thousand
// Attempts, past which a script should narrow with --since.
const maxPages = 100

var jobsListCommand = command{
	path:    "jobs list",
	summary: "List jobs (Attempts), newest first",
	long: `
Each row is one Attempt: one GitHub job run in one disposable boundary. WAIT is
how long GitHub held the job before a Runner of this fleet took it; DURATION is
from the job starting to it finishing.

A page holds --limit Attempts (default 50). When there are more, the table
mode prints the --cursor for the next page on standard error, and json carries
it as nextCursor. --all follows the cursor to the end. A --repo filter can
return a page shorter than --limit before the last page.

A --since span is turned into a time once, before the first page, so every
page covers the same window. A cursor only works with the filters of the page
that returned it, so the hint for the next page names that time.`,
	flags: []flagSpec{
		{name: "profile", metavar: "NAME", usage: "only this Profile"},
		{name: "state", metavar: "STATE", usage: "pending, preparing, ready, running, completed, cancelled or failed"},
		{name: "repo", metavar: "OWNER/NAME", usage: "only jobs from this repository"},
		{name: "since", metavar: "SPAN|TIME", usage: "created within a span (30m, 24h, 7d) or after an RFC 3339 time"},
		{name: "limit", metavar: "N", usage: "Attempts per page, 1 to 100 (default 50)"},
		{name: "cursor", metavar: "CURSOR", usage: "continue from a previous page"},
		{name: "all", usage: "follow the cursor and print every matching Attempt"},
	},
	run: func(ctx context.Context, a *App, in invocation) error {
		query := url.Values{}
		for _, name := range []string{"profile", "state", "repo", "cursor"} {
			if value, ok := in.value(name); ok {
				query.Set(name, value)
			}
		}
		span, hasSince := in.value("since")
		resolved, fromSpan := resolveSince(span, a.Now())
		if hasSince {
			query.Set("since", resolved)
		}
		if limit, ok := in.value("limit"); ok {
			n, err := strconv.Atoi(limit)
			if err != nil || n < 1 || n > 100 {
				return usagef("--limit must be an integer from 1 to 100")
			}
			query.Set("limit", limit)
		} else if in.bools["all"] {
			query.Set("limit", "100")
		}
		c, _, err := a.connect()
		if err != nil {
			return err
		}

		var all []json.RawMessage
		var next *string
		for pages := 0; ; pages++ {
			body, err := c.do(ctx, http.MethodGet, "/attempts", query)
			if err != nil {
				return err
			}
			var page attemptPage
			if err := decode(body, &page); err != nil {
				return err
			}
			all = append(all, page.Attempts...)
			next = page.NextCursor
			if !in.bools["all"] || next == nil {
				break
			}
			if pages+1 >= maxPages {
				return fmt.Errorf("stopped after %d pages; narrow the list with --since", maxPages)
			}
			query.Set("cursor", *next)
		}

		if in.format == formatJSON {
			if all == nil {
				all = []json.RawMessage{}
			}
			return writeJSON(a.Stdout, attemptPage{Attempts: all, NextCursor: next})
		}
		rows := make([]attemptRow, 0, len(all))
		for _, raw := range all {
			var r attemptRow
			if err := decode(raw, &r); err != nil {
				return err
			}
			rows = append(rows, r)
		}
		if len(rows) == 0 {
			_, _ = fmt.Fprintln(a.Stderr, "No Attempts match.")
		} else {
			now := a.Now()
			tw := newTable(a.Stdout)
			row(tw, "ID", "STATE", "RESULT", "PROFILE", "REPO", "JOB", "WORKER", "WAIT", "DURATION", "CREATED")
			for _, r := range rows {
				row(tw, r.ID, r.State, orDash(r.Result), r.Profile, orDash(r.Repo), orDash(r.Job),
					orDash(r.Worker), millis(r.QueueWaitMs), millis(r.DurationMs), ago(r.CreatedAt, now))
			}
			if err := tw.Flush(); err != nil {
				return err
			}
		}
		if next != nil && fromSpan {
			_, _ = fmt.Fprintf(a.Stderr, "More Attempts: add --cursor %s and change --since %s to --since %s\n",
				*next, span, resolved)
		} else if next != nil {
			_, _ = fmt.Fprintf(a.Stderr, "More Attempts: add --cursor %s\n", *next)
		}
		return nil
	},
}

type attemptDetail struct {
	attemptRow
	Executor           string  `json:"executor"`
	ImageRelease       string  `json:"imageRelease"`
	Vcpus              int64   `json:"vcpus"`
	MemoryMiB          int64   `json:"memoryMiB"`
	RunnerName         string  `json:"runnerName"`
	RunnerID           int64   `json:"runnerId"`
	SelectionReason    *string `json:"selectionReason"`
	EventName          *string `json:"eventName"`
	WorkflowRef        *string `json:"workflowRef"`
	ClaimedAt          *string `json:"claimedAt"`
	ReadyAt            *string `json:"readyAt"`
	ExecutorFinishedAt *string `json:"executorFinishedAt"`
	ExecutorExitCode   *int64  `json:"executorExitCode"`
	CancelReason       *string `json:"cancelReason"`
	LastError          *string `json:"lastError"`
	// Cause is set when the runner, not the job's own steps, failed the Attempt.
	// Absent from older control planes.
	Cause *struct {
		Code    string `json:"code"`
		Summary string `json:"summary"`
		Docs    []struct {
			Title string `json:"title"`
			URL   string `json:"url"`
		} `json:"docs"`
	} `json:"cause"`
	// Retiring is set while the control plane waits for GitHub to confirm the
	// Runner is deleted before it ends the Attempt. Absent from older control planes.
	Retiring *struct {
		Outcome string  `json:"outcome"`
		Reason  string  `json:"reason"`
		Since   *string `json:"since"`
	} `json:"retiring"`
}

// retiringSummary is the Retiring row of `jobs view`.
func retiringSummary(d attemptDetail) string {
	if d.Retiring == nil {
		return "-"
	}
	return fmt.Sprintf("since %s, then %s: %s", orDash(d.Retiring.Since), d.Retiring.Outcome, d.Retiring.Reason)
}

func fetchAttempt(ctx context.Context, a *App, id string) ([]byte, attemptDetail, error) {
	c, _, err := a.connect()
	if err != nil {
		return nil, attemptDetail{}, err
	}
	body, err := c.do(ctx, http.MethodGet, "/attempts/"+url.PathEscape(id), nil)
	if err != nil {
		return nil, attemptDetail{}, err
	}
	var envelope struct {
		Attempt attemptDetail `json:"attempt"`
	}
	if err := decode(body, &envelope); err != nil {
		return nil, attemptDetail{}, err
	}
	return body, envelope.Attempt, nil
}

var jobsViewCommand = command{
	path:    "jobs view",
	args:    "<id>",
	minArgs: 1,
	maxArgs: 1,
	summary: "Show one job (Attempt)",
	long: `
Prints where the Attempt ran, its timeline and, for a finished job, GitHub's
result and the run URL. The id is the first column of ` + "`erainfra jobs list`" + `.`,
	run: func(ctx context.Context, a *App, in invocation) error {
		body, d, err := fetchAttempt(ctx, a, in.args[0])
		if err != nil {
			return err
		}
		if in.format == formatJSON {
			return writeRawJSON(a.Stdout, body)
		}
		exit := "-"
		if d.ExecutorExitCode != nil {
			exit = strconv.FormatInt(*d.ExecutorExitCode, 10)
		}
		tw := newTable(a.Stdout)
		for _, field := range [][2]string{
			{"ID", d.ID},
			{"State", d.State},
			{"Result", orDash(d.Result)},
			{"Profile", d.Profile},
			{"Executor", fmt.Sprintf("%s, %d vCPU / %s", d.Executor, d.Vcpus, memory(d.MemoryMiB))},
			{"Image", d.ImageRelease},
			{"Worker", orDash(d.Worker)},
			{"Selection", orDash(d.SelectionReason)},
			{"Repository", orDash(d.Repo)},
			{"Job", orDash(d.Job)},
			{"Event", orDash(d.EventName)},
			{"Workflow ref", orDash(d.WorkflowRef)},
			{"Run", orDash(d.WorkflowRunURL)},
			{"Runner", fmt.Sprintf("%s (GitHub runner id %d)", d.RunnerName, d.RunnerID)},
			{"Created", orDash(d.CreatedAt)},
			{"Claimed", orDash(d.ClaimedAt)},
			{"Boundary ready", orDash(d.ReadyAt)},
			{"Queued on GitHub", orDash(d.QueuedAt)},
			{"Started", orDash(d.StartedAt)},
			{"Finished", orDash(d.FinishedAt)},
			{"Queue wait", millis(d.QueueWaitMs)},
			{"Duration", millis(d.DurationMs)},
			{"Executor exit", exit},
			{"Retiring", retiringSummary(d)},
			{"Cancel reason", orDash(d.CancelReason)},
			{"Last error", orDash(d.LastError)},
		} {
			row(tw, field[0]+":", field[1])
		}
		if d.Cause != nil {
			row(tw, "Runner cause:", d.Cause.Code+": "+d.Cause.Summary)
			for _, doc := range d.Cause.Docs {
				row(tw, "See:", doc.Title+" "+doc.URL)
			}
		}
		return tw.Flush()
	},
}

var jobsLogsCommand = command{
	path:    "jobs logs",
	args:    "<id>",
	minArgs: 1,
	maxArgs: 1,
	summary: "Print a job's log from GitHub, or its run URL",
	long: `
GitHub holds job logs; the control plane stores none. With the GitHub CLI (gh)
installed and logged in, this runs ` + "`gh run view <run> --repo <repo> --log`" + ` and
prints the lines of this job. Without gh, or with --url, it prints the run URL.
Workers keep their own Agent log, read on the Worker with ` + "`rc logs`" + `.`,
	flags: []flagSpec{
		{name: "url", usage: "print the GitHub run URL instead of the log"},
	},
	run: func(ctx context.Context, a *App, in invocation) error {
		_, d, err := fetchAttempt(ctx, a, in.args[0])
		if err != nil {
			return err
		}
		if d.WorkflowRunURL == nil || d.WorkflowRunID == nil || d.Repo == nil {
			return fmt.Errorf("attempt %s never ran a GitHub job (state %s), so GitHub has no log for it; "+
				"for why it did not start, see `erainfra jobs view %s` and the Worker's `rc logs`", d.ID, d.State, d.ID)
		}
		if in.format == formatJSON {
			return writeJSON(a.Stdout, map[string]any{"id": d.ID, "workflowRunUrl": *d.WorkflowRunURL})
		}
		gh, lookErr := a.LookPath("gh")
		if in.bools["url"] || lookErr != nil {
			if lookErr != nil && !in.bools["url"] {
				_, _ = fmt.Fprintln(a.Stderr, "The GitHub CLI (gh) is not installed; open the run instead:")
			}
			_, err := fmt.Fprintln(a.Stdout, *d.WorkflowRunURL)
			return err
		}
		out, err := a.RunGH(ctx, gh, []string{
			"run", "view", strconv.FormatInt(*d.WorkflowRunID, 10), "--repo", *d.Repo, "--log",
		}, a.Stderr)
		if err != nil {
			var exitErr interface{ ExitCode() int }
			if errors.As(err, &exitErr) {
				return fmt.Errorf("gh could not fetch the log (exit %d); the run is %s", exitErr.ExitCode(), *d.WorkflowRunURL)
			}
			return fmt.Errorf("run gh: %w", err)
		}
		_, err = a.Stdout.Write(jobLines(out, d.Job))
		return err
	},
}

// jobLines keeps the lines of one job from `gh run view --log`, which prefixes
// every line with "<job name>\t<step name>\t". A run can hold several jobs and
// JobStarted carries no numeric job id for `gh run view --job`, so the job's
// display name is what selects them. When nothing matches, every line is kept
// rather than printing nothing.
func jobLines(log []byte, job *string) []byte {
	if job == nil || *job == "" {
		return log
	}
	prefix := []byte(*job + "\t")
	var kept bytes.Buffer
	for _, line := range bytes.SplitAfter(log, []byte("\n")) {
		if bytes.HasPrefix(line, prefix) {
			kept.Write(line)
		}
	}
	if kept.Len() == 0 {
		return log
	}
	return kept.Bytes()
}
