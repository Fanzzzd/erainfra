package cli

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
)

type tokenInfo struct {
	Token struct {
		Name  string `json:"name"`
		Scope string `json:"scope"`
	} `json:"token"`
}

var authLoginCommand = command{
	path:    "auth login",
	summary: "Store the deployment URL and an API token",
	long: `
Checks the token against the deployment, then stores both in the config file
with mode 0600. Create a read or admin token in the dashboard under Settings,
API tokens; a metrics token only scrapes /metrics. Pass --token - to read it
from standard input, which keeps it out of the shell history and the process
list.`,
	flags: []flagSpec{
		{name: "url", metavar: "URL", usage: "the deployment's site URL, https://<deployment>.convex.site"},
		{name: "token", metavar: "TOKEN", usage: "an API token, or - to read it from standard input"},
	},
	run: func(ctx context.Context, a *App, in invocation) error {
		rawURL, ok := in.value("url")
		if !ok {
			return usagef("--url is required")
		}
		token, ok := in.value("token")
		if !ok {
			return usagef("--token is required (or --token - to read it from standard input)")
		}
		if token == "-" {
			line, err := bufio.NewReader(a.Stdin).ReadString('\n')
			if err != nil && line == "" {
				return usagef("--token - read nothing from standard input")
			}
			token = strings.TrimSpace(line)
		}
		if token == "" {
			return usagef("--token is empty")
		}
		base, err := normalizeBaseURL(rawURL)
		if err != nil {
			return usagef("--url: %s", err)
		}
		cfg := Config{URL: base, Token: token}
		var info tokenInfo
		if err := a.clientFor(cfg).getJSON(ctx, "/token", nil, &info); err != nil {
			return err
		}
		path, err := configPath(a.Getenv)
		if err != nil {
			return err
		}
		if err := writeConfig(path, cfg); err != nil {
			return fmt.Errorf("store the login in %s: %w", path, err)
		}
		if in.format == formatJSON {
			return writeJSON(a.Stdout, map[string]any{"url": base, "token": info.Token, "configPath": path})
		}
		_, err = fmt.Fprintf(a.Stdout, "Logged in to %s with %s token %q.\nStored in %s.\n",
			base, info.Token.Scope, info.Token.Name, path)
		return err
	},
}

var authStatusCommand = command{
	path:    "auth status",
	summary: "Show which deployment and token are in use",
	long: `
Asks the deployment whether the token is still valid. Exits 4 when there is no
login or the token was revoked.`,
	run: func(ctx context.Context, a *App, in invocation) error {
		c, creds, err := a.connect()
		if err != nil {
			return err
		}
		var info tokenInfo
		if err := c.getJSON(ctx, "/token", nil, &info); err != nil {
			return err
		}
		if in.format == formatJSON {
			return writeJSON(a.Stdout, map[string]any{"url": creds.URL, "token": info.Token, "source": creds.Source})
		}
		_, err = fmt.Fprintf(a.Stdout, "Logged in to %s\nToken: %q (%s)\nFrom:  %s\n",
			creds.URL, info.Token.Name, info.Token.Scope, creds.Source)
		return err
	},
}

var authLogoutCommand = command{
	path:    "auth logout",
	summary: "Delete the stored login",
	long: `
Removes the config file. The token itself stays valid until it is revoked in
the dashboard.`,
	run: func(_ context.Context, a *App, in invocation) error {
		path, err := configPath(a.Getenv)
		if err != nil {
			return err
		}
		err = os.Remove(path)
		removed := err == nil
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if in.format == formatJSON {
			return writeJSON(a.Stdout, map[string]any{"removed": removed, "configPath": path})
		}
		if !removed {
			_, err = fmt.Fprintf(a.Stdout, "No login stored at %s.\n", path)
			return err
		}
		_, err = fmt.Fprintf(a.Stdout, "Removed %s. Revoke the token in the dashboard if it should stop working.\n", path)
		return err
	},
}
