package cli

import (
	"bufio"
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// logsWait bounds how long `erainfra logs` waits for the Node. The request itself lives five
// minutes on the control plane; a Node that has not answered in two is busy or gone.
const logsWait = 2 * time.Minute

var logsCommand = command{
	path:    "logs",
	args:    "<app> | --node <node> --unit <unit>",
	minArgs: 0,
	maxArgs: 1,
	summary: "Print the last lines of an App's container or a Node's unit (admin token)",
	long: `
The Node that runs the container reads its last --lines lines (default 100, at
most 1000; at most 128 KiB, the newest kept) and uploads them for this token only.
The control plane deletes them on this first read, or five minutes after the
request if nobody reads them. Logs can contain secrets, which is why this needs an
admin token. An App with several services needs --service.`,
	flags: []flagSpec{
		{name: "service", metavar: "NAME", usage: "the App's service (needed when it has several)"},
		{name: "lines", metavar: "N", usage: "how many lines, 1 to 1000 (default 100)"},
		{name: "node", metavar: "NAME", usage: "read a platform unit on this Node instead of an App"},
		{name: "unit", metavar: "UNIT", usage: "the unit with --node, e.g. erainfra-mesh.service or portless-agent"},
	},
	run: func(ctx context.Context, a *App, in invocation) error {
		req := map[string]any{}
		node, hasNode := in.value("node")
		unit, hasUnit := in.value("unit")
		switch {
		case len(in.args) == 1 && !hasNode && !hasUnit:
			if err := pathName("App", in.args[0]); err != nil {
				return err
			}
			req["app"] = in.args[0]
			if service, ok := in.value("service"); ok {
				req["service"] = service
			}
		case len(in.args) == 0 && hasNode && hasUnit:
			if _, ok := in.value("service"); ok {
				return usagef("--service goes with an App, not with --unit")
			}
			req["node"], req["unit"] = node, unit
		default:
			return usagef("usage: erainfra logs <app> [--service S], or erainfra logs --node N --unit U")
		}
		if raw, ok := in.value("lines"); ok {
			n, err := strconv.Atoi(raw)
			if err != nil || n < 1 || n > 1000 {
				return usagef("--lines must be an integer from 1 to 1000")
			}
			req["lines"] = n
		}
		c, _, err := a.connect()
		if err != nil {
			return err
		}
		body, err := c.send(ctx, http.MethodPost, "/logs", nil, req)
		if err != nil {
			return err
		}
		var asked struct {
			Logs struct {
				ID   string `json:"id"`
				Node string `json:"node"`
			} `json:"logs"`
		}
		if err := decode(body, &asked); err != nil {
			return err
		}
		deadline := a.Now().Add(logsWait)
		for attempt := 0; ; attempt++ {
			reply, status, err := c.poll(ctx, "/logs/"+url.PathEscape(asked.Logs.ID))
			if err != nil {
				return err
			}
			if status == http.StatusOK {
				return printLogs(a, in, reply)
			}
			if !a.Now().Before(deadline) || attempt >= 600 {
				return fmt.Errorf("%s has not answered in %s; it may be running a long build. The request expires on its own", asked.Logs.Node, logsWait)
			}
			if err := a.sleep(ctx, time.Second); err != nil {
				return err
			}
		}
	},
}

func printLogs(a *App, in invocation, reply []byte) error {
	if in.format == formatJSON {
		return writeRawJSON(a.Stdout, reply)
	}
	var out struct {
		Logs struct {
			State     string `json:"state"`
			Text      string `json:"text"`
			Truncated bool   `json:"truncated"`
			Error     string `json:"error"`
		} `json:"logs"`
	}
	if err := decode(reply, &out); err != nil {
		return err
	}
	if out.Logs.State == "failed" {
		return fmt.Errorf("%s", out.Logs.Error)
	}
	if out.Logs.Truncated {
		_, _ = fmt.Fprintln(a.Stderr, "(only the newest 128 KiB are shown)")
	}
	w := bufio.NewWriter(a.Stdout)
	_, _ = w.WriteString(out.Logs.Text)
	if out.Logs.Text != "" && !strings.HasSuffix(out.Logs.Text, "\n") {
		_ = w.WriteByte('\n')
	}
	return w.Flush()
}
