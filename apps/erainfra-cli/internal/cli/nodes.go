package cli

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

type nodeRow struct {
	Name              string  `json:"name"`
	Online            bool    `json:"online"`
	LastSeenAt        *string `json:"lastSeenAt"`
	InfraAgentVersion *string `json:"infraAgentVersion"`
	Endpoint          struct {
		ID     *string `json:"id"`
		Proven bool    `json:"proven"`
	} `json:"endpoint"`
	PlacementRoles  []string `json:"placementRoles"`
	LiveCredentials int      `json:"liveCredentials"`
	// Commands is absent from a control plane older than the command health report.
	Commands struct {
		Blocked *string `json:"blocked"`
	} `json:"commands"`
}

var nodesListCommand = command{
	path:    "nodes list",
	summary: "List Nodes with liveness and mesh endpoint proof",
	long: `
STATUS is offline until the Node's Infra Agent heartbeats. MESH is proven when
the Node signed a challenge with its erainfra-mesh key; only a proven Node is
granted mesh links.
CREDS counts live Node credentials; a Node with none is out of the mesh.
STATUS "online, blocked: <reason>" is a Node that heartbeats but cannot run its
builds, deploys or operations, for example journal_full (see "When the journal
is full" in docs/infra-management.md).`,
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
		row(tw, "NAME", "STATUS", "HEARTBEAT", "VERSION", "MESH", "ROLES", "CREDS")
		for _, n := range page.Nodes {
			status := "offline"
			if n.Online {
				status = "online"
				if n.Commands.Blocked != nil {
					status = "online, blocked: " + *n.Commands.Blocked
				}
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
			row(tw, n.Name, status, ago(n.LastSeenAt, now), orDash(n.InfraAgentVersion), mesh, roles, strconv.Itoa(n.LiveCredentials))
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
ingress through its cloudflared (docs/infra-management.md, "Gateway ingress").
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
