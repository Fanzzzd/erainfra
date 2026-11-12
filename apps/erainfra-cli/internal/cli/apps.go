package cli

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
)

type appService struct {
	Name      string  `json:"name"`
	Node      *string `json:"node"`
	Image     string  `json:"image"`
	Port      *int64  `json:"port"`
	Route     *string `json:"route"`
	URL       *string `json:"url"`
	Container string  `json:"container"`
}

type deploymentSummary struct {
	ID         string  `json:"id"`
	Operation  *string `json:"operation"`
	Stage      string  `json:"stage"`
	Detail     string  `json:"detail"`
	Error      *string `json:"error"`
	StartedAt  *string `json:"startedAt"`
	FinishedAt *string `json:"finishedAt"`
}

type appRow struct {
	Name           string             `json:"name"`
	Kind           string             `json:"kind"`
	Node           *string            `json:"node"`
	Status         string             `json:"status"`
	Services       []appService       `json:"services"`
	Failover       bool               `json:"failover"`
	LastDeployment *deploymentSummary `json:"lastDeployment"`
	Links          []struct {
		Name     string  `json:"name"`
		Need     string  `json:"need"`
		Provider *string `json:"provider"`
		Consumer *string `json:"consumer"`
	} `json:"links"`
	Env *struct {
		App      []struct{ Name string } `json:"app"`
		Services map[string][]struct {
			Name string `json:"name"`
		} `json:"services"`
	} `json:"env"`
	Deployments []deploymentSummary `json:"deployments"`
}

func appNodes(app appRow) string {
	seen := map[string]bool{}
	var nodes []string
	for _, s := range app.Services {
		if s.Node != nil && !seen[*s.Node] {
			seen[*s.Node] = true
			nodes = append(nodes, *s.Node)
		}
	}
	sort.Strings(nodes)
	if len(nodes) == 0 {
		return "-"
	}
	return strings.Join(nodes, ",")
}

func appURLs(app appRow) string {
	var urls []string
	for _, s := range app.Services {
		if s.URL != nil {
			urls = append(urls, *s.URL)
		}
	}
	if len(urls) == 0 {
		return "-"
	}
	return strings.Join(urls, " ")
}

var appsListCommand = command{
	path:    "apps list",
	summary: "List Apps with status, Nodes, last deploy and URLs",
	long: `
STATUS is what Convex can tell: deploying while a run is in flight, running when
every Node the App is on heartbeats, and node-offline when one is gone, has never
connected or stopped heartbeating.`,
	run: func(ctx context.Context, a *App, in invocation) error {
		c, _, err := a.connect()
		if err != nil {
			return err
		}
		body, err := c.do(ctx, http.MethodGet, "/apps", nil)
		if err != nil {
			return err
		}
		if in.format == formatJSON {
			return writeRawJSON(a.Stdout, body)
		}
		var page struct {
			Apps []appRow `json:"apps"`
		}
		if err := decode(body, &page); err != nil {
			return err
		}
		if len(page.Apps) == 0 {
			_, err := fmt.Fprintln(a.Stderr, "No Apps are deployed. Deploy one with `erainfra deploy`.")
			return err
		}
		now := a.Now()
		tw := newTable(a.Stdout)
		row(tw, "NAME", "STATUS", "SERVICES", "NODES", "LAST DEPLOY", "URL")
		for _, app := range page.Apps {
			last := "-"
			if d := app.LastDeployment; d != nil {
				last = d.Stage + " " + ago(d.StartedAt, now)
			}
			row(tw, app.Name, app.Status, strconv.Itoa(len(app.Services)), appNodes(app), last, appURLs(app))
		}
		return tw.Flush()
	},
}

var appsViewCommand = command{
	path:    "apps view",
	args:    "<app>",
	minArgs: 1,
	maxArgs: 1,
	summary: "Show one App: services, links, env names and recent deploys",
	run: func(ctx context.Context, a *App, in invocation) error {
		name := in.args[0]
		if err := pathName("App", name); err != nil {
			return err
		}
		c, _, err := a.connect()
		if err != nil {
			return err
		}
		body, err := c.do(ctx, http.MethodGet, "/apps/"+url.PathEscape(name), nil)
		if err != nil {
			return err
		}
		if in.format == formatJSON {
			return writeRawJSON(a.Stdout, body)
		}
		var out struct {
			App appRow `json:"app"`
		}
		if err := decode(body, &out); err != nil {
			return err
		}
		app := out.App
		now := a.Now()
		w := a.Stdout
		_, _ = fmt.Fprintf(w, "%s  %s  on %s\n", app.Name, app.Status, appNodes(app))
		if !app.Failover {
			_, _ = fmt.Fprintln(w, "  not failed over automatically until it is deployed through Convex once")
		}
		_, _ = fmt.Fprintln(w, "\nServices:")
		tw := newTable(w)
		row(tw, "  NAME", "NODE", "IMAGE", "PORT", "URL")
		for _, s := range app.Services {
			port := "-"
			if s.Port != nil {
				port = strconv.FormatInt(*s.Port, 10)
			}
			row(tw, "  "+s.Name, orDash(s.Node), s.Image, port, orDash(s.URL))
		}
		_ = tw.Flush()
		if len(app.Links) > 0 {
			_, _ = fmt.Fprintln(w, "\nLinks:")
			for _, l := range app.Links {
				_, _ = fmt.Fprintf(w, "  %s  %s on %s, used from %s\n", l.Name, l.Need, orDash(l.Provider), orDash(l.Consumer))
			}
		}
		if app.Env != nil {
			var names []string
			for _, v := range app.Env.App {
				names = append(names, v.Name)
			}
			for service, vars := range app.Env.Services {
				for _, v := range vars {
					names = append(names, service+"/"+v.Name)
				}
			}
			sort.Strings(names)
			if len(names) > 0 {
				_, _ = fmt.Fprintf(w, "\nEnv: %s\n", strings.Join(names, ", "))
			}
		}
		if len(app.Deployments) > 0 {
			_, _ = fmt.Fprintln(w, "\nRecent deploys:")
			tw = newTable(w)
			for _, d := range app.Deployments {
				problem := ""
				if d.Error != nil {
					problem = *d.Error
				}
				row(tw, "  "+d.ID, d.Stage, ago(d.StartedAt, now), problem)
			}
			_ = tw.Flush()
		}
		return nil
	},
}

var appsRemoveCommand = command{
	path:    "apps remove",
	args:    "<app>",
	minArgs: 1,
	maxArgs: 1,
	summary: "Tear an App down on every Node it runs on (admin token)",
	long: `
Queues the removal of the App's containers and network on each Node, and forgets
its routes, ports and App row at once. The App's env and git bindings stay. It is
refused while a deploy or failover of the App runs. A Node that is offline removes
the containers when it next connects.`,
	flags: []flagSpec{{name: "yes", usage: "confirm; required, since removal cannot be undone"}},
	run: func(ctx context.Context, a *App, in invocation) error {
		name := in.args[0]
		if err := pathName("App", name); err != nil {
			return err
		}
		if !in.bools["yes"] {
			return usagef("removing %s stops it everywhere; add --yes to confirm", name)
		}
		c, _, err := a.connect()
		if err != nil {
			return err
		}
		body, err := c.do(ctx, http.MethodDelete, "/apps/"+url.PathEscape(name), nil)
		if err != nil {
			return err
		}
		if in.format == formatJSON {
			return writeRawJSON(a.Stdout, body)
		}
		var out struct {
			Removal struct {
				Containers []struct {
					Node      string `json:"node"`
					Container string `json:"container"`
				} `json:"containers"`
			} `json:"removal"`
		}
		if err := decode(body, &out); err != nil {
			return err
		}
		for _, c := range out.Removal.Containers {
			_, _ = fmt.Fprintf(a.Stderr, "  removing %s on %s\n", c.Container, c.Node)
		}
		_, err = fmt.Fprintf(a.Stdout, "removed %s; each Node stops its containers when it next polls\n", name)
		return err
	},
}
