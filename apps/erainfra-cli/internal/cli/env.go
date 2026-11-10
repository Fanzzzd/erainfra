package cli

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"
)

var envListCommand = command{
	path:    "env list",
	args:    "<app>",
	minArgs: 1,
	maxArgs: 1,
	summary: "List an App's variable names by scope; values are never shown",
	run: func(ctx context.Context, a *App, in invocation) error {
		name := in.args[0]
		if err := pathName("App", name); err != nil {
			return err
		}
		c, _, err := a.connect()
		if err != nil {
			return err
		}
		body, err := c.do(ctx, http.MethodGet, "/apps/"+url.PathEscape(name)+"/env", nil)
		if err != nil {
			return err
		}
		if in.format == formatJSON {
			return writeRawJSON(a.Stdout, body)
		}
		type variable struct {
			Name      string `json:"name"`
			Preview   string `json:"preview"`
			UpdatedAt int64  `json:"updatedAt"`
		}
		var out struct {
			Env struct {
				App      []variable            `json:"app"`
				Services map[string][]variable `json:"services"`
			} `json:"env"`
		}
		if err := decode(body, &out); err != nil {
			return err
		}
		tw := newTable(a.Stdout)
		row(tw, "SCOPE", "NAME", "VALUE", "UPDATED")
		count := 0
		emit := func(scope string, v variable) {
			count++
			at := time.UnixMilli(v.UpdatedAt).UTC().Format(time.RFC3339)
			row(tw, scope, v.Name, v.Preview, ago(&at, a.Now()))
		}
		for _, v := range out.Env.App {
			emit("app", v)
		}
		services := make([]string, 0, len(out.Env.Services))
		for s := range out.Env.Services {
			services = append(services, s)
		}
		sort.Strings(services)
		for _, s := range services {
			for _, v := range out.Env.Services[s] {
				emit("service "+s, v)
			}
		}
		if count == 0 {
			_, err := fmt.Fprintf(a.Stderr, "%s has no variables. Set one with `erainfra env set %s KEY=value`.\n", name, name)
			return err
		}
		return tw.Flush()
	},
}

var envNamePattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

var envSetCommand = command{
	path:    "env set",
	args:    "<app> KEY=value... | KEY",
	minArgs: 2,
	maxArgs: 64,
	summary: "Set encrypted variables for an App or one service (admin token)",
	long: `
Without --service the variables reach every service of the App; with it, only that
service. They take effect on the App's next deploy.

A bare KEY with no "=" reads its value from standard input, so a secret stays out
of shell history and the process list: printf %s "$TOKEN" | erainfra env set web API_TOKEN`,
	flags: []flagSpec{{name: "service", metavar: "NAME", usage: "set the variables for this service only"}},
	run: func(ctx context.Context, a *App, in invocation) error {
		name := in.args[0]
		if err := pathName("App", name); err != nil {
			return err
		}
		vars := map[string]string{}
		fromStdin := ""
		for _, pair := range in.args[1:] {
			key, value, hasValue := strings.Cut(pair, "=")
			if !envNamePattern.MatchString(key) {
				return usagef("%q is not a variable name", key)
			}
			if _, dup := vars[key]; dup || key == fromStdin {
				return usagef("%s is given twice", key)
			}
			if !hasValue {
				if fromStdin != "" {
					return usagef("only one variable can read its value from standard input")
				}
				fromStdin = key
				continue
			}
			vars[key] = value
		}
		if fromStdin != "" {
			value, err := io.ReadAll(io.LimitReader(a.Stdin, 64<<10+1))
			if err != nil {
				return err
			}
			if len(value) > 64<<10 {
				return usagef("the value on standard input is larger than 64 KiB")
			}
			vars[fromStdin] = strings.TrimRight(string(value), "\r\n")
		}
		req := map[string]any{"vars": vars}
		if service, ok := in.value("service"); ok {
			req["service"] = service
		}
		c, _, err := a.connect()
		if err != nil {
			return err
		}
		body, err := c.send(ctx, http.MethodPut, "/apps/"+url.PathEscape(name)+"/env", nil, req)
		if err != nil {
			return err
		}
		if in.format == formatJSON {
			return writeRawJSON(a.Stdout, body)
		}
		var out struct {
			Names []string `json:"names"`
		}
		if err := decode(body, &out); err != nil {
			return err
		}
		_, err = fmt.Fprintf(a.Stdout, "set %s on %s; it takes effect on the next deploy\n", strings.Join(out.Names, ", "), name)
		return err
	},
}

var envUnsetCommand = command{
	path:    "env unset",
	args:    "<app> <KEY>",
	minArgs: 2,
	maxArgs: 2,
	summary: "Remove a variable from an App or one service (admin token)",
	flags:   []flagSpec{{name: "service", metavar: "NAME", usage: "remove it from this service's scope"}},
	run: func(ctx context.Context, a *App, in invocation) error {
		name, key := in.args[0], in.args[1]
		if err := pathName("App", name); err != nil {
			return err
		}
		if !envNamePattern.MatchString(key) {
			return usagef("%q is not a variable name", key)
		}
		query := url.Values{}
		if service, ok := in.value("service"); ok {
			query.Set("service", service)
		}
		c, _, err := a.connect()
		if err != nil {
			return err
		}
		body, err := c.do(ctx, http.MethodDelete, "/apps/"+url.PathEscape(name)+"/env/"+url.PathEscape(key), query)
		if err != nil {
			return err
		}
		if in.format == formatJSON {
			return writeRawJSON(a.Stdout, body)
		}
		var out struct {
			Removed bool `json:"removed"`
		}
		if err := decode(body, &out); err != nil {
			return err
		}
		if !out.Removed {
			_, err = fmt.Fprintf(a.Stdout, "%s was not set in that scope of %s\n", key, name)
			return err
		}
		_, err = fmt.Fprintf(a.Stdout, "removed %s from %s; it takes effect on the next deploy\n", key, name)
		return err
	},
}
