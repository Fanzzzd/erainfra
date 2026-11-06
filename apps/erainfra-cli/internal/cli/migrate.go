package cli

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/Fanzzzd/erainfra/apps/erainfra-cli/internal/runsonmigrate"
)

var migrateRunsOnCommand = command{
	path:    "migrate runs-on",
	summary: "Rewrite workflow runs-on labels from GitHub-hosted runners to Profiles",
	long: `
Scans .github/workflows/*.yml and *.yaml and proposes moving each job from a
GitHub-hosted label (ubuntu-latest, ubuntu-24.04-arm, windows-2025, macos-15,
...) or a Blacksmith or BuildJet label to the matching EraInfra Profile. It
prints a unified diff and changes nothing; --write applies it. Only the label
text is replaced, so comments, quoting and layout stay as they are.

The matching Profile is read from the control plane when the CLI is logged in:
the active Profile with the same OS, version and architecture, nearest to the
label's size (4 vCPU for a standard hosted runner). Logged out, or with
--offline, names come from ADR 0010's scheme (ubuntu-24.04 becomes
erainfra-4vcpu-ubuntu-2404) and are not checked. --map overrides both.

Left unchanged, with a note saying why: matrix and other expressions, lists of
several labels (no scale set matches them), runner groups without labels,
labels with no equivalent, and the /runs-on router job, which has to stay on a
GitHub-hosted runner. A reusable workflow in this repository that takes
runs-on from an input has that input's default and its callers' with: values
rewritten. In a router job, the Profile it asks about (a PROFILE variable or a
profile= query) is renamed when ADR 0010 or --map renames it. A label whose
YAML anchor an env: value or other non-runs-on field also reads is left
unchanged too.

Each rewritten file is parsed again and compared with the original; if any
value other than the reported labels differs, that file is left unchanged with
a "verify" note.

Examples:
  erainfra migrate runs-on
  erainfra migrate runs-on --repo ../app --map ubuntu-latest=erainfra-8vcpu-ubuntu-2404
  erainfra migrate runs-on --write`,
	flags: []flagSpec{
		{name: "repo", metavar: "path", usage: "repository to scan (default the current directory)"},
		{name: "write", usage: "apply the changes instead of printing a diff"},
		{name: "map", metavar: "label=profile", usage: "send this label to this Profile; repeatable, wins over every default", repeat: true},
		{name: "offline", usage: "use the built-in ADR 0010 names even when logged in"},
	},
	run: runMigrateRunsOn,
}

// A runs-on label as GitHub accepts it; the same rule the control plane's
// /runs-on endpoint applies. A target must be one, so an edit never adds a
// line break, a quote or a YAML indicator.
var runsOnLabel = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$`)

type migrateReport struct {
	Repo     string               `json:"repo"`
	Profiles migrateProfileSource `json:"profiles"`
	Written  bool                 `json:"written"`
	Files    []migrateFile        `json:"files"`
}

type migrateProfileSource struct {
	// Source is control-plane or built-in.
	Source     string   `json:"source"`
	Registered []string `json:"registered"`
}

type migrateFile struct {
	Path    string                 `json:"path"`
	Changes []runsonmigrate.Change `json:"changes"`
	Notes   []runsonmigrate.Note   `json:"notes"`
	Diff    string                 `json:"diff"`
}

func runMigrateRunsOn(ctx context.Context, a *App, in invocation) error {
	user := map[string]string{}
	for _, pair := range in.all("map") {
		from, to, ok := strings.Cut(pair, "=")
		from, to = strings.TrimSpace(from), strings.TrimSpace(to)
		if !ok || !runsOnLabel.MatchString(from) || !runsOnLabel.MatchString(to) {
			return usagef("--map takes label=profile, both runs-on labels ([A-Za-z0-9._-]), not %q", pair)
		}
		if _, seen := user[strings.ToLower(from)]; seen {
			return usagef("--map %s given twice", from)
		}
		user[strings.ToLower(from)] = to
	}
	repo, _ := in.value("repo")
	if repo == "" {
		repo = "."
	}
	files, err := readWorkflows(repo)
	if err != nil {
		return err
	}

	source := migrateProfileSource{Source: runsonmigrate.SourceBuiltIn, Registered: []string{}}
	var registered []runsonmigrate.Profile
	if !in.bools["offline"] {
		registered, err = a.registeredProfiles(ctx)
		switch {
		case errors.Is(err, errNotLoggedIn) || errors.Is(err, errIncompleteEnvironment):
			_, _ = fmt.Fprintln(a.Stderr, "Not logged in: Profile names come from ADR 0010's scheme and were not checked against the control plane.")
		case err != nil:
			return fmt.Errorf("read the registered Profiles (pass --offline to use ADR 0010's names unchecked): %w", err)
		default:
			source.Source = runsonmigrate.SourceControlPlane
			for _, p := range registered {
				source.Registered = append(source.Registered, p.Name)
			}
		}
	}
	mapper := runsonmigrate.NewMapper(user, registered)
	results := runsonmigrate.Rewrite(files, mapper)

	report := migrateReport{Repo: repo, Profiles: source, Written: in.bools["write"], Files: []migrateFile{}}
	changedFiles, changes := 0, 0
	for _, r := range results {
		if len(r.Changes) == 0 && len(r.Notes) == 0 {
			continue
		}
		diff, err := runsonmigrate.Diff(r)
		if err != nil {
			return err
		}
		report.Files = append(report.Files, migrateFile{Path: r.Path, Changes: r.Changes, Notes: r.Notes, Diff: diff})
		if r.Changed() {
			changedFiles++
			changes += len(r.Changes)
		}
	}
	if in.bools["write"] {
		for _, r := range results {
			if !r.Changed() {
				continue
			}
			if err := writeFileAtomic(filepath.Join(repo, filepath.FromSlash(r.Path)), r.Updated); err != nil {
				return err
			}
		}
	}

	if in.format == formatJSON {
		return writeJSON(a.Stdout, report)
	}
	for _, f := range report.Files {
		if f.Diff == "" {
			continue
		}
		if in.bools["write"] {
			_, _ = fmt.Fprintf(a.Stdout, "rewrote %s (%d)\n", f.Path, len(f.Changes))
		} else {
			_, _ = fmt.Fprint(a.Stdout, f.Diff)
		}
	}
	for _, f := range report.Files {
		for _, n := range f.Notes {
			where := f.Path
			if n.Line > 0 {
				where = fmt.Sprintf("%s:%d", f.Path, n.Line)
			}
			if n.Job != "" {
				where += " (job " + n.Job + ")"
			}
			_, _ = fmt.Fprintf(a.Stderr, "note: %s: %s\n", where, n.Message)
		}
	}
	switch {
	case changes == 0:
		_, _ = fmt.Fprintf(a.Stderr, "Nothing to rewrite in %d workflow files.\n", len(files))
	case in.bools["write"]:
		_, _ = fmt.Fprintf(a.Stderr, "Rewrote %d labels in %d files.\n", changes, changedFiles)
	default:
		_, _ = fmt.Fprintf(a.Stderr, "%d labels in %d files would change. Run again with --write to apply.\n", changes, changedFiles)
	}
	return nil
}

func (a *App) registeredProfiles(ctx context.Context) ([]runsonmigrate.Profile, error) {
	c, _, err := a.connect()
	if err != nil {
		return nil, err
	}
	var page struct {
		Profiles []struct {
			Name  string `json:"name"`
			State string `json:"state"`
		} `json:"profiles"`
	}
	if err := c.getJSON(ctx, "/profiles", nil, &page); err != nil {
		return nil, err
	}
	out := make([]runsonmigrate.Profile, 0, len(page.Profiles))
	for _, p := range page.Profiles {
		out = append(out, runsonmigrate.Profile{Name: p.Name, State: p.State})
	}
	return out, nil
}

// readWorkflows reads the files GitHub reads: *.yml and *.yaml directly in
// .github/workflows, not in subdirectories.
func readWorkflows(repo string) ([]runsonmigrate.File, error) {
	dir := filepath.Join(repo, ".github", "workflows")
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, usagef("%s has no .github/workflows directory", repo)
	}
	if err != nil {
		return nil, err
	}
	var files []runsonmigrate.File
	for _, e := range entries {
		name := e.Name()
		if !e.Type().IsRegular() || (!strings.HasSuffix(name, ".yml") && !strings.HasSuffix(name, ".yaml")) {
			continue
		}
		content, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			return nil, err
		}
		files = append(files, runsonmigrate.File{Path: ".github/workflows/" + name, Content: content})
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	return files, nil
}

// writeFileAtomic replaces a file through a temporary file in the same
// directory, keeping its mode, so an interrupted write leaves the old file.
func writeFileAtomic(path string, content []byte) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*")
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(tmp.Name()) }()
	if _, err := tmp.Write(content); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Chmod(info.Mode().Perm()); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}
