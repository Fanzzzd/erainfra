package cli

import "regexp"

// Infrastructure management: Nodes, Apps, env, standalone links and log tails, through the
// /api/v1 routes in packages/backend/convex/infra/operatorRoutes.ts. These replace the `portless`
// commands that talk to the Hub; `portless` keeps working against a Hub until it is retired. Each
// resource has its own file: nodes.go, apps.go, env.go, links.go and logs.go.

var namePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$`)

// pathName refuses a name that would change the request path, before anything is sent.
func pathName(kind, value string) error {
	if !namePattern.MatchString(value) {
		return usagef("%q is not a valid %s name", value, kind)
	}
	return nil
}
