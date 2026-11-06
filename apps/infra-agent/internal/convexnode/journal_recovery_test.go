package convexnode

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// captureJournalLog collects the journal's warnings for one test.
func captureJournalLog(t *testing.T) *capturedLog {
	t.Helper()
	logs := &capturedLog{}
	old := journalLogf
	journalLogf = logs.logf
	t.Cleanup(func() { journalLogf = old })
	return logs
}

func writeJournal(t *testing.T, dir, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, "execution.jsonl"), []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
}

const bindingLine = `{"key":"binding","id":"%URL%|node-a","outcome":"success"}` + "\n"

// Power loss during an append leaves a torn last record. The agent starts anyway, and what the key
// reads back as depends on which record was torn: never one that lets a command whose effect may
// have started run again.
func TestTornLastRecordIsRecoveredByKind(t *testing.T) {
	for _, tc := range []struct {
		name string
		// tail follows the binding record. cmd-1 is the command fakeAPI delivers, keyed
		// node-a:restart-1.
		tail string
		// executions is how often the delivered command runs; reported is what Convex is told.
		executions int
		reported   string
		logged     string
	}{
		{
			name: "accepted without its newline: the command never started, so it runs",
			tail: `{"key":"node-a:restart-1","id":"cmd-1","outc`, executions: 1, reported: "success",
			logged: "without its newline",
		},
		{
			name:     "an outcome without its newline: the key stays unknown and the command never runs again",
			tail:     `{"key":"node-a:restart-1","id":"cmd-1","outcome":"accepted"}` + "\n" + `{"key":"node-a:restart-1","id":"cmd-1","outcome":"succ`,
			reported: "unknown", logged: "without its newline",
		},
		{
			name:     "settled without its newline: the outcome is replayed",
			tail:     `{"key":"node-a:restart-1","id":"cmd-1","outcome":"accepted"}` + "\n" + `{"key":"node-a:restart-1","id":"cmd-1","outcome":"success"}` + "\n" + `{"key":"node-a:restart-1","id":"cmd-1","outcome":"sett`,
			reported: "success", logged: "without its newline",
		},
		{
			name: "a complete record missing only its newline is still dropped: its fsync never returned",
			tail: `{"key":"node-a:restart-1","id":"cmd-1","outcome":"accepted"}`, executions: 1, reported: "success",
			logged: "without its newline",
		},
		{
			name:     "a zero-filled first record for a key: its command may have started, so it is unknown",
			tail:     `{"key":"node-a:restart-1","id":"cmd-1","outcome":"acc` + "\x00\x00\x00\x00\n",
			reported: "unknown", logged: `first for key "node-a:restart-1"`,
		},
		{
			name:     "a damaged record for a key already held: the key keeps its earlier state",
			tail:     `{"key":"node-a:restart-1","id":"cmd-1","outcome":"failure"}` + "\n" + `{"key":"node-a:restart-1","id":"cmd-1","outcome":"se` + "\x00\x00\x00\n",
			reported: "failure", logged: "keeps its earlier state",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			logs := captureJournalLog(t)
			dir := privateDir(t)
			api := &fakeAPI{}
			exec := &fakeExecutor{}
			first, url := clientFor(t, api, dir, exec)
			_ = first.Close()
			writeJournal(t, dir, strings.ReplaceAll(bindingLine, "%URL%", url)+tc.tail)
			c, err := New(Config{URL: url, Credential: first.cfg.Credential, StateDir: dir, AllowHTTPForTests: true}, exec)
			if err != nil {
				t.Fatalf("the agent refused to start on a torn last record: %v", err)
			}
			defer func() { _ = c.Close() }()
			if logs.matching("WARNING: journal") != 1 || logs.matching(tc.logged) != 1 {
				t.Fatalf("recovery was not logged loudly: %q", logs.lines)
			}
			// The torn bytes are gone from disk before anything is appended after them.
			for _, line := range journalLines(t, dir) {
				if _, err := parseRecord([]byte(line + "\n")); err != nil {
					t.Fatalf("damaged record left on disk: %q", line)
				}
			}
			if _, err := c.Step(context.Background()); err != nil {
				t.Fatal(err)
			}
			if exec.calls != tc.executions || api.result != tc.reported {
				t.Fatalf("executions=%d reported=%q, want %d and %q", exec.calls, api.result, tc.executions, tc.reported)
			}
		})
	}
}

// A torn binding record is dropped and written again by the next heartbeat.
func TestTornBindingIsWrittenAgain(t *testing.T) {
	captureJournalLog(t)
	dir := privateDir(t)
	writeJournal(t, dir, `{"key":"binding","id":"http://127.0.0.1:1|no`)
	c, _ := clientFor(t, &fakeAPI{}, dir, &fakeExecutor{})
	defer func() { _ = c.Close() }()
	if _, err := c.Step(context.Background()); err != nil {
		t.Fatal(err)
	}
	if r, ok := c.journal.records[bindingKey]; !ok || !strings.HasSuffix(r.ID, "|node-a") {
		t.Fatalf("binding not written again: %v", c.journal.records)
	}
}

// What cannot be an interrupted append is refused: a damaged record before the last one, and a
// damaged last record whose key cannot be read, since nothing then says which command must not run
// again.
func TestDamagedJournalThatIsNotATornAppendFailsClosed(t *testing.T) {
	captureJournalLog(t)
	for name, content := range map[string]string{
		"damaged record in the middle":  `{"key":"node-a:a","id":"a","outcome":"success"}` + "\n" + `{"key":"node-a:b","id":"b","outc` + "\x00\n" + `{"key":"node-a:c","id":"c","outcome":"success"}` + "\n",
		"last record with its key lost": `{"key":"node-a:a","id":"a","outcome":"success"}` + "\n" + "\x00\x00\x00\x00\x00\x00\",\"outcome\":\"accepted\"}\n",
		"unknown outcome in the middle": `{"key":"node-a:a","id":"a","outcome":"maybe"}` + "\n" + `{"key":"node-a:c","id":"c","outcome":"success"}` + "\n",
	} {
		t.Run(name, func(t *testing.T) {
			dir := privateDir(t)
			writeJournal(t, dir, content)
			j, err := OpenJournal(dir)
			if err == nil {
				_ = j.Close()
				t.Fatal("damaged journal accepted")
			}
			if !strings.Contains(err.Error(), "When the journal is damaged") && !strings.Contains(err.Error(), "invalid journal outcome") {
				t.Fatalf("error does not point at the recovery: %v", err)
			}
			if _, err := ListJournal(dir); err == nil {
				t.Fatal("list read a damaged journal")
			}
			data, _ := os.ReadFile(filepath.Join(dir, "execution.jsonl"))
			if string(data) != content {
				t.Fatal("a refused journal was modified")
			}
		})
	}
}

// The operator's way out of a full journal keeps working after power loss during an append.
func TestJournalReleaseRecoversATornTail(t *testing.T) {
	captureJournalLog(t)
	dir := privateDir(t)
	writeJournal(t, dir, `{"key":"binding","id":"https://x.convex.site|n1","outcome":"success"}
{"key":"n1:restart-2","id":"c2","outcome":"accepted"}
{"key":"n1:restart-2","id":"c2","outcome":"success"}
{"key":"n1:restart-2","id":"c2","outcome":"sett`)
	entries, err := ListJournal(dir)
	if err != nil || len(entries) != 1 || entries[0].Outcome != outcomeSuccess {
		t.Fatalf("list: %v %v", entries, err)
	}
	if err := ReleaseJournalKeys(dir, []string{"n1:restart-2"}); err != nil {
		t.Fatalf("release refused a torn journal: %v", err)
	}
	j, err := OpenJournal(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = j.Close() }()
	if j.keys() != 0 {
		t.Fatalf("released key still held: %v", j.records)
	}
}

// A failed append does not leave a partial line for the next record to land after. The file is
// rewritten from memory; if even that fails, appends stop until a restart.
func TestFailedAppendLeavesNoDamageBehind(t *testing.T) {
	dir := privateDir(t)
	j, err := OpenJournal(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = j.Close() }()
	if err := j.append("node-a:a", "a", outcomeSuccess); err != nil {
		t.Fatal(err)
	}
	// The write fails: the handle is gone underneath it.
	_ = j.file.Close()
	var journalErr journalError
	if err := j.append("node-a:b", "b", outcomeAccepted); !errors.As(err, &journalErr) {
		t.Fatalf("failed write not reported as a journal error: %v", err)
	}
	if _, held := j.records["node-a:b"]; held || j.broken != nil {
		t.Fatalf("held=%v broken=%v", held, j.broken)
	}
	if err := j.append("node-a:c", "c", outcomeAccepted); err != nil {
		t.Fatalf("the journal did not recover from a failed write: %v", err)
	}
	// Now the rewrite cannot happen either: the directory refuses new files.
	_ = j.file.Close()
	if err := os.Chmod(dir, 0500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0700) })
	if err := j.append("node-a:d", "d", outcomeAccepted); err == nil {
		t.Fatal("append succeeded on a closed handle")
	}
	if j.broken == nil {
		t.Skip("this platform let the rewrite through a read-only directory")
	}
	_ = os.Chmod(dir, 0700)
	if err := j.append("node-a:e", "e", outcomeAccepted); err == nil || !strings.Contains(err.Error(), "restart the Infra Agent") {
		t.Fatalf("a journal that could not be put back in order kept appending: %v", err)
	}
	if blockedReason(j.append("node-a:e", "e", outcomeAccepted)) != blockedJournalError {
		t.Fatal("a broken journal is not reported as journal_error")
	}
	_ = j.Close()
	reopened, err := OpenJournal(dir)
	if err != nil {
		t.Fatalf("restart could not read the journal back: %v", err)
	}
	defer func() { _ = reopened.Close() }()
	for _, key := range []string{"node-a:a", "node-a:c"} {
		if _, ok := reopened.records[key]; !ok {
			t.Fatalf("%s lost: %v", key, reopened.records)
		}
	}
}
