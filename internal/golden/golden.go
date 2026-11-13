// Package golden owns how a Go producer records a wire shape for another program's tests to read.
//
// The producer's test builds the exact bytes it sends and calls Check. With ERAINFRA_UPDATE_GOLDEN=1
// in the environment, Check writes them to the golden file. Otherwise it fails the test when they
// differ from the file. The consumer's tests read the same file, so a field renamed or a value
// changed on one side fails a test on the other (AGENTS.md, "Where a rule lives").
package golden

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

// UpdateVariable is the environment variable that makes Check rewrite golden files.
const UpdateVariable = "ERAINFRA_UPDATE_GOLDEN"

// Check compares got with the golden file at path, or writes it there when UpdateVariable is 1.
// readers names the programs that parse the file, for the failure message.
func Check(t testing.TB, path string, got []byte, readers string) {
	t.Helper()
	if os.Getenv(UpdateVariable) == "1" {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, got, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read golden %s (generate it with %s=1): %v", path, UpdateVariable, err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf(
			"%s changed; regenerate it with %s=1 and check %s still accept it:\ngot:\n%s\nwant:\n%s",
			path, UpdateVariable, readers, got, want,
		)
	}
}
