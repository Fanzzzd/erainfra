// Command pinbump moves the hand-pinned toolchain of the EraInfra image and
// provisioners to upstream's newest release: actions/runner (and the
// actions-runner container image), Node.js, Go, the GitHub CLI, and the
// Actions the image pre-downloads. Every checksum it writes is read from
// upstream's own checksum source and cross-checked where upstream publishes a
// second one; nothing it writes is computed from a file it merely downloaded,
// except a GitHub source archive, for which no published checksum exists.
//
// It edits the working tree and prints a Markdown summary. It never commits;
// .github/workflows/pin-bump.yml does that.
//
//	go run ./scripts/pinbump                 # every pin
//	go run ./scripts/pinbump -only runner    # one group
//	go run ./scripts/pinbump -skip actions -summary body.md
//
// GITHUB_TOKEN, when set, authenticates GitHub API reads (rate limit only).
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
)

// target is one pin, run in isolation: its edits are discarded if it fails,
// and its failure does not stop the others.
type target struct {
	group, name string
	run         func(b *bumper, ctx context.Context) (*outcome, error)
}

func targets() []target {
	out := []target{
		{"runner", "actions/runner", (*bumper).bumpRunner},
	}
	for _, pin := range nodePins {
		out = append(out, target{"node", pin.name, func(b *bumper, ctx context.Context) (*outcome, error) {
			return b.bumpNode(ctx, pin)
		}})
	}
	return append(out,
		target{"go", "Go", (*bumper).bumpGo},
		target{"gh", "GitHub CLI", (*bumper).bumpGH},
		target{"actions", "Actions seeded in the image", (*bumper).bumpSeededActions},
	)
}

var groups = []string{"runner", "node", "go", "gh", "actions"}

type result struct {
	changes []pinChange
	notes   []string
	failed  []string
	files   []string
}

func run(ctx context.Context, b *bumper, only, skip map[string]bool) result {
	var res result
	for _, t := range targets() {
		if (len(only) > 0 && !only[t.group]) || skip[t.group] {
			continue
		}
		saved := b.tree.snapshot()
		o, err := t.run(b, ctx)
		if err != nil {
			b.tree.restore(saved)
			res.failed = append(res.failed, fmt.Sprintf("%s: %v", t.name, err))
			continue
		}
		res.changes = append(res.changes, o.changes...)
		res.notes = append(res.notes, o.notes...)
	}
	res.files = b.tree.changed()
	return res
}

func (r result) markdown(skipped []string) string {
	var s strings.Builder
	if len(r.changes) == 0 {
		s.WriteString("Every checked pin is on upstream's newest release.\n")
	} else {
		s.WriteString("| Pin | From | To | Checksum source |\n|---|---|---|---|\n")
		for _, c := range r.changes {
			fmt.Fprintf(&s, "| %s | `%s` | `%s` | %s |\n", c.pin, c.from, c.to, c.source)
		}
	}
	if len(r.files) > 0 {
		s.WriteString("\nFiles changed:\n\n")
		for _, f := range r.files {
			fmt.Fprintf(&s, "- `%s`\n", f)
		}
	}
	if len(skipped) > 0 {
		fmt.Fprintf(&s, "\nNot checked in this run: %s.\n", strings.Join(skipped, ", "))
	}
	if len(r.notes) > 0 {
		s.WriteString("\nNotes:\n\n")
		for _, n := range r.notes {
			fmt.Fprintf(&s, "- %s\n", n)
		}
	}
	if len(r.failed) > 0 {
		s.WriteString("\nCould not be checked, so left as they were:\n\n")
		for _, f := range r.failed {
			fmt.Fprintf(&s, "- %s\n", strings.ReplaceAll(f, "\n", " "))
		}
	}
	return s.String()
}

func parseGroups(flagName, value string) (map[string]bool, error) {
	out := map[string]bool{}
	for _, g := range strings.Split(value, ",") {
		g = strings.TrimSpace(g)
		if g == "" {
			continue
		}
		known := false
		for _, k := range groups {
			known = known || k == g
		}
		if !known {
			return nil, fmt.Errorf("-%s: unknown group %q (have %s)", flagName, g, strings.Join(groups, ", "))
		}
		out[g] = true
	}
	return out, nil
}

func main() {
	os.Exit(realMain(os.Args[1:], os.Stdout, os.Stderr))
}

func realMain(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("pinbump", flag.ContinueOnError)
	fs.SetOutput(stderr)
	repo := fs.String("repo", ".", "repository root")
	onlyFlag := fs.String("only", "", "comma-separated groups to check ("+strings.Join(groups, ", ")+")")
	skipFlag := fs.String("skip", "", "comma-separated groups to leave alone")
	summary := fs.String("summary", "", "also write the Markdown summary to this file")
	keyring := fs.String("node-keyring", "", "gpgv keyring of Node.js release keys (default: download nodejs/release-keys)")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	only, err := parseGroups("only", *onlyFlag)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, err)
		return 2
	}
	skip, err := parseGroups("skip", *skipFlag)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, err)
		return 2
	}
	var skipped []string
	for _, g := range groups {
		if skip[g] || (len(only) > 0 && !only[g]) {
			skipped = append(skipped, g)
		}
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	up := newHTTPUpstream(os.Getenv("GITHUB_TOKEN"))
	verifier := &gpgvVerifier{up: up, keyring: *keyring}
	defer verifier.close()
	b := &bumper{up: up, tree: newTree(*repo), verifyNode: verifier.verify, cache: map[string][]byte{}}

	res := run(ctx, b, only, skip)
	if err := b.tree.flush(); err != nil {
		_, _ = fmt.Fprintln(stderr, err)
		return 1
	}
	body := res.markdown(skipped)
	_, _ = fmt.Fprint(stdout, body)
	if *summary != "" {
		if err := os.WriteFile(*summary, []byte(body), 0o644); err != nil {
			_, _ = fmt.Fprintln(stderr, err)
			return 1
		}
	}
	if len(res.failed) > 0 {
		return 1
	}
	return 0
}
