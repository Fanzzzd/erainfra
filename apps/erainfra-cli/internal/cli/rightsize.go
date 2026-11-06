package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
)

type rightsizeSize struct {
	Vcpus     int64 `json:"vcpus"`
	MemoryMiB int64 `json:"memoryMiB"`
}

type rightsizeRow struct {
	Repo               string         `json:"repo"`
	Job                string         `json:"job"`
	Profile            string         `json:"profile"`
	Verdict            string         `json:"verdict"`
	RecommendedProfile *string        `json:"recommendedProfile"`
	SuggestedProfile   *string        `json:"suggestedProfile"`
	Current            rightsizeSize  `json:"current"`
	Target             *rightsizeSize `json:"target"`
	Attempts           int64          `json:"attempts"`
	CPU                struct {
		P95Vcpus float64 `json:"p95Vcpus"`
	} `json:"cpu"`
	Memory struct {
		PeakBytes   int64  `json:"peakBytes"`
		Measure     string `json:"measure"`
		OOMAttempts int64  `json:"oomAttempts"`
	} `json:"memory"`
	Explanation string `json:"explanation"`
}

type rightsizeReport struct {
	Window struct {
		Start string `json:"start"`
	} `json:"window"`
	Scanned         int64           `json:"scanned"`
	Truncated       bool            `json:"truncated"`
	Recommendations []rightsizeRow  `json:"recommendations"`
	Map             json.RawMessage `json:"map"`
}

var verdictLabels = map[string]string{
	"upsize":            "larger",
	"downsize":          "smaller",
	"keep":              "right size",
	"insufficient_data": "not enough data",
}

var rightsizeCommand = command{
	path:    "rightsize",
	summary: "Recommend a Profile size for each workflow job from its measured usage",
	long: `
For every repository and job that ran on this fleet in the window, compares
the CPU p95 and memory peak its Attempts measured with the Profile it ran on,
and names a registered Profile to move to when the job is too big or too
small for it. When no registered Profile fits, it names the Profile to
register, the way ADR 0010 names them.

The policy leans towards leaving a job alone: five finished, measured runs
before any verdict; a smaller Profile only if it keeps p95 CPU at or under 70%
of its vCPUs and the memory peak under it with 30% to spare; a larger one when
the typical run holds CPU at 90% or more, on any OOM kill, or when a Docker
job's working set reaches 90% of its limit. Firecracker memory is the VM's
host-resident memory, so on Firecracker only an OOM kill asks for more.

The window defaults to, and cannot exceed, the 14 days metrics are kept.

--map prints only the recommendations that name a registered Profile, as the
runs-on rewrite a migration tool can apply:
  {"owner/repo": {"<job>": {"<current Profile>": "<recommended Profile>"}}}`,
	flags: []flagSpec{
		{name: "repo", metavar: "OWNER/NAME", usage: "only jobs from this repository"},
		{name: "since", metavar: "SPAN|TIME", usage: "window start: a span (24h, 7d) or an RFC 3339 time (default and maximum 14d)"},
		{name: "map", usage: "print the runs-on map (current Profile to recommended Profile, per repository and job) as JSON"},
	},
	run: func(ctx context.Context, a *App, in invocation) error {
		query := url.Values{}
		for _, name := range []string{"repo", "since"} {
			if value, ok := in.value(name); ok {
				query.Set(name, value)
			}
		}
		c, _, err := a.connect()
		if err != nil {
			return err
		}
		body, err := c.do(ctx, http.MethodGet, "/rightsize", query)
		if err != nil {
			return err
		}
		var report rightsizeReport
		if err := decode(body, &report); err != nil {
			return err
		}
		if in.bools["map"] {
			if len(report.Map) == 0 {
				return writeJSON(a.Stdout, map[string]any{})
			}
			return writeRawJSON(a.Stdout, report.Map)
		}
		if in.format == formatJSON {
			return writeRawJSON(a.Stdout, body)
		}
		if report.Truncated {
			_, _ = fmt.Fprintln(a.Stderr, "Only the newest measured runs were read; narrow the list with --repo or --since.")
		}
		if len(report.Recommendations) == 0 {
			_, _ = fmt.Fprintln(a.Stderr, "No measured runs in the window.")
			return nil
		}
		tw := newTable(a.Stdout)
		row(tw, "VERDICT", "REPO", "JOB", "PROFILE", "MOVE TO", "CPU P95", "PEAK MEM", "RUNS")
		for _, r := range report.Recommendations {
			label := verdictLabels[r.Verdict]
			if label == "" {
				label = r.Verdict
			}
			peak := fmt.Sprintf("%.1f GiB", float64(r.Memory.PeakBytes)/(1<<30))
			if r.Memory.Measure == "host-resident" {
				peak += " (host)"
			}
			runs := strconv.FormatInt(r.Attempts, 10)
			if r.Memory.OOMAttempts > 0 {
				runs += fmt.Sprintf(" (%d OOM)", r.Memory.OOMAttempts)
			}
			row(tw, label, r.Repo, r.Job, r.Profile, moveTo(r),
				fmt.Sprintf("%.1f/%d", r.CPU.P95Vcpus, r.Current.Vcpus),
				fmt.Sprintf("%s/%s", peak, memory(r.Current.MemoryMiB)), runs)
		}
		if err := tw.Flush(); err != nil {
			return err
		}
		for _, r := range report.Recommendations {
			if r.Verdict != "upsize" && r.Verdict != "downsize" {
				continue
			}
			if _, err := fmt.Fprintf(a.Stdout, "\n%s %s: %s\n", r.Repo, r.Job, r.Explanation); err != nil {
				return err
			}
		}
		return nil
	},
}

func moveTo(r rightsizeRow) string {
	switch {
	case r.RecommendedProfile != nil:
		return *r.RecommendedProfile
	case r.SuggestedProfile != nil:
		return "register " + *r.SuggestedProfile
	case r.Target != nil:
		return fmt.Sprintf("register %d vCPU / %s", r.Target.Vcpus, memory(r.Target.MemoryMiB))
	}
	return "-"
}
