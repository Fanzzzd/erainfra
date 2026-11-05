package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Fanzzzd/erainfra/apps/infra-agent/internal/convexnode"
)

// The operator's recovery path for a full journal: list what it holds, then release checked keys.
func TestJournalCommandListsAndReleases(t *testing.T) {
	t.Setenv("ERAINFRA_NODE_STATE_DIR", "")
	dir := t.TempDir()
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	journal := `{"key":"binding","id":"https://x.convex.site|n1","outcome":"success"}
{"key":"n1:dep1:deploy:n1","id":"c1","outcome":"accepted"}
{"key":"n1:restart-2","id":"c2","outcome":"success"}
`
	if err := os.WriteFile(filepath.Join(dir, "execution.jsonl"), []byte(journal), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := runJournal([]string{"list", "--state-dir", dir}, &out); err != nil {
		t.Fatal(err)
	}
	want := `{"key":"n1:dep1:deploy:n1","commandId":"c1","outcome":"unknown"}
{"key":"n1:restart-2","commandId":"c2","outcome":"success"}
`
	if out.String() != want {
		t.Fatalf("list printed\n%s\nwant\n%s", out.String(), want)
	}
	out.Reset()
	if err := runJournal([]string{"release", "--state-dir", dir, "n1:dep1:deploy:n1"}, &out); err != nil {
		t.Fatal(err)
	}
	entries, err := convexnode.ListJournal(dir)
	if err != nil || len(entries) != 1 || entries[0].Key != "n1:restart-2" {
		t.Fatalf("after release: %v %v", entries, err)
	}
	for _, args := range [][]string{{}, {"list"}, {"release", "--state-dir", dir}, {"drop", "--state-dir", dir}, {"list", "--state-dir", "relative"}} {
		if err := runJournal(args, &out); err == nil {
			t.Fatalf("journal %q accepted", args)
		} else if len(args) < 2 && !strings.Contains(err.Error(), "usage") && !strings.Contains(err.Error(), "state-dir") {
			t.Fatalf("journal %q: unhelpful error %v", args, err)
		}
	}
}
