package jobhint

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const fixture = "testdata/Worker_20261110-081402-utc.log"

var fixtureHint = Hint{Repository: "octo-org/octo-repo", RunID: 42820231088, RunAttempt: 1}

func readFixture(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile(fixture)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestParseReadsTheGitHubContextOfARealisticWorkerLog(t *testing.T) {
	// The fixture puts a decoy repository and run_id inside github.event and a
	// step input, and noise lines before the job message; only the top-level
	// github keys count.
	got, err := Parse(strings.NewReader(readFixture(t)))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if got != fixtureHint {
		t.Fatalf("Parse = %+v, want %+v", got, fixtureHint)
	}
}

func TestParseAcceptsTypedScalarsAndCaseInsensitiveNames(t *testing.T) {
	log := `[2026-11-10 08:14:02Z INFO Worker] Message received.
[2026-11-10 08:14:02Z INFO Worker] Job message:
 {"ContextData": {"GitHub": {"t": 5, "d": [
   {"k": "repository", "v": {"t": 0, "s": "a/b.c"}},
   {"k": "run_id", "v": {"t": 4, "n": 7.0}},
   {"k": "run_attempt", "v": 2}
 ]}}}
`
	got, err := Parse(strings.NewReader(log))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if want := (Hint{Repository: "a/b.c", RunID: 7, RunAttempt: 2}); got != want {
		t.Fatalf("Parse = %+v, want %+v", got, want)
	}
}

func TestParseRefusesWhatIsNotAHint(t *testing.T) {
	message := func(repository, runID, attempt string) string {
		return "[x INFO Worker] Job message:\n {\"contextData\":{\"github\":{\"t\":2,\"d\":[" +
			`{"k":"repository","v":` + repository + `},` +
			`{"k":"run_id","v":` + runID + `},` +
			`{"k":"run_attempt","v":` + attempt + `}]}}}` + "\n"
	}
	cases := map[string]string{
		"no marker":             "[x INFO Worker] Message received.\n",
		"no github context":     "[x INFO Worker] Job message:\n {\"contextData\":{}}\n",
		"repository shape":      message(`"../etc"`, `"1"`, `"1"`),
		"repository slashes":    message(`"a/b/c"`, `"1"`, `"1"`),
		"zero run id":           message(`"a/b"`, `"0"`, `"1"`),
		"negative run id":       message(`"a/b"`, `"-4"`, `"1"`),
		"signed run id":         message(`"a/b"`, `"+4"`, `"1"`),
		"fractional run id":     message(`"a/b"`, `4.5`, `"1"`),
		"run id overflow":       message(`"a/b"`, `"99999999999999999999"`, `"1"`),
		"missing attempt":       message(`"a/b"`, `"1"`, `null`),
		"nested repository":     message(`{"t":2,"d":[]}`, `"1"`, `"1"`),
		"truncated job message": "[x INFO Worker] Job message:\n {\"contextData\":{\"github\":{\"t\":2,\"d\":[\n",
	}
	for name, log := range cases {
		t.Run(name, func(t *testing.T) {
			if got, err := Parse(strings.NewReader(log)); err == nil {
				t.Fatalf("Parse = %+v, want an error", got)
			}
		})
	}
}

func fastWatcher(dir string) Watcher {
	return Watcher{Dir: dir, Poll: 5 * time.Millisecond, Timeout: 5 * time.Second, MaxBytes: 2 << 20}
}

func TestWatchFollowsAWorkerLogWrittenInTwoParts(t *testing.T) {
	dir := t.TempDir()
	log := readFixture(t)
	// Cut inside the github context, so the first read sees a job message
	// that is not complete yet.
	cut := strings.Index(log, `"k": "run_id",`+"\n          \"v\": \"42820231088\"")
	if cut < 0 {
		t.Fatal("fixture no longer has the top-level run_id")
	}
	path := filepath.Join(dir, "Worker_20261110-081402-utc.log")
	if err := os.WriteFile(path, []byte(log[:cut]), 0o644); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	var got Hint
	go func() {
		var err error
		got, err = fastWatcher(dir).Watch(t.Context())
		result <- err
	}()
	time.Sleep(50 * time.Millisecond)
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteString(log[cut:]); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	if err := <-result; err != nil {
		t.Fatalf("Watch: %v", err)
	}
	if got != fixtureHint {
		t.Fatalf("Watch = %+v, want %+v", got, fixtureHint)
	}
}

func TestWatchWaitsForTheFirstWorkerLogToAppear(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "Runner_20261110-081300-utc.log"), []byte("[x INFO Runner] Job message:\n {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	go func() {
		time.Sleep(30 * time.Millisecond)
		_ = os.WriteFile(filepath.Join(dir, "Worker_20261110-081402-utc.log"), []byte(readFixture(t)), 0o644)
	}()
	got, err := fastWatcher(dir).Watch(t.Context())
	if err != nil {
		t.Fatalf("Watch: %v", err)
	}
	if got != fixtureHint {
		t.Fatalf("Watch = %+v, want %+v", got, fixtureHint)
	}
}

func TestWatchGivesUpOnAJobMessageThatNeverCompletes(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "Worker_1.log"), []byte("[x INFO Worker] Job message:\n {\"contextData\": {"), 0o644); err != nil {
		t.Fatal(err)
	}
	watcher := fastWatcher(dir)
	watcher.Timeout = 50 * time.Millisecond
	if _, err := watcher.Watch(t.Context()); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Watch = %v, want a deadline error", err)
	}
}

func TestWatchGivesUpPastTheSizeBound(t *testing.T) {
	dir := t.TempDir()
	padding := strings.Repeat(" ", 4096)
	if err := os.WriteFile(filepath.Join(dir, "Worker_1.log"), []byte("[x INFO Worker] Job message:\n {\"a\":\""+padding), 0o644); err != nil {
		t.Fatal(err)
	}
	watcher := fastWatcher(dir)
	watcher.MaxBytes = 1024
	start := time.Now()
	if _, err := watcher.Watch(t.Context()); err == nil {
		t.Fatal("Watch read past its size bound")
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("Watch took %v to stop at the size bound, want it to stop without waiting", elapsed)
	}
}

func TestWatchStopsQuietlyWhenNoJobStarts(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Millisecond)
	defer cancel()
	if _, err := fastWatcher(t.TempDir()).Watch(ctx); !errors.Is(err, ErrNoJob) {
		t.Fatalf("Watch = %v, want ErrNoJob", err)
	}
}
