package cli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"text/tabwriter"
	"time"
)

// writeJSON prints a value indented, with a trailing newline, so `| jq` and a
// human both read it.
func writeJSON(w io.Writer, v any) error {
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	enc.SetEscapeHTML(false)
	return enc.Encode(v)
}

// writeRawJSON re-indents a body from the API without decoding it, so a field
// the server adds later reaches scripts without a CLI release.
func writeRawJSON(w io.Writer, body []byte) error {
	var out bytes.Buffer
	if err := json.Indent(&out, body, "", "  "); err != nil {
		return err
	}
	out.WriteByte('\n')
	_, err := w.Write(out.Bytes())
	return err
}

func newTable(w io.Writer) *tabwriter.Writer {
	return tabwriter.NewWriter(w, 0, 8, 2, ' ', 0)
}

func row(tw *tabwriter.Writer, cells ...string) {
	for i, cell := range cells {
		// A tab or newline inside a value would break the column layout.
		cells[i] = strings.NewReplacer("\t", " ", "\n", " ").Replace(cell)
	}
	_, _ = fmt.Fprintln(tw, strings.Join(cells, "\t"))
}

func orDash(value *string) string {
	if value == nil || *value == "" {
		return "-"
	}
	return *value
}

// ago renders an RFC 3339 timestamp from the API relative to now.
func ago(timestamp *string, now time.Time) string {
	if timestamp == nil {
		return "-"
	}
	at, err := time.Parse(time.RFC3339Nano, *timestamp)
	if err != nil {
		return *timestamp
	}
	elapsed := now.Sub(at)
	switch {
	case elapsed < 0:
		return "just now"
	case elapsed < 5*time.Second:
		return "just now"
	case elapsed < time.Minute:
		return fmt.Sprintf("%ds ago", int(elapsed.Seconds()))
	case elapsed < time.Hour:
		return fmt.Sprintf("%dm ago", int(elapsed.Minutes()))
	case elapsed < 48*time.Hour:
		return fmt.Sprintf("%dh ago", int(elapsed.Hours()))
	}
	return fmt.Sprintf("%dd ago", int(elapsed.Hours()/24))
}

// millis renders a duration the API reports in milliseconds.
func millis(ms *int64) string {
	if ms == nil {
		return "-"
	}
	d := time.Duration(*ms) * time.Millisecond
	switch {
	case d < time.Second:
		return fmt.Sprintf("%dms", *ms)
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm%02ds", int(d.Minutes()), int(d.Seconds())%60)
	}
	return fmt.Sprintf("%dh%02dm", int(d.Hours()), int(d.Minutes())%60)
}

func memory(mib int64) string {
	if mib%1024 == 0 {
		return fmt.Sprintf("%d GiB", mib/1024)
	}
	return fmt.Sprintf("%d MiB", mib)
}
