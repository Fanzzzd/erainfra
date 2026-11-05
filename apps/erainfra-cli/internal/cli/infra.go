package cli

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Infrastructure management: Nodes, Apps, env, standalone links and log tails, through the
// /api/v1 routes in packages/backend/convex/infra/operatorRoutes.ts. These replace the `portless`
// commands that talk to the Hub; `portless` keeps working against a Hub until it is retired.

var namePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$`)

// pathName refuses a name that would change the request path, before anything is sent.
func pathName(kind, value string) error {
	if !namePattern.MatchString(value) {
		return usagef("%q is not a valid %s name", value, kind)
	}
	return nil
}

// ---- Nodes

type nodeRow struct {
	Name              string  `json:"name"`
	Transport         string  `json:"transport"`
	Online            bool    `json:"online"`
	LastSeenAt        *string `json:"lastSeenAt"`
	InfraAgentVersion *string `json:"infraAgentVersion"`
	Endpoint          struct {
		ID     *string `json:"id"`
		Proven bool    `json:"proven"`
	} `json:"endpoint"`
	PlacementRoles  []string `json:"placementRoles"`
	LiveCredentials int      `json:"liveCredentials"`
}

var nodesListCommand = command{
	path:    "nodes list",
	summary: "List Nodes with transport, liveness and mesh endpoint proof",
	long: `
TRANSPORT is convex once the Node's Infra Agent has heartbeated in connect-convex
mode, and hub while only the Hub drives it. MESH is proven when the Node signed a
challenge with its erainfra-mesh key; only a proven Node is granted mesh links.
CREDS counts live Node credentials; a Node with none is out of the mesh.`,
	run: func(ctx context.Context, a *App, in invocation) error {
		c, _, err := a.connect()
		if err != nil {
			return err
		}
		body, err := c.do(ctx, http.MethodGet, "/nodes", nil)
		if err != nil {
			return err
		}
		if in.format == formatJSON {
			return writeRawJSON(a.Stdout, body)
		}
		var page struct {
			Nodes []nodeRow `json:"nodes"`
		}
		if err := decode(body, &page); err != nil {
			return err
		}
		if len(page.Nodes) == 0 {
			_, err := fmt.Fprintln(a.Stderr, "No Nodes are enrolled. Enroll one with `erainfra nodes enroll <name>`.")
			return err
		}
		now := a.Now()
		tw := newTable(a.Stdout)
		row(tw, "NAME", "TRANSPORT", "STATUS", "HEARTBEAT", "VERSION", "MESH", "ROLES", "CREDS")
		for _, n := range page.Nodes {
			status := "offline"
			if n.Online {
				status = "online"
			}
			mesh := "none"
			if n.Endpoint.Proven {
				mesh = "proven " + shortID(n.Endpoint.ID)
			} else if n.Endpoint.ID != nil {
				mesh = "unproven"
			}
			roles := strings.Join(n.PlacementRoles, ",")
			if roles == "" {
				roles = "-"
			}
			row(tw, n.Name, n.Transport, status, ago(n.LastSeenAt, now), orDash(n.InfraAgentVersion), mesh, roles, strconv.Itoa(n.LiveCredentials))
		}
		return tw.Flush()
	},
}

func shortID(id *string) string {
	if id == nil {
		return ""
	}
	if len(*id) > 10 {
		return (*id)[:10] + "…"
	}
	return *id
}

var nodesEnrollCommand = command{
	path:    "nodes enroll",
	args:    "<name>",
	minArgs: 1,
	maxArgs: 1,
	summary: "Enroll a Node and print its credential, once (admin token)",
	long: `
Enrolling a name that is already enrolled issues another credential for the same
Node, so a credential rotates without a gap: enroll again, move the Node to the
new credential, then revoke the old one. The credential is printed once, on
standard output; store it on the Node in a 0600 file and start the Infra Agent
with ` + "`infra-agent connect-convex --credential-file <file>`" + `.`,
	run: func(ctx context.Context, a *App, in invocation) error {
		name := in.args[0]
		if err := pathName("Node", name); err != nil {
			return err
		}
		c, _, err := a.connect()
		if err != nil {
			return err
		}
		body, err := c.send(ctx, http.MethodPost, "/nodes", nil, map[string]string{"name": name})
		if err != nil {
			return err
		}
		if in.format == formatJSON {
			return writeRawJSON(a.Stdout, body)
		}
		var enrolled struct {
			Credential string `json:"credential"`
		}
		if err := decode(body, &enrolled); err != nil {
			return err
		}
		_, _ = fmt.Fprintf(a.Stderr, "Enrolled %s. Its credential follows; it is not shown again.\n", name)
		_, err = fmt.Fprintln(a.Stdout, enrolled.Credential)
		return err
	},
}

var nodesRevokeCommand = command{
	path:    "nodes revoke",
	args:    "<name>",
	minArgs: 1,
	maxArgs: 1,
	summary: "Revoke a Node's credentials, or one of them (admin token)",
	long: `
Without --credential every live credential of the Node is revoked: the Node's next
request is refused, its mesh endpoint is cleared, and every peer drops it on its
next snapshot. With --credential (the hint ` + "`nodes list --json`" + ` shows, or its id)
only that one is revoked, which is the second half of a rotation.`,
	flags: []flagSpec{{name: "credential", metavar: "HINT|ID", usage: "revoke only this credential"}},
	run: func(ctx context.Context, a *App, in invocation) error {
		name := in.args[0]
		if err := pathName("Node", name); err != nil {
			return err
		}
		req := map[string]string{}
		if hint, ok := in.value("credential"); ok {
			req["credential"] = hint
		}
		c, _, err := a.connect()
		if err != nil {
			return err
		}
		body, err := c.send(ctx, http.MethodPost, "/nodes/"+url.PathEscape(name)+"/revoke", nil, req)
		if err != nil {
			return err
		}
		if in.format == formatJSON {
			return writeRawJSON(a.Stdout, body)
		}
		var out struct {
			Revoked []string `json:"revoked"`
		}
		if err := decode(body, &out); err != nil {
			return err
		}
		if len(out.Revoked) == 0 {
			_, err = fmt.Fprintf(a.Stdout, "%s had no live credential to revoke\n", name)
			return err
		}
		_, err = fmt.Fprintf(a.Stdout, "revoked %s for %s\n", strings.Join(out.Revoked, ", "), name)
		return err
	},
}

var nodesResetEndpointCommand = command{
	path:    "nodes reset-endpoint",
	args:    "<name>",
	minArgs: 1,
	maxArgs: 1,
	summary: "Forget a Node's mesh key so it can register a new one (admin token)",
	long: `
Needed when a Node lost its erainfra-mesh key file and Convex refuses the new key
with endpoint_key_changed. The Node publishes its new key on its next heartbeat.`,
	run: func(ctx context.Context, a *App, in invocation) error {
		name := in.args[0]
		if err := pathName("Node", name); err != nil {
			return err
		}
		c, _, err := a.connect()
		if err != nil {
			return err
		}
		body, err := c.send(ctx, http.MethodPost, "/nodes/"+url.PathEscape(name)+"/endpoint/reset", nil, map[string]string{})
		if err != nil {
			return err
		}
		if in.format == formatJSON {
			return writeRawJSON(a.Stdout, body)
		}
		_, err = fmt.Fprintf(a.Stdout, "reset the mesh endpoint of %s\n", name)
		return err
	},
}

var placementRoles = map[string]bool{"gateway": true, "compute": true, "database": true, "relay": true}

var nodesSetRolesCommand = command{
	path:    "nodes set-roles",
	args:    "<name> [gateway|compute|database|relay...]",
	minArgs: 1,
	maxArgs: 5,
	summary: "Replace a Node's placement roles (admin token)",
	long: `
The roles given replace the Node's roles. A Node marked gateway is sent the route
table and a mesh link to every routed App on its next snapshot, and serves public
ingress through its cloudflared (docs/runbooks/move-ingress-to-gateways.md).
--clear removes every role; a former gateway's links and grants go on its next
snapshot. A Node cannot set its own roles.`,
	flags: []flagSpec{{name: "clear", usage: "remove every role"}},
	run: func(ctx context.Context, a *App, in invocation) error {
		name, roles := in.args[0], in.args[1:]
		if err := pathName("Node", name); err != nil {
			return err
		}
		if len(roles) == 0 && !in.bools["clear"] {
			return usagef("name the roles, or pass --clear to remove them all")
		}
		if len(roles) > 0 && in.bools["clear"] {
			return usagef("--clear takes no roles")
		}
		for _, role := range roles {
			if !placementRoles[role] {
				return usagef("%q is not a placement role (gateway, compute, database, relay)", role)
			}
		}
		c, _, err := a.connect()
		if err != nil {
			return err
		}
		body, err := c.send(ctx, http.MethodPut, "/nodes/"+url.PathEscape(name)+"/roles", nil, map[string]any{"roles": append([]string{}, roles...)})
		if err != nil {
			return err
		}
		if in.format == formatJSON {
			return writeRawJSON(a.Stdout, body)
		}
		var out struct {
			PlacementRoles []string `json:"placementRoles"`
		}
		if err := decode(body, &out); err != nil {
			return err
		}
		set := strings.Join(out.PlacementRoles, ", ")
		if set == "" {
			set = "none"
		}
		_, err = fmt.Fprintf(a.Stdout, "%s placement roles: %s\n", name, set)
		return err
	},
}

// ---- Apps

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
every Node the App is on heartbeats, node-offline when one stopped, and hub when a
Node it runs on has not connected to Convex yet (only the Hub sees that App).`,
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
refused while a deploy or failover of the App runs, and for an App on a Node that
has not connected to Convex: remove that one through the Hub with portless remove.`,
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

// ---- env

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

// ---- links

type linkRow struct {
	Name         string  `json:"name"`
	Kind         string  `json:"kind"`
	App          *string `json:"app"`
	CreatedBy    *string `json:"createdBy"`
	Provider     *string `json:"provider"`
	ProviderPort int64   `json:"providerPort"`
	Consumer     *string `json:"consumer"`
	Listen       string  `json:"listen"`
	Transport    string  `json:"transport"`
	State        string  `json:"state"`
	Reason       *string `json:"reason"`
}

var linksListCommand = command{
	path:    "links list",
	summary: "List mesh links with transport and state",
	long: `
Standalone links and every App's dependency links. TRANSPORT is mesh when both
Nodes have a proven endpoint and a live credential, so Convex grants the link over
erainfra-mesh; legacy means Convex grants nothing for it and only a Hub still
driving a Node can carry it. STATE comes from endpoint proofs and heartbeats, not
from traffic: active, degraded (a Node stopped heartbeating) or pending.`,
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
		row(tw, "LINK", "FROM", "SURFACED ON", "TRANSPORT", "STATE", "BY")
		for _, l := range page.Links {
			by := orDash(l.CreatedBy)
			if l.App != nil {
				by = "app:" + *l.App
			}
			row(tw, l.Name, fmt.Sprintf("%s:%d", orDash(l.Provider), l.ProviderPort), orDash(l.Consumer)+" @"+l.Listen, l.Transport, l.State, by)
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

// ---- logs

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
