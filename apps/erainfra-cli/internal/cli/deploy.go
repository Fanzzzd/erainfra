package cli

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// maxUploadBytes is the control plane's upload limit (pipeline.MAX_UPLOAD_BYTES).
const maxUploadBytes = 256 << 20

// deployWait bounds how long `erainfra deploy` follows a run; a build may take 15 minutes and
// may wait behind another run of the same App.
const deployWait = 45 * time.Minute

var appNameFromDir = regexp.MustCompile(`[^a-z0-9-]`)

// deriveAppName names an App after its directory the way `portless deploy` does.
func deriveAppName(dir string) string {
	name := appNameFromDir.ReplaceAllString(strings.ToLower(filepath.Base(dir)), "-")
	return strings.Trim(name, "-")
}

var appNameRule = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)

// Directories never worth uploading when the source is not a git repository: dependencies and
// build output the build recreates, and macOS AppleDouble files that confuse nixpacks.
var skippedNames = map[string]bool{"node_modules": true, ".git": true, "dist": true, ".turbo": true}

// packSource archives a directory as a gzipped tarball. A git repository is packed with
// `git archive HEAD`, exactly the committed tree, so .gitignore holds by construction; anything
// uncommitted is left out and the operator is told. Any other directory is packed here, skipping
// skippedNames and ._* files. Symbolic links are archived as links, never followed.
func packSource(ctx context.Context, a *App, dir string) ([]byte, error) {
	if _, err := a.LookPath("git"); err == nil && a.RunGit != nil {
		if inside, err := a.RunGit(ctx, dir, []string{"rev-parse", "--is-inside-work-tree"}); err == nil &&
			strings.TrimSpace(string(inside)) == "true" {
			if dirty, err := a.RunGit(ctx, dir, []string{"status", "--porcelain"}); err == nil && len(bytes.TrimSpace(dirty)) > 0 {
				_, _ = fmt.Fprintln(a.Stderr, "! uncommitted changes are not included (git archive packs HEAD)")
			}
			return a.RunGit(ctx, dir, []string{"archive", "--format=tar.gz", "HEAD"})
		}
	}
	var out bytes.Buffer
	gz := gzip.NewWriter(&out)
	tw := tar.NewWriter(gz)
	err := filepath.WalkDir(dir, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, err := filepath.Rel(dir, path)
		if err != nil || rel == "." {
			return err
		}
		if skippedNames[entry.Name()] || strings.HasPrefix(entry.Name(), "._") {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		link := ""
		if info.Mode()&os.ModeSymlink != 0 {
			if link, err = os.Readlink(path); err != nil {
				return err
			}
		} else if !info.Mode().IsRegular() && !info.IsDir() {
			return nil // sockets, devices and pipes are not source
		}
		header, err := tar.FileInfoHeader(info, link)
		if err != nil {
			return err
		}
		header.Name = filepath.ToSlash(rel)
		if info.IsDir() {
			header.Name += "/"
		}
		header.Uname, header.Gname = "", ""
		if err := tw.WriteHeader(header); err != nil {
			return err
		}
		if info.Mode().IsRegular() {
			f, err := os.Open(path)
			if err != nil {
				return err
			}
			_, err = io.Copy(tw, f)
			_ = f.Close()
			if err != nil {
				return err
			}
		}
		if out.Len() > maxUploadBytes {
			return fmt.Errorf("the source is larger than %d MiB", maxUploadBytes>>20)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if err := tw.Close(); err != nil {
		return nil, err
	}
	if err := gz.Close(); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

type deploymentRow struct {
	ID         string   `json:"id"`
	App        string   `json:"app"`
	Operation  *string  `json:"operation"`
	Stage      string   `json:"stage"`
	Detail     string   `json:"detail"`
	Error      *string  `json:"error"`
	URLs       []string `json:"urls"`
	Trigger    *string  `json:"trigger"`
	SHA        *string  `json:"sha"`
	BuildNode  *string  `json:"buildNode"`
	Nodes      []string `json:"nodes"`
	StartedAt  *string  `json:"startedAt"`
	FinishedAt *string  `json:"finishedAt"`
}

func terminal(stage string) bool { return stage == "done" || stage == "failed" }

var deployCommand = command{
	path:    "deploy",
	args:    "[dir]",
	minArgs: 0,
	maxArgs: 1,
	summary: "Deploy a directory or a repository branch and follow it (admin token)",
	long: `
Packs the directory (default: the current one), uploads it, starts a deploy and
prints each stage until the run ends, like ` + "`portless deploy`" + ` does against a Hub.
A git repository is packed with ` + "`git archive HEAD`" + `, so uncommitted changes are left
out; any other directory is packed without node_modules, .git, dist and .turbo.
The run reads erainfra.yaml or portless.yaml from the source; without one it needs
--port and deploys a single service.

With --repo the build Node clones the repository instead, and nothing is uploaded.

The exit code is 0 when the run ends done, 1 when it fails. --detach prints the
deployment and returns at once; follow it with ` + "`erainfra deployments view <id>`" + `.`,
	flags: []flagSpec{
		{name: "app", metavar: "NAME", usage: "App name (default: the directory's name)"},
		{name: "port", metavar: "PORT", usage: "container port, for a source with no spec file"},
		{name: "node", metavar: "NAME", usage: "Node that services without node: land on"},
		{name: "build-node", metavar: "NAME", usage: "Node that builds the images"},
		{name: "repo", metavar: "OWNER/NAME", usage: "deploy this repository instead of a directory"},
		{name: "branch", metavar: "BRANCH", usage: "branch with --repo (default main)"},
		{name: "sha", metavar: "SHA", usage: "exact 40-character commit with --repo"},
		{name: "detach", usage: "start the deploy and return without following it"},
	},
	run: func(ctx context.Context, a *App, in invocation) error {
		req := map[string]any{}
		repo, fromRepo := in.value("repo")
		name, named := in.value("app")
		dir := "."
		if len(in.args) == 1 {
			dir = in.args[0]
		}
		if fromRepo {
			if len(in.args) == 1 {
				return usagef("deploy either a directory or --repo, not both")
			}
			req["repo"] = repo
			for flag, field := range map[string]string{"branch": "branch", "sha": "sha"} {
				if value, ok := in.value(flag); ok {
					req[field] = value
				}
			}
			if !named {
				name = deriveAppName(repo)
			}
		} else {
			for _, flag := range []string{"branch", "sha"} {
				if _, ok := in.value(flag); ok {
					return usagef("--%s goes with --repo", flag)
				}
			}
			abs, err := filepath.Abs(dir)
			if err != nil {
				return err
			}
			info, err := os.Stat(abs)
			if err != nil || !info.IsDir() {
				return usagef("%s is not a directory", dir)
			}
			dir = abs
			if !named {
				name = deriveAppName(abs)
			}
		}
		if !appNameRule.MatchString(name) {
			return usagef("cannot use %q as an App name; pass --app (lowercase letters, digits, dashes)", name)
		}
		req["app"] = name
		if raw, ok := in.value("port"); ok {
			port, err := strconv.Atoi(raw)
			if err != nil || port < 1 || port > 65535 {
				return usagef("--port must be an integer from 1 to 65535")
			}
			req["port"] = port
		}
		for flag, field := range map[string]string{"node": "node", "build-node": "buildNode"} {
			if value, ok := in.value(flag); ok {
				req[field] = value
			}
		}
		c, _, err := a.connect()
		if err != nil {
			return err
		}
		if !fromRepo {
			_, _ = fmt.Fprintf(a.Stderr, "packing %s\n", dir)
			archive, err := packSource(ctx, a, dir)
			if err != nil {
				return fmt.Errorf("pack %s: %w", dir, err)
			}
			if len(archive) > maxUploadBytes {
				return fmt.Errorf("the packed source is %d MiB; the limit is %d MiB", len(archive)>>20, maxUploadBytes>>20)
			}
			body, err := c.send(ctx, http.MethodPost, "/deployments/uploads", nil, map[string]string{})
			if err != nil {
				return err
			}
			var slot struct {
				UploadURL string `json:"uploadUrl"`
			}
			if err := decode(body, &slot); err != nil {
				return err
			}
			storageID, err := c.upload(ctx, slot.UploadURL, archive)
			if err != nil {
				return err
			}
			_, _ = fmt.Fprintf(a.Stderr, "uploaded %.1f MiB\n", float64(len(archive))/(1<<20))
			req["upload"] = storageID
		}
		body, err := c.send(ctx, http.MethodPost, "/deployments", nil, req)
		if err != nil {
			return err
		}
		var started struct {
			Deployment deploymentRow `json:"deployment"`
		}
		if err := decode(body, &started); err != nil {
			return err
		}
		if in.bools["detach"] {
			if in.format == formatJSON {
				return writeRawJSON(a.Stdout, body)
			}
			_, err := fmt.Fprintf(a.Stdout, "started deployment %s of %s\n", started.Deployment.ID, name)
			return err
		}
		return followDeployment(ctx, a, c, in, started.Deployment.ID)
	},
}

// followDeployment prints each stage of a run as it changes and ends with the run.
func followDeployment(ctx context.Context, a *App, c *client, in invocation, id string) error {
	start := a.Now()
	last := ""
	for {
		body, err := c.do(ctx, http.MethodGet, "/deployments/"+url.PathEscape(id), nil)
		if err != nil {
			return err
		}
		var view struct {
			Deployment deploymentRow `json:"deployment"`
		}
		if err := decode(body, &view); err != nil {
			return err
		}
		d := view.Deployment
		if line := d.Stage + ": " + d.Detail; line != last {
			_, _ = fmt.Fprintf(a.Stderr, "  %s\n", line)
			last = line
		}
		if terminal(d.Stage) {
			if in.format == formatJSON {
				if err := writeRawJSON(a.Stdout, body); err != nil {
					return err
				}
			} else if d.Stage == "done" {
				_, _ = fmt.Fprintf(a.Stdout, "deployed %s in %s\n", d.App, a.Now().Sub(start).Round(time.Second))
				for _, u := range d.URLs {
					_, _ = fmt.Fprintf(a.Stdout, "  %s\n", u)
				}
			}
			if d.Stage == "failed" {
				return fmt.Errorf("deploy of %s failed (%s): %s", d.App, d.Detail, orDash(d.Error))
			}
			return nil
		}
		if a.Now().Sub(start) > deployWait {
			return fmt.Errorf("deployment %s is still %s after %s; follow it with erainfra deployments view %s", id, d.Stage, deployWait, id)
		}
		if err := a.sleep(ctx, 2*time.Second); err != nil {
			return err
		}
	}
}

var deploymentsListCommand = command{
	path:    "deployments list",
	summary: "List deploy and failover runs, newest first",
	flags: []flagSpec{
		{name: "app", metavar: "NAME", usage: "only this App"},
		{name: "limit", metavar: "N", usage: "how many, 1 to 100 (default 20)"},
	},
	run: func(ctx context.Context, a *App, in invocation) error {
		query := url.Values{}
		if app, ok := in.value("app"); ok {
			query.Set("app", app)
		}
		if limit, ok := in.value("limit"); ok {
			n, err := strconv.Atoi(limit)
			if err != nil || n < 1 || n > 100 {
				return usagef("--limit must be an integer from 1 to 100")
			}
			query.Set("limit", limit)
		}
		c, _, err := a.connect()
		if err != nil {
			return err
		}
		body, err := c.do(ctx, http.MethodGet, "/deployments", query)
		if err != nil {
			return err
		}
		if in.format == formatJSON {
			return writeRawJSON(a.Stdout, body)
		}
		var page struct {
			Deployments []deploymentRow `json:"deployments"`
		}
		if err := decode(body, &page); err != nil {
			return err
		}
		if len(page.Deployments) == 0 {
			_, err := fmt.Fprintln(a.Stderr, "No deployments yet.")
			return err
		}
		now := a.Now()
		tw := newTable(a.Stdout)
		row(tw, "ID", "APP", "OPERATION", "STAGE", "TRIGGER", "STARTED", "ERROR")
		for _, d := range page.Deployments {
			row(tw, d.ID, d.App, orDash(d.Operation), d.Stage, orDash(d.Trigger), ago(d.StartedAt, now), orDash(d.Error))
		}
		return tw.Flush()
	},
}

var deploymentsViewCommand = command{
	path:    "deployments view",
	args:    "<id>",
	minArgs: 1,
	maxArgs: 1,
	summary: "Show one deploy or failover run",
	flags:   []flagSpec{{name: "follow", usage: "follow the run until it ends"}},
	run: func(ctx context.Context, a *App, in invocation) error {
		id := in.args[0]
		if strings.ContainsAny(id, "/?#") {
			return usagef("%q is not a deployment id", id)
		}
		c, _, err := a.connect()
		if err != nil {
			return err
		}
		if in.bools["follow"] {
			return followDeployment(ctx, a, c, in, id)
		}
		body, err := c.do(ctx, http.MethodGet, "/deployments/"+url.PathEscape(id), nil)
		if err != nil {
			return err
		}
		if in.format == formatJSON {
			return writeRawJSON(a.Stdout, body)
		}
		var view struct {
			Deployment deploymentRow `json:"deployment"`
		}
		if err := json.Unmarshal(body, &view); err != nil {
			return err
		}
		d := view.Deployment
		tw := newTable(a.Stdout)
		row(tw, "ID", d.ID)
		row(tw, "App", d.App)
		row(tw, "Operation", orDash(d.Operation))
		row(tw, "Stage", d.Stage+" ("+d.Detail+")")
		row(tw, "Trigger", orDash(d.Trigger))
		row(tw, "Commit", orDash(d.SHA))
		row(tw, "Build Node", orDash(d.BuildNode))
		row(tw, "Nodes", strings.Join(d.Nodes, ", "))
		row(tw, "Started", orDash(d.StartedAt))
		row(tw, "Finished", orDash(d.FinishedAt))
		row(tw, "URLs", strings.Join(d.URLs, " "))
		row(tw, "Error", orDash(d.Error))
		return tw.Flush()
	},
}
