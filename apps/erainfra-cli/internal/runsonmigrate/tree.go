package runsonmigrate

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"

	"go.yaml.in/yaml/v3"
)

// The rewrite edits bytes, but its promise is about the YAML a reader of the
// workflow sees: after the edit, every value is what it was except the labels
// the command changed. This file holds the two tree walks that keep that
// promise: one finds every place a node is read from (an anchor makes one node
// appear under several paths), the other re-reads the rewritten file and
// compares it with the original, path by path.

// maxExpanded bounds an alias-expanded walk. A workflow has a few thousand
// nodes; a file past this is an alias bomb, and the command leaves it alone.
const maxExpanded = 200_000

var (
	errAliasCycle = errors.New("a YAML alias refers to a node that contains it")
	errTooLarge   = fmt.Errorf("the file expands to more than %d YAML nodes through its aliases", maxExpanded)
)

// expand walks n with every alias replaced by the node it names, calling visit
// with each node and its path: mapping keys by value, sequence items as [i].
func expand(n *yaml.Node, visit func(n *yaml.Node, path []string)) error {
	count := 0
	open := map[*yaml.Node]bool{}
	var walk func(n *yaml.Node, path []string) error
	walk = func(n *yaml.Node, path []string) error {
		if n == nil {
			return nil
		}
		if count++; count > maxExpanded {
			return errTooLarge
		}
		if n.Kind == yaml.AliasNode {
			if n.Alias == nil {
				return nil
			}
			if open[n.Alias] {
				return errAliasCycle
			}
			open[n.Alias] = true
			defer delete(open, n.Alias)
			return walk(n.Alias, path)
		}
		visit(n, path)
		switch n.Kind {
		case yaml.DocumentNode:
			for _, c := range n.Content {
				if err := walk(c, path); err != nil {
					return err
				}
			}
		case yaml.MappingNode:
			for i := 0; i+1 < len(n.Content); i += 2 {
				key := n.Content[i]
				segment := key.Value
				if key.Kind != yaml.ScalarNode {
					segment = "?" + strconv.Itoa(i/2)
					if err := walk(key, appendPath(path, segment+"(key)")); err != nil {
						return err
					}
				}
				if err := walk(n.Content[i+1], appendPath(path, segment)); err != nil {
					return err
				}
			}
		case yaml.SequenceNode:
			for i, c := range n.Content {
				if err := walk(c, appendPath(path, "["+strconv.Itoa(i)+"]")); err != nil {
					return err
				}
			}
		}
		return nil
	}
	return walk(n, nil)
}

func appendPath(path []string, segment string) []string {
	out := make([]string, len(path), len(path)+1)
	copy(out, path)
	return append(out, segment)
}

// pathKey is a path as a map key; a key may itself contain dots.
func pathKey(path []string) string { return strings.Join(path, "\x00") }

// showPath prints a path the way a workflow author would write it.
func showPath(path []string) string {
	var b strings.Builder
	for _, s := range path {
		if b.Len() > 0 && !strings.HasPrefix(s, "[") {
			b.WriteByte('.')
		}
		b.WriteString(s)
	}
	return b.String()
}

// isRunsOnPath reports whether a path is a job's runs-on label: the scalar,
// a list item, or the labels of a group/labels mapping.
func isRunsOnPath(path []string) bool {
	if len(path) < 3 || path[0] != "jobs" || path[2] != "runs-on" {
		return false
	}
	rest := path[3:]
	if len(rest) > 0 && rest[0] == "labels" {
		rest = rest[1:]
	}
	return len(rest) == 0 || (len(rest) == 1 && strings.HasPrefix(rest[0], "["))
}

// occurrences maps each node of the workflow to every path it is read under.
func occurrences(root *yaml.Node) (map[*yaml.Node][][]string, error) {
	out := map[*yaml.Node][][]string{}
	err := expand(root, func(n *yaml.Node, path []string) {
		out[n] = append(out[n], path)
	})
	return out, err
}

// treeEntry is one node of a document as a reader sees it.
type treeEntry struct {
	key   string // pathKey, prefixed by the document's index
	path  []string
	kind  yaml.Kind
	style yaml.Style
	tag   string
	value string
	size  int
}

// flatten reads every document in b, aliases expanded, in order. A document
// that does not parse ends the list with its error, so a later document the
// parser rejects compares equal only if it is rejected the same way.
func flatten(b []byte) ([]treeEntry, error) {
	var out []treeEntry
	dec := yaml.NewDecoder(bytes.NewReader(b))
	for doc := 0; ; doc++ {
		var n yaml.Node
		err := dec.Decode(&n)
		if errors.Is(err, io.EOF) {
			return out, nil
		}
		if err != nil {
			return append(out, treeEntry{key: "error", value: err.Error()}), nil
		}
		root := &n
		if len(n.Content) == 1 {
			root = n.Content[0]
		}
		prefix := strconv.Itoa(doc) + "\x01"
		if err := expand(root, func(n *yaml.Node, path []string) {
			out = append(out, treeEntry{
				key: prefix + pathKey(path), path: path, kind: n.Kind, style: n.Style,
				tag: n.ShortTag(), value: n.Value, size: len(n.Content),
			})
		}); err != nil {
			return nil, err
		}
	}
}

// firstDocument keys a path of the first document, the one the rewrite reads.
func firstDocument(path []string) string { return "0\x01" + pathKey(path) }

// verify re-reads the rewritten bytes and checks them against the original
// tree. want maps the paths the command meant to change (firstDocument keys)
// to the value each must now hold; every other node must be as it was.
func verify(original, updated []byte, want map[string]string) error {
	before, err := flatten(original)
	if err != nil {
		return err
	}
	after, err := flatten(updated)
	if err != nil {
		return err
	}
	if len(before) != len(after) {
		return fmt.Errorf("the rewritten file has %d YAML nodes where the original has %d", len(after), len(before))
	}
	seen := 0
	for i, b := range before {
		a := after[i]
		where := showPath(b.path)
		if where == "" {
			where = "the document root"
		}
		if a.key != b.key || a.kind != b.kind || a.style != b.style || a.tag != b.tag || a.size != b.size {
			return fmt.Errorf("the rewritten file's structure differs at %s", where)
		}
		if expected, changed := want[b.key]; changed {
			seen++
			if a.value != expected {
				return fmt.Errorf("%s reads %q after the rewrite, not %q", where, a.value, expected)
			}
			continue
		}
		if a.value != b.value {
			return fmt.Errorf("%s changed from %q to %q, and it is not a label this command rewrites", where, b.value, a.value)
		}
	}
	if seen != len(want) {
		return fmt.Errorf("%d of the %d values it meant to change were not found after the rewrite", len(want)-seen, len(want))
	}
	return nil
}
