package cli

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
)

// Push-to-deploy bindings, through /api/v1/git/bindings
// (packages/backend/convex/infra/operatorGitRoutes.ts). These replace `portless bind` and
// `portless repos`. A binding is named by repository and branch, and a branch may contain `/`,
// so unbind sends both as query parameters, never as path segments.

var repoPattern = regexp.MustCompile(`^[\w.-]+/[\w.-]+$`)

func repoArg(value string) error {
	if !repoPattern.MatchString(value) {
		return usagef("name the repository as <owner>/<name>, not %q", value)
	}
	return nil
}

type bindingRow struct {
	Repo       string  `json:"repo"`
	Branch     string  `json:"branch"`
	App        string  `json:"app"`
	BuildNode  *string `json:"buildNode"`
	DeployNode *string `json:"deployNode"`
	Port       *int64  `json:"port"`
	CreatedAt  *string `json:"createdAt"`
	LastStatus *struct {
		At    *string `json:"at"`
		Sha   string  `json:"sha"`
		OK    bool    `json:"ok"`
		Stage string  `json:"stage"`
		Error *string `json:"error"`
	} `json:"lastStatus"`
}

var gitBindingsCommand = command{
	path:    "git bindings",
	summary: "List the repository branches that deploy on push",
	long: `
A push to a bound branch queues one deploy of the pushed commit to the App, built on
BUILD and deployed to DEPLOY (the first live Node when not set). LAST is the result
of the newest push-triggered run.`,
	run: func(ctx context.Context, a *App, in invocation) error {
		c, _, err := a.connect()
		if err != nil {
			return err
		}
		body, err := c.do(ctx, http.MethodGet, "/git/bindings", nil)
		if err != nil {
			return err
		}
		if in.format == formatJSON {
			return writeRawJSON(a.Stdout, body)
		}
		var page struct {
			Bindings []bindingRow `json:"bindings"`
		}
		if err := decode(body, &page); err != nil {
			return err
		}
		if len(page.Bindings) == 0 {
			_, err := fmt.Fprintln(a.Stderr, "No branch deploys on push. Bind one with `erainfra git bind <owner/repo> <branch> --app <app>`.")
			return err
		}
		now := a.Now()
		tw := newTable(a.Stdout)
		row(tw, "REPOSITORY", "BRANCH", "APP", "BUILD", "DEPLOY", "PORT", "LAST")
		for _, b := range page.Bindings {
			port := "-"
			if b.Port != nil {
				port = strconv.FormatInt(*b.Port, 10)
			}
			last := "-"
			if s := b.LastStatus; s != nil {
				sha := s.Sha
				if len(sha) > 7 {
					sha = sha[:7]
				}
				outcome := "ok"
				if !s.OK {
					outcome = "failed at " + s.Stage
				}
				last = fmt.Sprintf("%s %s %s", sha, outcome, ago(s.At, now))
			}
			row(tw, b.Repo, b.Branch, b.App, orDash(b.BuildNode), orDash(b.DeployNode), port, last)
		}
		return tw.Flush()
	},
}

var gitBindCommand = command{
	path:    "git bind",
	args:    "<owner/repo> <branch> --app <app>",
	minArgs: 2,
	maxArgs: 2,
	summary: "Deploy an App on every push to a repository branch (admin token)",
	long: `
Pushes reach the control plane through the deploy GitHub App's webhook
(<site>/github/webhook, signed with ERAINFRA_GH_WEBHOOK_SECRET); without it no push
deploys. The App need not exist yet: the first push creates it. --port is for a
repository without a portless.yaml. A repository branch is bound to one App at most,
and a fleet holds at most 200 bindings.`,
	flags: []flagSpec{
		{name: "app", metavar: "NAME", usage: "the App the branch deploys (required)"},
		{name: "build-node", metavar: "NAME", usage: "the Node that builds the image (default: the first live Node)"},
		{name: "deploy-node", metavar: "NAME", usage: "the Node that runs the App (default: the first live Node)"},
		{name: "port", metavar: "PORT", usage: "the container port, for a repository without portless.yaml"},
	},
	run: func(ctx context.Context, a *App, in invocation) error {
		repo, branch := in.args[0], in.args[1]
		if err := repoArg(repo); err != nil {
			return err
		}
		app, ok := in.value("app")
		if !ok {
			return usagef("--app is required")
		}
		if err := pathName("App", app); err != nil {
			return err
		}
		req := map[string]any{"repo": repo, "branch": branch, "app": app}
		for flag, field := range map[string]string{"build-node": "buildNode", "deploy-node": "deployNode"} {
			if name, ok := in.value(flag); ok {
				if err := pathName("Node", name); err != nil {
					return err
				}
				req[field] = name
			}
		}
		if raw, ok := in.value("port"); ok {
			port, err := strconv.Atoi(raw)
			if err != nil || port < 1 || port > 65535 {
				return usagef("--port must be a number from 1 to 65535, not %q", raw)
			}
			req["port"] = port
		}
		c, _, err := a.connect()
		if err != nil {
			return err
		}
		body, err := c.send(ctx, http.MethodPost, "/git/bindings", nil, req)
		if err != nil {
			return err
		}
		if in.format == formatJSON {
			return writeRawJSON(a.Stdout, body)
		}
		var out struct {
			Binding bindingRow `json:"binding"`
		}
		if err := decode(body, &out); err != nil {
			return err
		}
		_, err = fmt.Fprintf(a.Stdout, "bound %s@%s: a push deploys App %s\n", out.Binding.Repo, out.Binding.Branch, out.Binding.App)
		return err
	},
}

var gitUnbindCommand = command{
	path:    "git unbind",
	args:    "<owner/repo> <branch>",
	minArgs: 2,
	maxArgs: 2,
	summary: "Stop deploying on push to a repository branch (admin token)",
	long: `
The App keeps running; only the binding goes. Remove the App with
` + "`erainfra apps remove`" + `.`,
	run: func(ctx context.Context, a *App, in invocation) error {
		repo, branch := in.args[0], in.args[1]
		if err := repoArg(repo); err != nil {
			return err
		}
		c, _, err := a.connect()
		if err != nil {
			return err
		}
		body, err := c.do(ctx, http.MethodDelete, "/git/bindings", url.Values{"repo": {repo}, "branch": {branch}})
		if err != nil {
			return err
		}
		if in.format == formatJSON {
			return writeRawJSON(a.Stdout, body)
		}
		var out struct {
			Binding bindingRow `json:"binding"`
		}
		if err := decode(body, &out); err != nil {
			return err
		}
		_, err = fmt.Fprintf(a.Stdout, "unbound %s@%s: pushes no longer deploy App %s\n", out.Binding.Repo, out.Binding.Branch, out.Binding.App)
		return err
	},
}
