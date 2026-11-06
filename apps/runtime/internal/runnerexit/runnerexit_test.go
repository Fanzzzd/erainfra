package runnerexit

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"
)

// The tail of the diagnostic log a 2.336.0 runner left on 2026-11-05, in the
// runner's own format: an ERR line with the exception, its stack, then
// ordinary lines after it.
const deprecatedRunnerLog = `[2026-11-05 10:15:01Z INFO RunnerServer] Establish connection with 100 seconds timeout.
[2026-11-05 10:15:02Z INFO BrokerMessageListener] Creating session.
[2026-11-05 10:15:04Z ERR  BrokerMessageListener] GitHub.DistributedTask.WebApi.TaskAgentVersionNotSupportedException: Runner version v2.336.0 is deprecated and cannot receive messages.
   at GitHub.Runner.Listener.BrokerMessageListener.CreateSessionAsync(CancellationToken token)
[2026-11-05 10:15:04Z INFO Listener] Runner execution has finished with return code 1
`

func TestLastErrorTakesTheLastErrLineWithoutItsHeader(t *testing.T) {
	got := LastError([]byte(deprecatedRunnerLog))
	want := "GitHub.DistributedTask.WebApi.TaskAgentVersionNotSupportedException: Runner version v2.336.0 is deprecated and cannot receive messages."
	if got != want {
		t.Fatalf("LastError = %q, want %q", got, want)
	}
	if got := LastError([]byte("[2026-11-05 10:15:01Z INFO Runner] fine\nplain text ERR here\n")); got != "" {
		t.Fatalf("LastError of a log with no ERR line = %q, want empty", got)
	}
}

func TestSanitizeBoundsAndRedacts(t *testing.T) {
	token := "ghs_" + strings.Repeat("A1b2", 9)
	got := Sanitize("bad\x1b[31m\ttoken " + token + "\x00 end\u202e")
	if strings.Contains(got, token) || !strings.Contains(got, "[redacted]") {
		t.Fatalf("Sanitize kept the token: %q", got)
	}
	if strings.ContainsFunc(got, func(r rune) bool { return r < 0x20 || r == 0x7f || r == '\u202e' }) {
		t.Fatalf("Sanitize kept a control character: %q", got)
	}
	long := Sanitize(strings.Repeat("é ", MaxDiagnosticBytes))
	if len(long) > MaxDiagnosticBytes || !utf8.ValidString(long) || !strings.HasSuffix(long, "…") {
		t.Fatalf("Sanitize of a long line = %d bytes, valid %v: %q", len(long), utf8.ValidString(long), long)
	}
	if Sanitize(long) != long {
		t.Fatal("Sanitize is not idempotent, so Validate would refuse what Line wrote")
	}
}

func TestCollectReadsTheNewestRunnerLogAndWhetherAJobRan(t *testing.T) {
	diag := t.TempDir()
	write := func(name, content string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(diag, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("Runner_20261105-101400-utc.log", "[2026-11-05 10:14:00Z ERR  Runner] an older run\n")
	write("Runner_20261105-101500-utc.log", deprecatedRunnerLog)

	report := Collect(diag, 1)
	if report.ExitCode != 1 || report.RanJob || !strings.Contains(report.Diagnostic, "v2.336.0 is deprecated") {
		t.Fatalf("Collect = %+v", report)
	}

	write("Worker_20261105-101600-utc.log", "")
	if !Collect(diag, 0).RanJob {
		t.Fatal("a Worker log means the runner ran a job")
	}
	if report := Collect(filepath.Join(diag, "missing"), 0); report != (Report{}) {
		t.Fatalf("Collect of a missing folder = %+v, want the zero Report", report)
	}
}

func TestConsoleRoundTripTakesTheLastLine(t *testing.T) {
	first, err := Line(Report{ExitCode: 3, Diagnostic: "forged by the job"})
	if err != nil {
		t.Fatal(err)
	}
	last, err := Line(Report{ExitCode: 1, Diagnostic: "Runner version v2.336.0 is deprecated"})
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "console.log")
	console := "boot\n" + first + "job output\n" + last + "[  12.3] reboot: Restarting system\n"
	if err := os.WriteFile(path, []byte(console), 0o600); err != nil {
		t.Fatal(err)
	}
	report, err := ReadConsole(path)
	if err != nil {
		t.Fatal(err)
	}
	if report == nil || *report != (Report{ExitCode: 1, Diagnostic: "Runner version v2.336.0 is deprecated"}) {
		t.Fatalf("ReadConsole = %+v", report)
	}
}

// An older guest writes no line: the host reports nothing, as it did before.
func TestDecodeWithoutALineIsNoReport(t *testing.T) {
	report, err := Decode([]byte("boot\n\x1eRUNNER_CENTER_WARM_READY\nreboot\n"))
	if err != nil || report != nil {
		t.Fatalf("Decode = %+v, %v; want nil, nil", report, err)
	}
}

func TestDecodeRefusesWhatTheGuestMayNotWrite(t *testing.T) {
	encode := func(json string) string { return base64.StdEncoding.EncodeToString([]byte(json)) }
	for name, payload := range map[string]string{
		"not base64":        "!!!",
		"unknown field":     encode(`{"exitCode":1,"extra":true}`),
		"exit code too big": encode(`{"exitCode":256}`),
		"control character": encode(`{"exitCode":1,"diagnostic":"a\u001bb"}`),
		"over long":         strings.Repeat("A", maxEncodedBytes+4),
	} {
		if report, err := Decode([]byte(consoleMarker + payload + "\n")); err == nil {
			t.Errorf("%s: Decode accepted %+v", name, report)
		}
	}
}
