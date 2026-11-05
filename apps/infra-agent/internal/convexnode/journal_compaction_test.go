package convexnode

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// A Node whose journal holds maxJournalKeys settled, long-reported commands can still run new work.
func TestSettledHistoryDoesNotStopNewCommands(t *testing.T) {
	dir := privateDir(t)
	api := &fakeAPI{}
	exec := &fakeExecutor{}
	first, url := clientFor(t, api, dir, exec)
	_ = first.Close()
	j, err := OpenJournal(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err = j.append("binding", url+"|node-a", "success"); err != nil {
		t.Fatal(err)
	}
	for i := 0; len(j.records) < maxJournalKeys; i++ {
		if err = j.append(fmt.Sprintf("node-a:dep%05d:deploy:node-a", i), fmt.Sprintf("cmd%05d", i), "success"); err != nil {
			t.Fatal(err)
		}
	}
	_ = j.Close()
	next, err := New(Config{URL: url, Credential: first.cfg.Credential, StateDir: dir, AllowHTTPForTests: true}, exec)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = next.Close() }()
	for i := 0; i < 3; i++ { // three polls: the same command is retried, nothing else runs
		_, err = next.Step(context.Background())
	}
	t.Logf("journal keys=%d: step error=%v, executions=%d, result=%q", len(next.journal.records), err, exec.calls, api.result)
	if exec.calls != 1 {
		t.Fatalf("Node stopped executing new commands once its journal held %d settled keys: %v", maxJournalKeys, err)
	}
}

// withKeyLimit lowers the journal's key bound for one test, so a full journal takes a handful of
// fsyncs instead of ten thousand.
func withKeyLimit(t *testing.T, limit int) {
	t.Helper()
	old := maxJournalKeys
	maxJournalKeys = limit
	t.Cleanup(func() { maxJournalKeys = old })
}

type capturedLog struct {
	mu    sync.Mutex
	lines []string
}

func (l *capturedLog) logf(format string, args ...any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.lines = append(l.lines, fmt.Sprintf(format, args...))
}
func (l *capturedLog) matching(s string) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	n := 0
	for _, line := range l.lines {
		if strings.Contains(line, s) {
			n++
		}
	}
	return n
}

// fillJournal writes records straight into a closed journal, as an older run of the agent left it.
func fillJournal(t *testing.T, dir string, records ...record) {
	t.Helper()
	j, err := OpenJournal(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = j.Close() }()
	for _, r := range records {
		if err := j.append(r.Key, r.ID, r.Outcome); err != nil {
			t.Fatal(err)
		}
	}
}

func journalLines(t *testing.T, dir string) []string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, "execution.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	return strings.Split(strings.TrimSuffix(string(data), "\n"), "\n")
}

// Every command the Node reports is settled the moment Convex acknowledges it, so a busy Node's
// journal holds no history at all, and the file is rewritten before it grows past its bound.
func TestAcknowledgedReportsAreSettledAndTheFileStaysBounded(t *testing.T) {
	withGarbageLimit(t, 32)
	dir := privateDir(t)
	api := &fakeAPI{}
	exec := &fakeExecutor{}
	c, _ := clientFor(t, api, dir, exec)
	defer func() { _ = c.Close() }()
	if _, err := c.Step(context.Background()); err != nil {
		t.Fatal(err)
	}
	if exec.calls != 1 || api.result != "success" {
		t.Fatal(exec.calls, api.result)
	}
	if _, held, _ := c.journal.lookup("node-a:restart-1", "cmd-1"); held || c.journal.keys() != 0 {
		t.Fatalf("an acknowledged key was kept: %v", c.journal.records)
	}
	// Each command writes accepted, its outcome and a settlement: three lines that leave nothing.
	for i := 0; i < maxJournalGarbage; i++ {
		key, id := fmt.Sprintf("node-a:k%d", i), fmt.Sprintf("id%d", i)
		for _, outcome := range []string{outcomeAccepted, outcomeSuccess} {
			if err := c.journal.append(key, id, outcome); err != nil {
				t.Fatal(err)
			}
		}
		if ok, err := c.journal.settle(key, id); err != nil || !ok {
			t.Fatal(ok, err)
		}
	}
	if c.journal.lines >= maxJournalGarbage || c.journal.bytes > 64*1024 {
		t.Fatalf("journal was not rewritten: %d lines, %d bytes", c.journal.lines, c.journal.bytes)
	}
	lines := journalLines(t, dir)
	if int64(len(strings.Join(lines, "\n"))+1) != c.journal.bytes || len(lines) != c.journal.lines {
		t.Fatalf("in-memory size disagrees with the file: %d lines on disk, %d counted", len(lines), c.journal.lines)
	}
}

// Compaction only forgets a key once Convex has the same terminal outcome. Anything Convex can
// still deliver, anything unknown, and anything Convex ended some other way stays.
func TestSweepNeverDropsAKeyConvexHasNotAcknowledged(t *testing.T) {
	dir := privateDir(t)
	keep := map[string]string{ // key -> why it must stay
		"node-a:pending":   "Convex will deliver it again",
		"node-a:running":   "Convex will deliver it again once the lease lapses",
		"node-a:reported":  "the report never reached Convex",
		"node-a:cancelled": "cancelled while it ran: Convex never took the outcome",
		"node-a:differs":   "Convex recorded another outcome",
		"node-a:missing":   "Convex does not know the command",
		"node-a:unknown":   "an unknown outcome needs an operator",
		"node-a:accepted":  "interrupted: unknown after a restart",
	}
	fillJournal(t, dir,
		record{"node-a:done-ok", "c-done-ok", outcomeSuccess},
		record{"node-a:done-failed", "c-done-failed", outcomeFailure},
		record{"node-a:pending", "c-pending", outcomeSuccess},
		record{"node-a:running", "c-running", outcomeFailure},
		record{"node-a:reported", "c-reported", outcomeSuccess},
		record{"node-a:cancelled", "c-cancelled", outcomeSuccess},
		record{"node-a:differs", "c-differs", outcomeSuccess},
		record{"node-a:missing", "c-missing", outcomeFailure},
		record{"node-a:unknown", "c-unknown", outcomeUnknown},
		record{"node-a:accepted", "c-accepted", outcomeAccepted},
	)
	api := &fakeAPI{result: "done", statusOf: map[string]string{
		"c-done-ok": "success", "c-done-failed": "failure", "c-pending": "pending", "c-running": "running",
		"c-cancelled": "cancelled", "c-differs": "failure", "c-unknown": "unknown", "c-accepted": "unknown",
		// c-reported is left out of the answer, c-missing answered as missing.
		"c-missing": "missing",
	}}
	delete(api.statusOf, "c-reported")
	api.statusOf["c-reported"] = ""
	c, _ := clientFor(t, api, dir, &fakeExecutor{})
	defer func() { _ = c.Close() }()
	if err := c.sweepJournal(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	for _, gone := range []string{"node-a:done-ok", "node-a:done-failed"} {
		if _, ok := c.journal.records[gone]; ok {
			t.Fatalf("%s is acknowledged and terminal but was kept", gone)
		}
	}
	for key, why := range keep {
		if _, ok := c.journal.records[key]; !ok {
			t.Fatalf("%s was dropped although %s", key, why)
		}
	}
	for _, ids := range api.statusAsked {
		for _, id := range ids {
			if id == "c-unknown" || id == "c-accepted" {
				t.Fatalf("an unknown outcome was offered for compaction: %s", id)
			}
		}
	}
	// The same holds on disk: a restart sees exactly what memory holds.
	_ = c.Close()
	reopened, err := OpenJournal(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = reopened.Close() }()
	if len(reopened.records) != len(keep) {
		t.Fatalf("reopened journal holds %d records, want %d: %v", len(reopened.records), len(keep), reopened.records)
	}
	// Keys Convex ended without our outcome are not asked about on every sweep.
	if !c.journal.review["node-a:cancelled"] || !c.journal.review["node-a:differs"] || !c.journal.review["node-a:missing"] || c.journal.review["node-a:pending"] {
		t.Fatalf("review marks: %v", c.journal.review)
	}
}

// A failed report keeps its key, and a key whose report failed survives compaction and a restart
// and is replayed, not executed again.
func TestRestartAfterCompactionStillReplays(t *testing.T) {
	withGarbageLimit(t, 32)
	ctx := context.Background()
	dir := privateDir(t)
	api := &fakeAPI{reportFail: true}
	exec := &fakeExecutor{}
	c, url := clientFor(t, api, dir, exec)
	if _, err := c.Step(ctx); err == nil {
		t.Fatal("expected report failure")
	}
	if _, held, _ := c.journal.lookup("node-a:restart-1", "cmd-1"); !held {
		t.Fatal("an unacknowledged key was dropped")
	}
	// Enough settled history around it to force rewrites, and an interrupted rewrite's leftover.
	for i := 0; i < maxJournalGarbage+10; i++ {
		key, id := fmt.Sprintf("node-a:old%d", i), fmt.Sprintf("old%d", i)
		if err := c.journal.append(key, id, outcomeSuccess); err != nil {
			t.Fatal(err)
		}
		if _, err := c.journal.settle(key, id); err != nil {
			t.Fatal(err)
		}
	}
	if err := c.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "execution.jsonl.tmp"), []byte(`{"key":"torn`), 0600); err != nil {
		t.Fatal(err)
	}
	if lines := journalLines(t, dir); len(lines) > maxJournalGarbage {
		t.Fatalf("journal never compacted: %d lines", len(lines))
	}
	api.mu.Lock()
	api.reportFail = false
	api.mu.Unlock()
	next, err := New(Config{URL: url, Credential: c.cfg.Credential, StateDir: dir, AllowHTTPForTests: true}, exec)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = next.Close() }()
	if _, err := os.Stat(filepath.Join(dir, "execution.jsonl.tmp")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("leftover rewrite file kept", err)
	}
	if _, err = next.Step(ctx); err != nil {
		t.Fatal(err)
	}
	if exec.calls != 1 {
		t.Fatal("restarted an already completed external effect after compaction")
	}
	if api.result != "success" {
		t.Fatal(api.result)
	}
	if entries, err := ListJournal(dir); err != nil || len(entries) != 0 {
		t.Fatalf("after the replay was acknowledged no command key should remain: %v %v", entries, err)
	}
}

// withGarbageLimit lowers how many dead lines force a rewrite, so rewrites happen within a few
// dozen fsyncs.
func withGarbageLimit(t *testing.T, limit int) {
	t.Helper()
	old := maxJournalGarbage
	maxJournalGarbage = limit
	t.Cleanup(func() { maxJournalGarbage = old })
}

// A journal full of outcomes nobody checked refuses new work loudly: the error says what to do,
// it is logged once rather than on every poll, and the heartbeat tells Convex the Node is blocked.
// Releasing the checked keys clears all of it.
func TestFullJournalIsLoggedReportedAndRecoverable(t *testing.T) {
	withKeyLimit(t, 4)
	dir := privateDir(t)
	api := &fakeAPI{}
	exec := &fakeExecutor{}
	first, url := clientFor(t, api, dir, exec)
	_ = first.Close()
	fillJournal(t, dir,
		record{"binding", url + "|node-a", outcomeSuccess},
		record{"node-a:u1", "u1", outcomeUnknown},
		record{"node-a:u2", "u2", outcomeAccepted},
		record{"node-a:u3", "u3", outcomeUnknown},
	)
	c, err := New(Config{URL: url, Credential: first.cfg.Credential, StateDir: dir, AllowHTTPForTests: true}, exec)
	if err != nil {
		t.Fatal(err)
	}
	logs := &capturedLog{}
	c.Logf = logs.logf
	clock := time.Unix(1_800_000_000, 0)
	c.now = func() time.Time { return clock }
	poll := func() error {
		_, err := c.Step(context.Background())
		c.stepLog.observe(clock, err, c.logf)
		clock = clock.Add(3 * time.Second)
		return err
	}

	err = poll()
	if !errors.Is(err, ErrJournalFull) || exec.calls != 0 {
		t.Fatalf("full journal: err=%v executions=%d", err, exec.calls)
	}
	for _, want := range []string{"3 keys are held, 3 of them unknown", "infra-agent journal list", "When the journal is full"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error %q does not say %q", err, want)
		}
	}
	for i := 0; i < 5; i++ {
		if err := poll(); !errors.Is(err, ErrJournalFull) {
			t.Fatal(err)
		}
	}
	if n := logs.matching("journal key limit reached"); n != 1 {
		t.Fatalf("the same error was logged %d times in 18 seconds, want once: %q", n, logs.lines)
	}
	if n := logs.matching("(journal_full)"); n != 1 {
		t.Fatalf("log does not name the blocked reason: %q", logs.lines)
	}
	api.mu.Lock()
	last := api.heartbeats[len(api.heartbeats)-1]
	api.mu.Unlock()
	if last["commandsBlocked"] != "journal_full" || last["journalKeys"] != float64(3) || last["journalKeyLimit"] != float64(4) {
		t.Fatalf("heartbeat does not report the blocked Node: %v", last)
	}
	// The repeated error is logged again after stepLogRepeat.
	clock = clock.Add(stepLogRepeat)
	_ = poll()
	if n := logs.matching("still failing"); n != 1 {
		t.Fatalf("a persisting error was not logged again: %q", logs.lines)
	}

	// The operator checks the unknown outcomes and releases them, with the agent stopped.
	if err := ReleaseJournalKeys(dir, []string{"node-a:u1"}); err == nil {
		t.Fatal("released keys while the Infra Agent held the journal")
	}
	_ = c.Close()
	entries, err := ListJournal(dir)
	if err != nil || len(entries) != 3 || entries[1].Outcome != outcomeUnknown {
		t.Fatalf("list: %v %v", entries, err)
	}
	if err := ReleaseJournalKeys(dir, []string{"binding"}); err == nil {
		t.Fatal("released the binding")
	}
	if err := ReleaseJournalKeys(dir, []string{"node-a:nope"}); err == nil {
		t.Fatal("released a key that does not exist")
	}
	if err := ReleaseJournalKeys(dir, []string{"node-a:u1", "node-a:u2", "node-a:u3"}); err != nil {
		t.Fatal(err)
	}
	if entries, _ := ListJournal(dir); len(entries) != 0 {
		t.Fatalf("released keys still listed: %v", entries)
	}

	c, err = New(Config{URL: url, Credential: first.cfg.Credential, StateDir: dir, AllowHTTPForTests: true}, exec)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c.Close() }()
	c.Logf = logs.logf
	c.now = func() time.Time { return clock }
	c.stepLog = stepLog{last: "journal key limit reached", since: clock, failures: 7}
	if err := poll(); err != nil {
		t.Fatal(err)
	}
	if exec.calls != 1 {
		t.Fatal("released journal still refused work")
	}
	if logs.matching("recovered after 7 failed polls") != 1 {
		t.Fatalf("recovery not logged: %q", logs.lines)
	}
	// The next heartbeat clears the blocked state.
	_ = poll()
	api.mu.Lock()
	last = api.heartbeats[len(api.heartbeats)-1]
	api.mu.Unlock()
	if _, blocked := last["commandsBlocked"]; blocked {
		t.Fatalf("heartbeat still reports blocked: %v", last)
	}
}

// Spec reads and log tails are not journaled, so a full journal does not stop them.
func TestFullJournalStillRunsUnjournaledCommands(t *testing.T) {
	withKeyLimit(t, 2)
	dir := privateDir(t)
	api := &fakeAPI{kind: "logs"}
	first, url := clientFor(t, api, dir, &fakeExecutor{})
	_ = first.Close()
	fillJournal(t, dir, record{"binding", url + "|node-a", outcomeSuccess}, record{"node-a:u1", "u1", outcomeUnknown})
	c, err := New(Config{URL: url, Credential: first.cfg.Credential, StateDir: dir, AllowHTTPForTests: true}, &fakeExecutor{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c.Close() }()
	c.exec = &logReader{output: []byte("tail")}
	if _, err := c.Step(context.Background()); err != nil {
		t.Fatal(err)
	}
	if api.result != "success" {
		t.Fatal(api.result)
	}
}

// Any error that stops command polling is logged and reaches the heartbeat with its reason, and a
// failed heartbeat (Convex unreachable) is not mistaken for a blocked Node.
func TestStepErrorsReachTheHeartbeat(t *testing.T) {
	dir := privateDir(t)
	api := &fakeAPI{reportFail: true}
	c, _ := clientFor(t, api, dir, &fakeExecutor{})
	defer func() { _ = c.Close() }()
	clock := time.Unix(1_800_000_000, 0)
	c.now = func() time.Time { return clock }
	if _, err := c.Step(context.Background()); err == nil {
		t.Fatal("expected report failure")
	}
	if c.blocked != blockedCommandAPI {
		t.Fatal(c.blocked)
	}
	clock = clock.Add(3 * time.Second)
	_, _ = c.Step(context.Background())
	api.mu.Lock()
	if got := api.heartbeats[len(api.heartbeats)-1]["commandsBlocked"]; got != blockedCommandAPI {
		api.mu.Unlock()
		t.Fatalf("heartbeat blocked=%v", got)
	}
	api.mu.Unlock()
	if blockedReason(heartbeatError{nodeAPIError("node API unavailable")}) != blockedCommandAPI ||
		blockedReason(journalError{errors.New("disk")}) != blockedJournalError ||
		blockedReason(errors.New("command kind mismatch")) != blockedCommandError ||
		blockedReason(nil) != "" {
		t.Fatal("blocked reasons")
	}
	// Convex unreachable: the step fails at the heartbeat, which leaves the reason alone.
	c.blocked = ""
	c.cfg.URL = "http://127.0.0.1:1"
	clock = clock.Add(time.Minute)
	if _, err := c.Step(context.Background()); err == nil {
		t.Fatal("expected heartbeat failure")
	}
	if c.blocked != "" {
		t.Fatalf("an unreachable control plane marked the Node blocked: %q", c.blocked)
	}
}

// A control plane older than this agent refuses the new heartbeat fields; the agent keeps
// heartbeating with the version alone instead of dropping offline.
func TestHeartbeatFallsBackForAnOlderControlPlane(t *testing.T) {
	api := &fakeAPI{legacyHeartbeat: true}
	logs := &capturedLog{}
	c, _ := clientFor(t, api, privateDir(t), &fakeExecutor{})
	defer func() { _ = c.Close() }()
	c.Logf = logs.logf
	if _, err := c.Step(context.Background()); err != nil {
		t.Fatal(err)
	}
	if api.result != "success" || !c.legacyHeartbeat || logs.matching("does not accept command health") != 1 {
		t.Fatalf("result=%q legacy=%v logs=%q", api.result, c.legacyHeartbeat, logs.lines)
	}
}

// Without the status endpoint (an older control plane) a sweep fails and is logged; keys stay.
func TestSweepWithoutStatusEndpointKeepsKeys(t *testing.T) {
	dir := privateDir(t)
	fillJournal(t, dir, record{"node-a:x", "x", outcomeSuccess})
	api := &fakeAPI{noStatus: true}
	c, _ := clientFor(t, api, dir, &fakeExecutor{})
	defer func() { _ = c.Close() }()
	if err := c.sweepJournal(context.Background(), true); err == nil {
		t.Fatal("sweep against a 404 succeeded")
	}
	if _, ok := c.journal.records["node-a:x"]; !ok {
		t.Fatal("key dropped without an answer")
	}
	// Pacing: a forced sweep runs at most once per forcedSweepInterval, a routine one only past
	// sweepThreshold candidates.
	api.noStatus = false
	if err := c.sweepJournal(context.Background(), true); err != nil || len(api.statusAsked) != 0 {
		t.Fatal("forced sweep was not paced", err)
	}
	if err := c.sweepJournal(context.Background(), false); err != nil || len(api.statusAsked) != 0 {
		t.Fatal("routine sweep ran below its threshold", err)
	}
}

// ListJournal reads without the lock and tolerates a record still being written.
func TestListJournalToleratesAWriteInProgress(t *testing.T) {
	dir := privateDir(t)
	fillJournal(t, dir, record{"node-a:a", "a", outcomeSuccess}, record{"node-a:b", "b", outcomeAccepted})
	f, err := os.OpenFile(filepath.Join(dir, "execution.jsonl"), os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = f.WriteString(`{"key":"node-a:c","id":"c","out`)
	_ = f.Close()
	entries, err := ListJournal(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 || entries[0].Key != "node-a:a" || entries[1].Outcome != outcomeUnknown {
		t.Fatalf("%+v", entries)
	}
}

func TestStepLogRateLimitsDistinctErrors(t *testing.T) {
	logs := &capturedLog{}
	var l stepLog
	now := time.Unix(1_800_000_000, 0)
	a, b := errors.New("error a"), errors.New("error b")
	for _, step := range []struct {
		err error
		at  time.Duration
	}{{a, 0}, {a, time.Second}, {b, 2 * time.Second}, {a, 3 * time.Second}, {a, 4 * time.Second}, {a, 4*time.Second + stepLogRepeat}, {nil, 5*time.Second + stepLogRepeat}, {nil, 6*time.Second + stepLogRepeat}} {
		l.observe(now.Add(step.at), step.err, logs.logf)
	}
	if logs.matching("error a") != 3 || logs.matching("error b") != 1 || logs.matching("still failing (6 polls") != 1 || logs.matching("recovered after 6 failed polls") != 1 || len(logs.lines) != 5 {
		t.Fatalf("%q", logs.lines)
	}
}
