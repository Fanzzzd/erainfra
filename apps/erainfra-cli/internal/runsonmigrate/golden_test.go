package runsonmigrate

import (
	"bufio"
	"bytes"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"
)

var update = flag.Bool("update", false, "rewrite the golden files in testdata")

// Each directory under testdata is a repository: workflows/ holds its
// .github/workflows, profiles.txt (optional) the control plane's Profiles, and
// map.txt (optional) the --map pairs. want.diff and want.notes are the golden
// output; `go test ./internal/runsonmigrate -update` rewrites them.
func TestGolden(t *testing.T) {
	cases, err := os.ReadDir("testdata")
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		if !c.IsDir() {
			continue
		}
		t.Run(c.Name(), func(t *testing.T) {
			dir := filepath.Join("testdata", c.Name())
			files := readFixture(t, filepath.Join(dir, "workflows"))
			mapper := NewMapper(readMap(t, filepath.Join(dir, "map.txt")), readProfiles(t, filepath.Join(dir, "profiles.txt")))
			results := Rewrite(files, mapper)

			var diff, notes strings.Builder
			for _, r := range results {
				d, err := Diff(r)
				if err != nil {
					t.Fatal(err)
				}
				diff.WriteString(d)
				for _, ch := range r.Changes {
					fmt.Fprintf(&notes, "%s:%d:%d change %s %s: %s -> %s [%s] %s\n", r.Path, ch.Line, ch.Column, ch.Job, ch.Field, ch.From, ch.Label, ch.Source, ch.Reason)
				}
				for _, n := range r.Notes {
					fmt.Fprintf(&notes, "%s:%d note %s %s: %s\n", r.Path, n.Line, n.Job, n.Kind, n.Message)
				}
				checkRewrite(t, r)
			}
			golden(t, filepath.Join(dir, "want.diff"), diff.String())
			golden(t, filepath.Join(dir, "want.notes"), notes.String())

			// A second run over the rewritten files finds nothing more to change.
			var again []File
			for _, r := range results {
				again = append(again, File{Path: r.Path, Content: r.Updated})
			}
			for _, r := range Rewrite(again, mapper) {
				if r.Changed() {
					d, _ := Diff(r)
					t.Errorf("a second run still changes %s:\n%s", r.Path, d)
				}
			}
		})
	}
}

// checkRewrite holds every rewrite to the promise: the result parses, and it
// is the original YAML tree with only the changed labels replaced.
func checkRewrite(t *testing.T, r FileResult) {
	t.Helper()
	if !r.Changed() {
		return
	}
	var before, after yaml.Node
	if err := yaml.Unmarshal(r.Original, &before); err != nil {
		t.Fatalf("%s: original does not parse: %v", r.Path, err)
	}
	if err := yaml.Unmarshal(r.Updated, &after); err != nil {
		t.Fatalf("%s: rewrite does not parse: %v", r.Path, err)
	}
	renamed := map[string]string{}
	for _, c := range r.Changes {
		renamed[fmt.Sprintf("%d:%d", c.Line, c.Column)] = c.Label
	}
	var walk func(a, b *yaml.Node)
	walk = func(a, b *yaml.Node) {
		if a.Kind != b.Kind || len(a.Content) != len(b.Content) || a.Style != b.Style ||
			a.HeadComment != b.HeadComment || a.LineComment != b.LineComment || a.FootComment != b.FootComment {
			t.Errorf("%s:%d: the rewrite changed the node's shape, style or comments", r.Path, a.Line)
			return
		}
		want := a.Value
		if to, ok := renamed[fmt.Sprintf("%d:%d", a.Line, a.Column)]; ok && a.Kind == yaml.ScalarNode {
			want = to
		}
		if a.Kind == yaml.ScalarNode && b.Value != want && !strings.Contains(a.Value, "profile=") {
			t.Errorf("%s:%d: value %q became %q, want %q", r.Path, a.Line, a.Value, b.Value, want)
		}
		for i := range a.Content {
			walk(a.Content[i], b.Content[i])
		}
	}
	walk(&before, &after)
}

func readFixture(t *testing.T, dir string) []File {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var files []File
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".yml") && !strings.HasSuffix(e.Name(), ".yaml") {
			continue
		}
		content, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			t.Fatal(err)
		}
		files = append(files, File{Path: ".github/workflows/" + e.Name(), Content: content})
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	return files
}

func readProfiles(t *testing.T, path string) []Profile {
	t.Helper()
	var out []Profile
	for _, line := range readLines(t, path) {
		name, state, _ := strings.Cut(line, " ")
		out = append(out, Profile{Name: name, State: state})
	}
	if out == nil && !exists(path) {
		return nil
	}
	return out
}

func readMap(t *testing.T, path string) map[string]string {
	t.Helper()
	out := map[string]string{}
	for _, line := range readLines(t, path) {
		from, to, _ := strings.Cut(line, "=")
		out[from] = to
	}
	return out
}

func readLines(t *testing.T, path string) []string {
	t.Helper()
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	scanner := bufio.NewScanner(bytes.NewReader(data))
	for scanner.Scan() {
		if line := strings.TrimSpace(scanner.Text()); line != "" && !strings.HasPrefix(line, "#") {
			out = append(out, line)
		}
	}
	return out
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func golden(t *testing.T, path, got string) {
	t.Helper()
	if *update {
		if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v (run with -update to create it)", err)
	}
	if string(want) != got {
		t.Errorf("%s differs (run with -update to accept):\n--- want\n%s\n--- got\n%s", path, want, got)
	}
}
