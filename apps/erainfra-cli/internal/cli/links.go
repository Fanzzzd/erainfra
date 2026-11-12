package cli

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

type linkRow struct {
	Name         string  `json:"name"`
	Kind         string  `json:"kind"`
	App          *string `json:"app"`
	CreatedBy    *string `json:"createdBy"`
	Provider     *string `json:"provider"`
	ProviderPort int64   `json:"providerPort"`
	Consumer     *string `json:"consumer"`
	Listen       string  `json:"listen"`
	State        string  `json:"state"`
	Reason       *string `json:"reason"`
}

var linksListCommand = command{
	path:    "links list",
	summary: "List mesh links with their state",
	long: `
Standalone links and every App's dependency links. Convex grants a link over
erainfra-mesh once both Nodes have a proven endpoint and a live credential. STATE
comes from endpoint proofs and heartbeats, not from traffic: active, degraded (a
Node stopped heartbeating) or pending (a Node has no proven endpoint yet).`,
	run: func(ctx context.Context, a *App, in invocation) error {
		c, _, err := a.connect()
		if err != nil {
			return err
		}
		body, err := c.do(ctx, http.MethodGet, "/links", nil)
		if err != nil {
			return err
		}
		if in.format == formatJSON {
			return writeRawJSON(a.Stdout, body)
		}
		var page struct {
			Links []linkRow `json:"links"`
		}
		if err := decode(body, &page); err != nil {
			return err
		}
		if len(page.Links) == 0 {
			_, err := fmt.Fprintln(a.Stderr, "No mesh links. Declare one with `erainfra links add <node>:<port> <node>`.")
			return err
		}
		tw := newTable(a.Stdout)
		row(tw, "LINK", "FROM", "SURFACED ON", "STATE", "BY")
		for _, l := range page.Links {
			by := orDash(l.CreatedBy)
			if l.App != nil {
				by = "app:" + *l.App
			}
			row(tw, l.Name, fmt.Sprintf("%s:%d", orDash(l.Provider), l.ProviderPort), orDash(l.Consumer)+" @"+l.Listen, l.State, by)
		}
		if err := tw.Flush(); err != nil {
			return err
		}
		for _, l := range page.Links {
			if l.Reason != nil {
				_, _ = fmt.Fprintf(a.Stderr, "%s: %s\n", l.Name, *l.Reason)
			}
		}
		return nil
	},
}

var endpointPattern = regexp.MustCompile(`^([^:]+):([0-9]{1,5})$`)

var linksAddCommand = command{
	path:    "links add",
	args:    "<provider-node>:<port> <consumer-node>[:<local-port>]",
	minArgs: 2,
	maxArgs: 2,
	summary: "Reach a port on one Node from another over the mesh (admin token)",
	long: `
The consumer reaches the provider's 127.0.0.1:<port> at its own 127.0.0.1:<local-port>
(the same port unless given). Both Nodes must run connect-convex with a proven
endpoint for the link to carry traffic; ` + "`links list`" + ` says when it does. Adding a
name that exists re-points it.`,
	flags: []flagSpec{{name: "name", metavar: "NAME", usage: "link name (default <provider>-<port>-<consumer>)"}},
	run: func(ctx context.Context, a *App, in invocation) error {
		from := endpointPattern.FindStringSubmatch(in.args[0])
		if from == nil {
			return usagef("the provider is <node>:<port>, not %q", in.args[0])
		}
		consumer, local, hasLocal := strings.Cut(in.args[1], ":")
		providerPort, _ := strconv.Atoi(from[2])
		req := map[string]any{"provider": from[1], "providerPort": providerPort, "consumer": consumer}
		if hasLocal {
			port, err := strconv.Atoi(local)
			if err != nil {
				return usagef("the local port %q is not a number", local)
			}
			req["localPort"] = port
		}
		if name, ok := in.value("name"); ok {
			req["name"] = name
		}
		c, _, err := a.connect()
		if err != nil {
			return err
		}
		body, err := c.send(ctx, http.MethodPost, "/links", nil, req)
		if err != nil {
			return err
		}
		if in.format == formatJSON {
			return writeRawJSON(a.Stdout, body)
		}
		var out struct {
			Link struct {
				Name     string `json:"name"`
				Address  string `json:"address"`
				Replaced bool   `json:"replaced"`
			} `json:"link"`
		}
		if err := decode(body, &out); err != nil {
			return err
		}
		verb := "declared"
		if out.Link.Replaced {
			verb = "re-pointed"
		}
		_, err = fmt.Fprintf(a.Stdout, "%s link %s: %s reaches %s at %s\n", verb, out.Link.Name, consumer, in.args[0], out.Link.Address)
		return err
	},
}

var linksRemoveCommand = command{
	path:    "links remove",
	args:    "<name>",
	minArgs: 1,
	maxArgs: 1,
	summary: "Remove a standalone link; both Nodes drop it on their next snapshot (admin token)",
	run: func(ctx context.Context, a *App, in invocation) error {
		name := in.args[0]
		if err := pathName("link", name); err != nil {
			return err
		}
		c, _, err := a.connect()
		if err != nil {
			return err
		}
		body, err := c.do(ctx, http.MethodDelete, "/links/"+url.PathEscape(name), nil)
		if err != nil {
			return err
		}
		if in.format == formatJSON {
			return writeRawJSON(a.Stdout, body)
		}
		_, err = fmt.Fprintf(a.Stdout, "removed link %s\n", name)
		return err
	},
}
