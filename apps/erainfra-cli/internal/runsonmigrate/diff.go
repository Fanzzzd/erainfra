package runsonmigrate

import (
	"bytes"
	"fmt"
	"strings"
)

const diffContext = 3

// Diff renders a file's change as a unified diff with git's a/ and b/
// prefixes, so `git apply` and `patch -p1` take it. An edit only ever
// replaces text inside one line, so the two versions have the same lines and
// the hunks pair them one to one; no general diff algorithm is needed.
func Diff(r FileResult) (string, error) {
	if !r.Changed() {
		return "", nil
	}
	old, oldEOL := splitLines(r.Original)
	updated, newEOL := splitLines(r.Updated)
	if len(old) != len(updated) {
		// Only a target with a line break could do this, and the CLI refuses one.
		return "", fmt.Errorf("%s: the rewrite changed the number of lines", r.Path)
	}
	var changed []int
	for i := range old {
		if old[i] != updated[i] {
			changed = append(changed, i)
		}
	}
	var b strings.Builder
	fmt.Fprintf(&b, "--- a/%s\n+++ b/%s\n", r.Path, r.Path)
	for h := 0; h < len(changed); {
		start := max(0, changed[h]-diffContext)
		end := min(len(old), changed[h]+diffContext+1)
		next := h + 1
		for next < len(changed) && changed[next]-diffContext <= end {
			end = min(len(old), changed[next]+diffContext+1)
			next++
		}
		count := end - start
		fmt.Fprintf(&b, "@@ -%s +%s @@\n", hunkRange(start, count), hunkRange(start, count))
		isChanged := map[int]bool{}
		for _, i := range changed[h:next] {
			isChanged[i] = true
		}
		for i := start; i < end; i++ {
			last := i == len(old)-1
			if !isChanged[i] {
				writeLine(&b, ' ', old[i], last && !oldEOL)
				continue
			}
			writeLine(&b, '-', old[i], last && !oldEOL)
			writeLine(&b, '+', updated[i], last && !newEOL)
		}
		h = next
	}
	return b.String(), nil
}

func hunkRange(start, count int) string {
	if count == 1 {
		return fmt.Sprintf("%d", start+1)
	}
	return fmt.Sprintf("%d,%d", start+1, count)
}

func writeLine(b *strings.Builder, prefix byte, line string, noNewline bool) {
	b.WriteByte(prefix)
	b.WriteString(line)
	b.WriteByte('\n')
	if noNewline {
		b.WriteString("\\ No newline at end of file\n")
	}
}

// splitLines splits on \n and reports whether the content ends in one. A \r
// stays on its line, so a CRLF file diffs as CRLF.
func splitLines(content []byte) ([]string, bool) {
	if len(content) == 0 {
		return nil, true
	}
	trailing := bytes.HasSuffix(content, []byte("\n"))
	text := string(content)
	if trailing {
		text = text[:len(text)-1]
	}
	return strings.Split(text, "\n"), trailing
}
