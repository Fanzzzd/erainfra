package main

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// tree is the repository as the bump sees it: files are read on first use and
// every edit lands in memory, so a target that fails half way leaves nothing on
// disk. flush writes only what changed.
type tree struct {
	root     string
	original map[string]string
	current  map[string]string
}

func newTree(root string) *tree {
	return &tree{root: root, original: map[string]string{}, current: map[string]string{}}
}

func (t *tree) read(rel string) (string, error) {
	if content, ok := t.current[rel]; ok {
		return content, nil
	}
	raw, err := os.ReadFile(filepath.Join(t.root, filepath.FromSlash(rel)))
	if err != nil {
		return "", err
	}
	t.original[rel] = string(raw)
	t.current[rel] = string(raw)
	return string(raw), nil
}

func (t *tree) write(rel, content string) {
	t.current[rel] = content
}

// snapshot and restore let one target's edits be discarded when that target
// fails after editing some of its files.
func (t *tree) snapshot() map[string]string {
	saved := make(map[string]string, len(t.current))
	for rel, content := range t.current {
		saved[rel] = content
	}
	return saved
}

func (t *tree) restore(saved map[string]string) {
	t.current = saved
}

func (t *tree) changed() []string {
	var out []string
	for rel, content := range t.current {
		if content != t.original[rel] {
			out = append(out, rel)
		}
	}
	sort.Strings(out)
	return out
}

func (t *tree) flush() error {
	for _, rel := range t.changed() {
		path := filepath.Join(t.root, filepath.FromSlash(rel))
		info, err := os.Stat(path)
		if err != nil {
			return err
		}
		if err := os.WriteFile(path, []byte(t.current[rel]), info.Mode().Perm()); err != nil {
			return err
		}
	}
	return nil
}

// glob lists files under dir (relative to the root) whose name matches one of
// the suffixes, in a stable order.
func (t *tree) glob(dir string, suffixes ...string) ([]string, error) {
	var out []string
	base := filepath.Join(t.root, filepath.FromSlash(dir))
	err := filepath.WalkDir(base, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		for _, suffix := range suffixes {
			if strings.HasSuffix(entry.Name(), suffix) {
				rel, err := filepath.Rel(t.root, path)
				if err != nil {
					return err
				}
				out = append(out, filepath.ToSlash(rel))
				break
			}
		}
		return nil
	})
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	sort.Strings(out)
	return out, err
}

// replace rewrites every match of re in rel with repl (regexp template syntax,
// so $1 keeps a group) and fails unless the match count is within [lo, hi]; a
// negative hi means no upper bound. The count is the guard against a pin that
// moved: a pattern that silently matches nothing would leave the old value in
// place while the pull request claims it moved.
func (t *tree) replace(rel string, re *regexp.Regexp, repl string, lo, hi int) (int, error) {
	content, err := t.read(rel)
	if err != nil {
		return 0, err
	}
	n := len(re.FindAllStringIndex(content, -1))
	if n < lo || (hi >= 0 && n > hi) {
		return n, fmt.Errorf("%s: expected %s match(es) of %s, found %d", rel, countRange(lo, hi), re, n)
	}
	t.write(rel, re.ReplaceAllString(content, repl))
	return n, nil
}

// replaceOne is replace for the common case of a pin written exactly once.
func (t *tree) replaceOne(rel string, re *regexp.Regexp, repl string) error {
	_, err := t.replace(rel, re, repl, 1, 1)
	return err
}

func countRange(lo, hi int) string {
	switch {
	case lo == hi:
		return fmt.Sprint(lo)
	case hi < 0:
		return fmt.Sprintf("at least %d", lo)
	default:
		return fmt.Sprintf("%d to %d", lo, hi)
	}
}

// replaceToken rewrites every standalone occurrence of the version old in rel,
// both as written (1.25.3) and as a regular expression escapes it (1\.25\.3),
// which is how smoke.sh asserts several pins. Standalone means old is not part
// of a longer version: 1.25.3 inside 11.25.3, 1.25.30 or 1.25.3.1 is left
// alone. It fails when fewer than lo occurrences exist.
func (t *tree) replaceToken(rel, old, new string, lo int) error {
	content, err := t.read(rel)
	if err != nil {
		return err
	}
	content, plain := replaceStandalone(content, old, new)
	escape := func(v string) string { return strings.ReplaceAll(v, ".", `\.`) }
	content, escaped := replaceStandalone(content, escape(old), escape(new))
	if plain+escaped < lo {
		return fmt.Errorf("%s: expected at least %d occurrence(s) of %s, found %d", rel, lo, old, plain+escaped)
	}
	t.write(rel, content)
	return nil
}

func replaceStandalone(s, old, new string) (string, int) {
	if old == "" {
		return s, 0
	}
	var b strings.Builder
	count := 0
	for i := 0; ; {
		j := strings.Index(s[i:], old)
		if j < 0 {
			b.WriteString(s[i:])
			break
		}
		start, end := i+j, i+j+len(old)
		if standalone(s, start, end) {
			b.WriteString(s[i:start])
			b.WriteString(new)
			count++
		} else {
			b.WriteString(s[i:end])
		}
		i = end
	}
	return b.String(), count
}

func standalone(s string, start, end int) bool {
	if start > 0 {
		prev := s[start-1]
		if isDigit(prev) || prev == '.' {
			return false
		}
	}
	if end < len(s) {
		next := s[end]
		if isDigit(next) {
			return false
		}
		if next == '.' && end+1 < len(s) && isDigit(s[end+1]) {
			return false
		}
		if next == '\\' && end+2 < len(s) && s[end+1] == '.' && isDigit(s[end+2]) {
			return false
		}
	}
	return true
}

func isDigit(c byte) bool { return c >= '0' && c <= '9' }

// argValue reads `ARG name=value` from a Dockerfile. ok is false when the ARG
// is not declared with a default.
func argValue(dockerfile, name string) (string, bool) {
	m := regexp.MustCompile(`(?m)^ARG ` + regexp.QuoteMeta(name) + `=(\S+)$`).FindStringSubmatch(dockerfile)
	if m == nil {
		return "", false
	}
	return m[1], true
}

// setArchSHAs rewrites the per-architecture checksums in the one RUN
// instruction of a Dockerfile that downloads with ${arg}. Every tool in
// images/ubuntu-24.04-js has that shape:
//
//	RUN case "$TARGETARCH" in \
//	      amd64) ...; <shaVar>=<hex> ;; \
//	      arm64) ...; <shaVar>=<hex> ;; \
//	...
//	    "https://.../${<arg>}/..." \
//
// Keying on the ARG rather than on the variable name matters because two
// blocks can share a variable name: both Node blocks call theirs node_sha.
func setArchSHAs(dockerfile, arg, shaVar string, byArch map[string]string) (string, error) {
	lines := strings.Split(dockerfile, "\n")
	type span struct{ start, end int }
	var blocks []span
	for i := 0; i < len(lines); i++ {
		if !strings.HasPrefix(lines[i], "RUN ") {
			continue
		}
		start := i
		for i < len(lines)-1 && strings.HasSuffix(lines[i], `\`) {
			i++
		}
		blocks = append(blocks, span{start, i})
	}
	ref := "${" + arg + "}"
	var matched []span
	for _, block := range blocks {
		if strings.Contains(strings.Join(lines[block.start:block.end+1], "\n"), ref) {
			matched = append(matched, block)
		}
	}
	if len(matched) != 1 {
		return "", fmt.Errorf("expected one RUN instruction using %s, found %d", ref, len(matched))
	}
	block := matched[0]
	for _, arch := range sortedKeys(byArch) {
		re := regexp.MustCompile(`^(\s*` + regexp.QuoteMeta(arch) + `\).*\b` + regexp.QuoteMeta(shaVar) + `=)[0-9a-f]{64}\b`)
		hits := 0
		for i := block.start; i <= block.end; i++ {
			if re.MatchString(lines[i]) {
				lines[i] = re.ReplaceAllString(lines[i], "${1}"+byArch[arch])
				hits++
			}
		}
		if hits != 1 {
			return "", fmt.Errorf("the RUN instruction using %s has %d %s) lines carrying %s, expected 1", ref, hits, arch, shaVar)
		}
	}
	return strings.Join(lines, "\n"), nil
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
